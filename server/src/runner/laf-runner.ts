/**
 * The runner that makes SSE mode remember.
 *
 * Upstream ships two runners: the Intelligence one, which stores every thread in
 * CopilotKit's cloud, and the in-memory one, which forgets on restart. This fork
 * removed the first (our only external dependencies are the model API and the
 * machines we run on), and the second is not a product. So this class is the
 * in-memory runner with its memory made durable: every run is teed into Postgres
 * as it streams, and a thread is read back on demand so `getThreadMessages` can
 * answer for conversations no process alive today has seen.
 *
 * ON DEMAND, not at boot. Construction used to `select *` from every thread and
 * hold the lot in a Map for the life of the process — the whole product's
 * history, in memory, before the first request. It reads one thread now, for the
 * request that asked for it, through `prime`.
 *
 * The tee is a second subscription, not a wrapped stream. `InMemoryAgentRunner`
 * multicasts each run through replay subjects, so subscribing here costs nothing
 * and — more important — cannot change what the endpoint's own subscriber sees.
 * Persistence must never be able to break a turn.
 *
 * What is persisted is deliberately small: the input messages when a run starts
 * (the user's side is safe even if the process dies mid-turn), the assistant text
 * rebuilt from TEXT_MESSAGE events when it ends, and a one-row run record written
 * by `run-ledger.ts`. The full event stream is not stored; the log of record for
 * actions is `audit_events`.
 */
import type { BaseEvent, Message } from "@ag-ui/client";
import {
  type AgentRunnerRunRequest,
  InMemoryAgentRunner,
  type InMemoryThread,
} from "@copilotkit/runtime/v2";
import { eq } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import { TURN_FAILURE_CODES } from "../channels/turn-failures";
import type { Database } from "../db/client";
import { channelThreads, lafThreadRuns } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import type { NotificationOutbox } from "../notifications/outbox";
import { type RunLedger, RUN_ORIGINS, type RunOrigin } from "./run-ledger";
import { redactSecretTyping } from "./secret-redaction";
import {
  appendMessages,
  isThreadOwnedBy,
  messagesFor,
  type StoredMessage,
  threadSummaries,
} from "./thread-store";

type PrimedThread = {
  record: InMemoryThread;
  messages: StoredMessage[];
};

/**
 * How many primed threads are kept.
 *
 * `getThreadMessages` is synchronous — CopilotKit's local thread endpoints are declared that way
 * and the handler maps the result straight into a `Response` — so a read that has to reach Postgres
 * cannot happen inside it. `prime` does the read for the request that is about to ask, and this Map
 * carries it the few microseconds between. It is a handoff, not a mirror: nothing else writes to it,
 * so nothing can leave it stale. The cap only stops a long-lived process from remembering every
 * thread it ever answered for, which is the thing boot-loading did on purpose.
 */
const MAX_PRIMED_THREADS = 32;

/**
 * The client's history, plus anything the store holds that the client never saw.
 *
 * Every run hands back the caller's copy of the thread as its input, and that copy is the truth
 * about what the caller said. It is not the truth about what else happened to the thread: a
 * routine can deliver an answer into it while no tab is open, and a tab that hydrated before that
 * delivery would otherwise be shown a history that never had it. Nothing in this product deletes
 * messages, so a stored message missing from the live copy is one the client did not know about,
 * not one it removed — and it is kept, at its place: right after the nearest stored neighbour the
 * client does know.
 */
export function mergeKeepingStoredOnly(
  stored: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  const incomingIds = new Set(incoming.map((message) => message.id));
  const result = [...incoming];
  let insertAfter = -1;
  for (const message of stored) {
    const at = result.findIndex((candidate) => candidate.id === message.id);
    if (at !== -1) {
      insertAfter = at;
      continue;
    }
    if (incomingIds.has(message.id)) continue;
    result.splice(insertAfter + 1, 0, message);
    insertAfter += 1;
  }
  return result;
}

