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
import {
  intelligenceChannelMappings,
  lafThreadRuns,
  lafThreadSnapshots,
} from "../db/schema";

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

/**
 * A message as we store it: AG-UI's shape plus the moment we first saw it.
 *
 * `lafAt` is ours, and it survives only because `messages` is jsonb and the read path casts rather
 * than validates. It cannot ride AG-UI's own message type — every message schema is zod `strip`,
 * so a key the client attaches is deleted before a run ever reaches this class. Stamping here, on
 * the server, is also the only way the two sides of a conversation share one clock.
 */
type StampedMessage = Message & { lafAt?: string };

/**
 * Merge stamps onto a message list, FIRST SEEN WINS.
 *
 * Each run's input carries the whole history back, unstamped, so re-stamping on every save would
 * march every message in a conversation forward to the time of its most recent turn. The stamps
 * already on the previous snapshot are the record; `fallback` is only for messages that have none.
 */
export function stamp(
  messages: Message[],
  known: Map<string, string>,
  /**
   * Every id this thread already held, stamped or not.
   *
   * The distinction matters exactly once per thread: the first save after stamping shipped. Those
   * messages are known to the snapshot and carry no time, because nobody was recording one when
   * they were said — and `fallback` would then declare that the whole back history happened at the
   * instant of the next reply. A conversation with no separators is a conversation whose timing we
   * do not know; one with wrong separators is a record that lies.
   */
  seen: Set<string>,
  fallback: string,
): StampedMessage[] {
  return messages.map((message) => {
    const existing = (message as StampedMessage).lafAt ?? known.get(message.id);
    if (existing) return { ...message, lafAt: existing };
    if (seen.has(message.id)) return { ...message };
    return { ...message, lafAt: fallback };
  });
}

/** The stamps a snapshot already carries, so a save can preserve them. */
export function stampsOf(messages: Message[]): Map<string, string> {
  const times = new Map<string, string>();
  for (const message of messages) {
    const at = (message as StampedMessage).lafAt;
    if (typeof at === "string") times.set(message.id, at);
  }
  return times;
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
function assistantMessagesFrom(
  events: BaseEvent[],
  /** When each assistant message STARTED streaming, captured live — see `run`. */
  startedAt: Map<string, string>,
): StampedMessage[] {
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
    const at = startedAt.get(id);
    return [
      {
        id,
        role: part.role,
        content: part.content,
        ...(at === undefined ? {} : { lafAt: at }),
      } as StampedMessage,
    ];
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
    /*
     * The clock reading for each assistant message, taken as it starts streaming.
     *
     * This subscriber is live — it fires per event, not once at completion — so TEXT_MESSAGE_START
     * is the moment the Bot began saying this particular thing. Taking the time at `finishRun`
     * instead would stamp every message of a long turn with the instant the last one ended, which
     * is a lie the transcript would then draw a separator from.
     */
    const startedAt = new Map<string, string>();
    events.subscribe({
      next: (event) => {
        collected.push(event);
        const started = event as BaseEvent & { messageId?: string };
        if (
          String(event.type) === "TEXT_MESSAGE_START" &&
          started.messageId &&
          !startedAt.has(started.messageId)
        ) {
          startedAt.set(started.messageId, new Date().toISOString());
        }
      },
      error: (error: unknown) => {
        void this.finishRun(
          runId,
          request.threadId,
          agentId,
          inputMessages,
          collected,
          startedAt,
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
          startedAt,
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
      /*
       * WHOSE RUN IT IS, LOOKED UP RATHER THAN ACCEPTED.
       *
       * The roster asks "what is running for me", so a run needs an owner. The obvious route is
       * `forwardedProps` — it is the one field AG-UI does not strip — and it is the wrong one: a
       * client that can name the owner of a run can light up somebody else's roster, or hide its
       * own work in theirs. The thread already knows. `intelligence_channel_mappings` is unique on
       * `thread_id`, so this is one indexed read of a fact the server itself wrote.
       */
      const [owner] = await this.database
        .select({ userId: intelligenceChannelMappings.userId })
        .from(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.threadId, threadId))
        .limit(1);

      await this.database.insert(lafThreadRuns).values({
        runId,
        threadId,
        agentId,
        // The same ledger the routine service writes — see runner/run-ledger.ts.
        userId: owner?.userId ?? null,
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
    startedAt: Map<string, string>,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      const messages = [
        ...inputMessages,
        ...assistantMessagesFrom(events, startedAt),
      ];
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
    incoming: Message[],
  ): Promise<void> {
    const updatedAt = new Date();
    /*
     * Stamps are merged against what this thread already holds, not recomputed.
     *
     * Every run hands back the entire history as its input, and that copy has been through AG-UI's
     * `strip` on the way in, so it arrives bare. Without the merge, saving turn ten would set turn
     * one's time to now — the conversation would claim to have happened all at once, every time.
     */
    const previous = this.restored.get(threadId)?.messages ?? [];
    const messages = stamp(
      incoming,
      stampsOf(previous),
      new Set(previous.map((message) => message.id)),
      updatedAt.toISOString(),
    );
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
