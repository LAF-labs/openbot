/**
 * The runner that makes SSE mode remember.
 *
 * Upstream ships two runners: the Intelligence one, which stores every thread in
 * CopilotKit's cloud, and the in-memory one, which forgets on restart. This fork
 * removed the first (our only external dependencies are the model API and the
 * machines we run on), and the second is not a product. So this class is the
 * in-memory runner with its memory made durable: every run is teed into Postgres
 * as it streams, and on boot the store is read back so `getThreadMessages` can
 * answer for conversations no process alive today has seen.
 *
 * The tee is a second subscription, not a wrapped stream. `InMemoryAgentRunner`
 * multicasts each run through replay subjects, so subscribing here costs nothing
 * and — more important — cannot change what the endpoint's own subscriber sees.
 * Persistence must never be able to break a turn.
 *
 * What is persisted is deliberately small: the input messages when a run starts
 * (the user's side is safe even if the process dies mid-turn), the assistant text
 * rebuilt from TEXT_MESSAGE events when it ends, and a one-row run record. The
 * full event stream is not stored; the log of record for actions is
 * `audit_events`.
 */
import { randomUUID } from "node:crypto";
import type { BaseEvent, Message } from "@ag-ui/client";
import {
  type AgentRunnerRunRequest,
  InMemoryAgentRunner,
  type InMemoryThread,
} from "@copilotkit/runtime/v2";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafThreadRuns, lafThreadSnapshots } from "../db/schema";

type SnapshotRow = typeof lafThreadSnapshots.$inferSelect;

type RestoredThread = {
  record: InMemoryThread;
  messages: Message[];
};