/**
 * The usage the Bot's stream reported, shaped for the trail.
 *
 * Counts only, with non-numbers read as zero rather than trusted: the event crossed a service
 * boundary, and a ledger row that throws on a malformed count is a run that fails on metering.
 */
export function modelUsageOf(events: ReadonlyArray<BaseEvent>): Array<{
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Prompt tokens the provider served from its cache, only where the endpoint said so.
   *
   * Absent rather than zero otherwise: the monthly cost is a sum over these rows, and a row that
   * says "0 cached" for an endpoint that never reports the number would make a prompt that caches
   * perfectly indistinguishable from one that never does.
   */
  cachedPromptTokens?: number;
}> {
  const found: ReturnType<typeof modelUsageOf> = [];
  for (const raw of events) {
    const event = raw as BaseEvent & { name?: string; value?: unknown };
    if (String(event.type) !== "CUSTOM" || event.name !== "laf.model.usage")
      continue;
    const value = (event.value ?? {}) as Record<string, unknown>;
    const count = (key: string) =>
      typeof value[key] === "number" ? (value[key] as number) : 0;
    found.push({
      model: typeof value.model === "string" ? value.model : "unknown",
      promptTokens: count("promptTokens"),
      completionTokens: count("completionTokens"),
      totalTokens: count("totalTokens"),
      ...(typeof value.cachedPromptTokens === "number"
        ? { cachedPromptTokens: value.cachedPromptTokens }
        : {}),
    });
  }
  return found;
}

/**
 * The assistant's side of a finished run, rebuilt from its text-message events.
 *
 * Only TEXT_MESSAGE_* is read. Tool calls and their results are not reconstructed
 * here: AG-UI carries them back in the next run's input, and `appendMessages`
 * updates the row in place when that richer copy of the same message arrives, so
 * one turn's tool detail lands one run late rather than being guessed at now.
 */
function assistantMessagesFrom(
  events: BaseEvent[],
  /** When each assistant message STARTED streaming, captured live — see `run`. */
  startedAt: Map<string, string>,
  /** The Bot this run belongs to. Null for a run whose agent the request did not name. */
  agentId: string | null,
): StoredMessage[] {
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
        // Only the assistant's own words. A `user` message the events replay is the person's.
        ...(agentId && part.role === "assistant"
          ? { lafAgentId: agentId }
          : {}),
      } as StoredMessage,
    ];
  });
}

/**
 * What the ledger says a run came to, from the events it produced.
 *
 * The stream completing is not the run finishing. A person pressing Stop closes the stream with
 * no RUN_FINISHED in it; a Bot whose stream stalled carries a RUN_ERROR and then completes like
 * any other. Both were recorded as `done` — the roster cleared, which was right, and the record
 * said the Bot had finished, which was not. The events are the only honest witness, so the
 * status is read from them: `error` with the Bot's own reason, `stopped` for a run nothing ended,
 * `done` only for one the Bot itself closed.
 */
export function runOutcome(
  events: ReadonlyArray<BaseEvent>,
  failure: string | null,
): { status: "done" | "error" | "stopped"; error: string | null } {
  const errored = events.find((event) => String(event.type) === "RUN_ERROR");
  const reason =
    failure ??
    ((errored as (BaseEvent & { message?: string }) | undefined)?.message ||
      (errored ? "The Bot reported an error." : null));
  /*
   * A person's Stop reaches this as "The operation was aborted." — measured: the runtime turns
   * the browser's abort into a RUN_ERROR event carrying the transport's AbortError wording, and
   * a transport that drops first says the same. A Stop is not something that went wrong.
   */
  if (reason !== null && /abort/i.test(reason)) {
    return { status: "stopped", error: null };
  }
  if (reason !== null) return { status: "error", error: reason };
  const finished = events.some(
    (event) => String(event.type) === "RUN_FINISHED",
  );
  return finished
    ? { status: "done", error: null }
    : { status: "stopped", error: null };
}

/**
 * A run the last process left open, as boot found it.
 *
 * Everything the ledger row knew about who and what, so that the process that reconciled it can
 * tell somebody — the row itself says only `unknown`, and a person whose 07:30 briefing died with
 * the server would otherwise learn that from its absence.
 */
export type InterruptedRun = {
  runId: string;
  threadId: string | null;
  agentId: string | null;
  userId: string | null;
  origin: RunOrigin;
  /** A routine's name, for a run that was one. */
  label: string | null;
};

export class LafPostgresRunner extends InMemoryAgentRunner {
  /** Threads read for a request that is about to ask for them. See `MAX_PRIMED_THREADS`. */
  private readonly primed = new Map<string, PrimedThread>();
  /** The thread list, read for the one route that asks for it. Null until something does. */
  private listed: InMemoryThread[] | null = null;

  private constructor(
    private readonly database: Database,
    private readonly ledger: RunLedger,
    private readonly auditStore: AuditStore | null,
    /** What boot found still running. Read once by `reportInterruptedRuns`, never added to. */
    private readonly interrupted: readonly InterruptedRun[],
  ) {
    // `supersede` matches the hosted posture upstream documents for its own
    // listener: a fast follow-up turn replaces a wedged one instead of erroring.
    super({ onConcurrentRun: "supersede" });
  }

  /** Async because boot adjudicates the runs the last process left open. It reads no messages. */
  static async create(
    database: Database,
    ledger: RunLedger,
    auditStore: AuditStore | null = null,
  ): Promise<LafPostgresRunner> {
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
      .returning({
        runId: lafThreadRuns.runId,
        threadId: lafThreadRuns.threadId,
        agentId: lafThreadRuns.agentId,
        userId: lafThreadRuns.userId,
        origin: lafThreadRuns.origin,
        label: lafThreadRuns.label,
      });
    if (reconciled.length > 0) {
      log.warn("runs_reconciled", {
        count: reconciled.length,
        to: "unknown",
        note: "These runs were still `running` when the last process died; nothing is known about how they ended.",
      });
    }
    return new LafPostgresRunner(database, ledger, auditStore, reconciled);
  }

  /**
   * The runs boot found open, for whoever can tell somebody about them.
   *
   * A getter rather than a notification from inside `create`, because the outbox does not exist
   * yet when the runner is built — it is made after the sockets and the partner doors it delivers
   * through — and reordering boot around a notification would put the tail before the dog.
   */
  interruptedAtBoot(): readonly InterruptedRun[] {
    return this.interrupted;
  }

  /**
   * Read one thread out of Postgres, for the request about to ask for it — IF IT IS THEIRS.
   *
   * Called by the middleware in front of CopilotKit's thread routes (`index.ts`), because those
   * routes reach this class through synchronous methods and the read is not synchronous.
   *
   * It answers whether the caller may see the thread at all, and the middleware refuses the request
   * on `false`. Leaving nothing primed is not enough on its own: `getThreadMessages` also reads the
   * vendored runner's LIVE copy, which is a process-wide singleton, so a thread somebody else ran in
   * this process since boot would still have been answered from memory with nothing primed at all.
   *
   * Never throws. A read that fails refuses rather than falling through to the live copy: this is
   * the same call that decides whose thread it is, and a database blip must not become an answer.
   */
  async prime(threadId: string, userId: string): Promise<boolean> {
    try {
      if (!(await isThreadOwnedBy(this.database, threadId, userId))) {
        // Anything a previous request left here for this thread goes too — the map is shared by
        // every caller, and a refusal that left the last person's copy in place would be the leak
        // arriving one request late.
        this.primed.delete(threadId);
        return false;
      }
      const messages = await messagesFor(this.database, threadId);
      const at = new Date().toISOString();
      const existing = this.primed.get(threadId);
      this.primed.delete(threadId);
      if (this.primed.size >= MAX_PRIMED_THREADS) {
        const oldest = this.primed.keys().next();
        if (!oldest.done) this.primed.delete(oldest.value);
      }
      this.primed.set(threadId, {
        messages,
        record: existing?.record ?? {
          id: threadId,
          name: null,
          agentId: "",
          organizationId: "",
          createdById: "",
          archived: false,
          createdAt: at,
          updatedAt: at,
        },
      });
      return true;
    } catch (error) {
      this.primed.delete(threadId);
      /*
       * `describeFailure`, not the error — here and at the other two sinks in this file.
       *
       * Every one of these three catches a Drizzle failure, and Drizzle puts the SQL AND its bound
       * parameters into `message`. The parameters of this file's statements are conversations: a
       * failed append carried the whole message array into the operator log. See failure-text.ts.
       */
      log.error("thread_read_failed", { reason: describeFailure(error) });
      return false;
    }
  }