/** Reads heal the double-encoded rows written before saveSnapshot cast to jsonb. */
function parseMessages(stored: unknown): Message[] {
  if (Array.isArray(stored)) {
    return stored as Message[];
  }
  if (typeof stored === "string") {
    try {
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? (parsed as Message[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function recordFromRow(row: SnapshotRow): InMemoryThread {
  return {
    id: row.threadId,
    name: null,
    agentId: row.agentId ?? "",
    organizationId: "",
    createdById: "",
    archived: false,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The assistant's side of a finished run, rebuilt from its text-message events.
 *
 * Only TEXT_MESSAGE_* is read. Tool calls and their results are not reconstructed
 * here: AG-UI carries them back in the next run's input, so the snapshot written
 * then will contain them, and a reconstruction that guessed wrong would be worse
 * than one turn's tool detail arriving one run late.
 */
function assistantMessagesFrom(events: BaseEvent[]): Message[] {
  const order: string[] = [];
  const parts = new Map<string, { role: string; content: string }>();
  for (const raw of events) {
    const event = raw as BaseEvent & {
      messageId?: string;
      delta?: string;
      role?: string;
    };
    const type = String(event.type);
    if (type === "TEXT_MESSAGE_START" && event.messageId) {
      parts.set(event.messageId, {
        role: event.role ?? "assistant",
        content: "",
      });
      order.push(event.messageId);
    } else if (type === "TEXT_MESSAGE_CONTENT" && event.messageId) {
      const part = parts.get(event.messageId);
      if (part && typeof event.delta === "string") {
        part.content += event.delta;
      }
    }
  }
  return order.flatMap((id) => {
    const part = parts.get(id);
    if (!part || part.content.length === 0) {
      return [];
    }
    return [{ id, role: part.role, content: part.content } as Message];
  });
}

export class LafPostgresRunner extends InMemoryAgentRunner {
  private constructor(
    private readonly database: Database,
    private readonly restored: Map<string, RestoredThread>,
  ) {
    // `supersede` matches the hosted posture upstream documents for its own
    // listener: a fast follow-up turn replaces a wedged one instead of erroring.
    super({ onConcurrentRun: "supersede" });
  }

  /** Async because construction is a read: boot rehydrates every snapshot. */
  static async create(database: Database): Promise<LafPostgresRunner> {
    /*
     * Boot reconciliation: a run still `running` now cannot still be running,
     * because the process that ran it is the one that just died. Marked
     * `unknown` rather than `error` — nothing is known about how it ended,
     * and the digest names these as what they are: crash suspects.
     */
    const reconciled = await database
      .update(lafThreadRuns)
      .set({ status: "unknown", finishedAt: new Date() })
      .where(eq(lafThreadRuns.status, "running"))
      .returning({ runId: lafThreadRuns.runId });
    if (reconciled.length > 0) {
      console.info(
        `[laf-runner] ${reconciled.length} run(s) had no ending; reconciled to unknown`,
      );
    }
    const rows = await database.select().from(lafThreadSnapshots);
    const restored = new Map<string, RestoredThread>(
      rows.map((row) => [
        row.threadId,
        {
          record: recordFromRow(row),
          messages: parseMessages(row.messages),
        },
      ]),
    );
    return new LafPostgresRunner(database, restored);
  }

  override run(request: AgentRunnerRunRequest) {
    const runId =
      typeof request.input.runId === "string" && request.input.runId
        ? request.input.runId
        : randomUUID();
    const agentId = request.agent.agentId ?? null;
    const inputMessages = [...(request.input.messages ?? [])] as Message[];
    const forwarded = (request.input.forwardedProps ?? {}) as Record<
      string,
      unknown
    >;
    const origin =
      typeof forwarded.lafOrigin === "string" ? forwarded.lafOrigin : "chat";
    const dedupeKey =
      typeof forwarded.lafDedupeKey === "string" &&
      forwarded.lafDedupeKey.length > 0
        ? forwarded.lafDedupeKey
        : null;
    void this.beginRun(
      runId,
      request.threadId,
      agentId,
      inputMessages,
      origin,
      dedupeKey,
    );
    const events = super.run(request);
    const collected: BaseEvent[] = [];
    events.subscribe({
      next: (event) => {
        collected.push(event);
      },
      error: (error: unknown) => {
        void this.finishRun(
          runId,
          request.threadId,
          agentId,
          inputMessages,
          collected,
          error instanceof Error ? error.message : String(error),
        );
      },
      complete: () => {
        void this.finishRun(
          runId,
          request.threadId,
          agentId,
          inputMessages,
          collected,
          null,
        );
      },
    });
    return events;
  }

  override listThreads(): InMemoryThread[] {
    const live = super.listThreads();
    const liveIds = new Set(live.map((thread) => thread.id));
    const rest = [...this.restored.values()]
      .map((thread) => thread.record)
      .filter((record) => !liveIds.has(record.id));
    return [...live, ...rest];
  }

  override getThreadMessages(threadId: string): Message[] {
    const live = super.getThreadMessages(threadId);
    if (live.length > 0) {
      return live;
    }
    return this.restored.get(threadId)?.messages ?? [];
  }

  /** The user's side, written the moment a run starts: a crash mid-turn keeps it. */
  private async beginRun(
    runId: string,
    threadId: string,
    agentId: string | null,
    messages: Message[],
    origin = "chat",
    dedupeKey: string | null = null,
  ): Promise<void> {
    try {
      await this.database.insert(lafThreadRuns).values({
        runId,
        threadId,
        agentId,
        status: "running",
        origin,
        dedupeKey,
      });
      await this.saveSnapshot(threadId, agentId, messages);
    } catch (error) {
      console.error("[laf-runner] persisting run start failed:", error);
    }
  }

  private async finishRun(
    runId: string,
    threadId: string,
    agentId: string | null,
    inputMessages: Message[],
    events: BaseEvent[],
    errorMessage: string | null,
  ): Promise<void> {
    try {
      const messages = [...inputMessages, ...assistantMessagesFrom(events)];
      await this.saveSnapshot(threadId, agentId, messages);
      await this.database
        .update(lafThreadRuns)
        .set({
          status: errorMessage === null ? "done" : "error",
          error: errorMessage,
          eventCount: events.length,
          finishedAt: new Date(),
        })
        .where(eq(lafThreadRuns.runId, runId));
    } catch (error) {
      console.error("[laf-runner] persisting run end failed:", error);
    }
  }

  private async saveSnapshot(
    threadId: string,
    agentId: string | null,
    messages: Message[],
  ): Promise<void> {
    const updatedAt = new Date();
    // `::text::jsonb`, measured, not guessed. A top-level JS array must not reach
    // the driver as itself (postgres-js reads it as a Postgres array) nor as a
    // parameter cast straight to jsonb (the jsonb serializer stringifies the
    // already-stringified value — a jsonb *string*, opaque to every SQL-side
    // consumer). Typing the parameter as text first is the one form of the three
    // that lands as a real jsonb array; see laf_thread_runs in the M0 notes.
    const messagesJson = sql`${JSON.stringify(messages)}::text::jsonb`;
    await this.database
      .insert(lafThreadSnapshots)
      .values({ threadId, agentId, messages: messagesJson, updatedAt })
      .onConflictDoUpdate({
        target: lafThreadSnapshots.threadId,
        set: { agentId, messages: messagesJson, updatedAt },
      });
    const existing = this.restored.get(threadId);
    this.restored.set(threadId, {
      messages,
      record: existing
        ? { ...existing.record, updatedAt: updatedAt.toISOString() }
        : {
            id: threadId,
            name: null,
            agentId: agentId ?? "",
            organizationId: "",
            createdById: "",
            archived: false,
            createdAt: updatedAt.toISOString(),
            updatedAt: updatedAt.toISOString(),
          },
    });
  }
}