  /**
   * The same for one person's thread list, which is a summary read and touches no message body.
   *
   * Always overwrites, failure included. `listed` is one field on one object shared by every
   * request, so a read that failed and left the previous caller's list standing would hand it to
   * this one.
   */
  async primeThreadList(userId: string): Promise<void> {
    try {
      this.listed = (await threadSummaries(this.database, userId)).map(
        (summary) => ({
          id: summary.threadId,
          name: null,
          agentId: summary.agentId ?? "",
          organizationId: "" as const,
          createdById: "" as const,
          archived: false as const,
          createdAt: summary.createdAt.toISOString(),
          updatedAt: summary.updatedAt.toISOString(),
        }),
      );
    } catch (error) {
      this.listed = [];
      log.error("thread_list_failed", { reason: describeFailure(error) });
    }
  }

  override run(request: AgentRunnerRunRequest) {
    const agentId = request.agent.agentId ?? null;
    const inputMessages = [...(request.input.messages ?? [])] as Message[];
    const forwarded = (request.input.forwardedProps ?? {}) as Record<
      string,
      unknown
    >;
    /*
     * The origin is checked against the list, not accepted. It reaches this from `forwardedProps`,
     * the one field AG-UI does not strip, so it is a value a client can choose — and `origin` is a
     * pg enum now: a made-up one would fail the ledger insert and lose the run's record entirely.
     */
    const origin: RunOrigin = RUN_ORIGINS.includes(
      forwarded.lafOrigin as RunOrigin,
    )
      ? (forwarded.lafOrigin as RunOrigin)
      : "chat";
    const dedupeKey =
      typeof forwarded.lafDedupeKey === "string" &&
      forwarded.lafDedupeKey.length > 0
        ? forwarded.lafDedupeKey
        : null;
    const requestedRunId =
      typeof request.input.runId === "string" && request.input.runId
        ? request.input.runId
        : null;
    const opened = this.beginRun(
      requestedRunId,
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
          opened,
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
          opened,
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

  /**
   * The threads the last `primeThreadList` said belong to the person asking, and nothing else.
   *
   * `super.listThreads()` is the vendored runner's PROCESS-WIDE store — every thread anybody has run
   * on this VM since boot — so it was contributing other people's threads to this list on its own,
   * whatever the stored half was scoped to. It is kept only for the ones the stored half already
   * admits, because a live record carries a turn that is still in flight and the stored one does not.
   *
   * The handoff is per request and this field is not, so two people asking in the same instant can
   * in principle read each other's prime. One process per VM by decision
   * (docs/laf/deployment-model.md) and a synchronous vendored method leave no seam to pass an actor
   * through; the window is the microseconds between the middleware and the handler, and the thread
   * read below is keyed by thread id and therefore not exposed to it.
   */
  override listThreads(): InMemoryThread[] {
    const mine = this.listed ?? [];
    const allowed = new Set(mine.map((record) => record.id));
    const live = super.listThreads().filter((thread) => allowed.has(thread.id));
    const liveIds = new Set(live.map((thread) => thread.id));
    return [...live, ...mine.filter((record) => !liveIds.has(record.id))];
  }

  override getThreadMessages(threadId: string): Message[] {
    const live = super.getThreadMessages(threadId);
    const stored = this.primed.get(threadId)?.messages ?? [];
    if (live.length === 0) return redactSecretTyping(stored, stored);
    /*
     * BOTH, WITH THE LIVE COPY'S ORDER. The live copy belongs to the vendored runner and only ever
     * grows through a run; something else can add to a conversation without running it — a routine
     * delivering its answer into the Bot's own chat is the case that exists today — and that lands
     * in Postgres, where the live copy cannot see it. Preferring live outright meant the roster
     * showed the answer and the transcript did not; preferring the store outright loses the tool
     * calls of a turn that is still in flight.
     *
     * AND THE REDACTION AGAIN, ON THE WAY OUT. Measured, not assumed: the vendored runner's thread
     * store is a PROCESS-WIDE SINGLETON ("Process-wide singleton backing every InMemoryAgentRunner"
     * — @copilotkit/runtime, runner/in-memory.cjs), so the live copy of a turn survives this class
     * being constructed again and is the copy the merge prefers for any message id both hold. A
     * credential taken out of the row on the way in therefore came straight back out of memory on
     * every read of this route until the process restarted, which is not a redaction — it is a
     * redaction-shaped thing that the product's own read path walked around. Same pure rule as the
     * write, with the stored copy as what it already decided.
     */
    return redactSecretTyping(mergeKeepingStoredOnly(stored, live), stored);
  }

  /** The user's side, written the moment a run starts: a crash mid-turn keeps it. */
  private async beginRun(
    requestedRunId: string | null,
    threadId: string,
    agentId: string | null,
    messages: Message[],
    origin: RunOrigin,
    dedupeKey: string | null,
  ): Promise<string | null> {
    try {
      /*
       * WHOSE RUN IT IS, LOOKED UP RATHER THAN ACCEPTED.
       *
       * The roster asks "what is running for me", so a run needs an owner. The obvious route is
       * `forwardedProps` — it is the one field AG-UI does not strip — and it is the wrong one: a
       * client that can name the owner of a run can light up somebody else's roster, or hide its
       * own work in theirs. The thread already knows. `channel_threads` is unique on `thread_id`,
       * so this is one indexed read of a fact the server itself wrote.
       */
      const [owner] = await this.database
        .select({ userId: channelThreads.userId })
        .from(channelThreads)
        .where(eq(channelThreads.threadId, threadId))
        .limit(1);

      // One writer for this table, and it is not this class. See runner/run-ledger.ts.
      const runId = await this.ledger.begin({
        ...(requestedRunId ? { runId: requestedRunId } : {}),
        threadId,
        agentId,
        userId: owner?.userId ?? null,
        origin,
        dedupeKey,
      });
      await appendMessages(this.database, threadId, messages, { runId });
      return runId;
    } catch (error) {
      log.error("run_start_not_persisted", {
        thread: threadId,
        reason: describeFailure(error),
      });
      return null;
    }
  }

  private async finishRun(
    opened: Promise<string | null>,
    threadId: string,
    agentId: string | null,
    inputMessages: Message[],
    events: BaseEvent[],
    startedAt: Map<string, string>,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      const runId = await opened;
      const messages = [
        ...inputMessages,
        ...assistantMessagesFrom(events, startedAt, agentId),
      ];
      await appendMessages(this.database, threadId, messages, { runId });
      if (runId) {
        const outcome = runOutcome(events, errorMessage);
        await this.ledger.settle(runId, {
          ...outcome,
          eventCount: events.length,
        });
        await this.recordUsage(runId, threadId, agentId, events);
      }
    } catch (error) {
      log.error("run_end_not_persisted", {
        thread: threadId,
        reason: describeFailure(error),
      });
    }
  }

  /**
   * The turn's token counts, out of the stream and into the trail.
   *
   * The Bot service reports what a turn cost as a CUSTOM `laf.model.usage` event — the only
   * channel it has, since it holds no server URL and no database on purpose — and this tee is the
   * one place every run's events already pass through, whatever surface started the run: chat,
   * rooms and routines alike. The per-Bot monthly cost KPI is a sum over these rows.
   */
  private async recordUsage(
    runId: string,
    threadId: string,
    agentId: string | null,
    events: BaseEvent[],
  ): Promise<void> {
    if (!this.auditStore) return;
    for (const usage of modelUsageOf(events)) {
      await recordAuditEvent(this.auditStore, {
        eventType: "model.usage",
        targetType: "agent",
        targetId: agentId ?? undefined,
        payload: {
          runId,
          threadId,
          ...(agentId ? { botId: agentId } : {}),
          ...usage,
          source: "bot-turn",
        },
      }).catch(() => undefined);
    }
  }
}

/**
 * Tell the people whose runs the last process died on.
 *
 * Reconciling a run to `unknown` used to be the whole of it: a line in the boot log, read by an
 * operator, and nothing for the person whose question or whose 07:30 briefing it was. They found
 * out from the absence — an answer that never came, a morning with no report — which is the one
 * thing a restart must not do (launch plan 3-B: 재시작·끊김이 거짓말하지 않는다).
 *
 * One `run.failed` row per interrupted run that had a Bot and a person, carrying the same fact code
 * the transcript uses (`laf:turn_interrupted`) and, for a routine, its name. A routine's run is
 * first marked in the Bot's conversation through `markRoutine` — the same mark its own failure
 * path leaves (routines/deliver.ts) — so the person finds the red line where the briefing would
 * have been, and the notification points at that conversation. A chat turn already has the
 * person's own message in its thread; only the conversation's id is looked up for it.
 *
 * Called once, after the outbox exists, by whoever boots the process. Nothing here can throw into
 * boot: a mark or a row that fails is logged and the next run is still told about.
 */
export async function reportInterruptedRuns(input: {
  database: Database;
  runs: readonly InterruptedRun[];
  outbox: NotificationOutbox;
  /** Marks a routine's run as unfinished in the Bot's conversation. See routines/deliver.ts. */
  markRoutine?: (run: {
    agentId: string;
    userId: string;
    routineName: string;
    runId: string;
    at: Date;
  }) => Promise<{ channelId: string } | null>;
  now?: () => Date;
}): Promise<number> {
  const now = input.now ?? (() => new Date());
  let told = 0;
  for (const run of input.runs) {
    // A run with nobody to tell, or no Bot to name, is still reconciled; it is just not news.
    if (!run.agentId || !run.userId) continue;
    let channelId: string | undefined;
    if (run.origin === "routine" && run.label && input.markRoutine) {
      try {
        const marked = await input.markRoutine({
          agentId: run.agentId,
          userId: run.userId,
          routineName: run.label,
          runId: run.runId,
          at: now(),
        });
        channelId = marked?.channelId;
      } catch (error) {
        log.error("interrupted_routine_not_marked", {
          run: run.runId,
          reason: describeFailure(error),
        });
      }
    }
    if (!channelId && run.threadId) {
      try {
        const [owner] = await input.database
          .select({ channelId: channelThreads.channelId })
          .from(channelThreads)
          .where(eq(channelThreads.threadId, run.threadId))
          .limit(1);
        channelId = owner?.channelId;
      } catch (error) {
        log.error("interrupted_conversation_not_read", {
          run: run.runId,
          thread: run.threadId,
          reason: describeFailure(error),
        });
      }
    }
    const record = await input.outbox.enqueue({
      kind: "run.failed",
      botId: run.agentId,
      userId: run.userId,
      ...(channelId ? { channelId } : {}),
      run: {
        origin: run.origin,
        ...(run.label ? { label: run.label } : {}),
        code: TURN_FAILURE_CODES.interrupted,
      },
    });
    if (record) told += 1;
  }
  if (told > 0) {
    log.info("interrupted_runs_reported", { count: told, as: "run.failed" });
  }
  return told;
}
