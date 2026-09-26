/**
 * The server owns the turn.
 *
 * A chat turn used to be driven from the person's window: CopilotKit ran the Bot, the page carried
 * out every tool call and started the next run, so closing the laptop ended the task mid-step, and
 * a second window could only replay what the first one had done (G1 in
 * `~/laf/docs/muse-2.2-architecture-teardown.md`). This runs the turn here instead, on the loop and
 * the Bot lane routines already run on (`runner/turn-loop.ts`, `runner/bot-lane.ts`): a window hands
 * over what the person said, and then only watches (`hub.ts`). Close it and the Bot keeps working;
 * open another and it catches up from its cursor.
 *
 * DURABLE WHERE IT HAS TO BE. What the person said is written to the thread the moment it arrives,
 * and the turn's ledger row is opened with it, before the lane — so a turn waiting behind a routine
 * when the process dies is found at boot and ended honestly (`reportInterruptedRuns`), like any
 * other. Each step's messages are written as the step ends, not at the end of the turn: a crash
 * three steps in keeps the three steps. The queue itself and the live frames are in memory, by the
 * deployment's decision — one process per VM, and a turn that outlives it is ended, not resumed.
 */
import { randomUUID } from "node:crypto";
import type { BaseEvent, Message, Tool } from "@ag-ui/client";
import { jsonObjectOf } from "../../../shared/json-object";
import { streamCutResult } from "../../../shared/stream-cut";
import { UNANSWERED_RESULT } from "../../../shared/task-ending";
import type { AgentActor } from "../agents/profile-types";
import {
  classifyTurnFailure,
  TURN_FAILURE_CODES,
} from "../channels/turn-failures";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import type { BotLane, LaneHold } from "../runner/bot-lane";
import type { WorkInFlight } from "../runner/in-flight";
import { chatLabelOf, type RunLedger } from "../runner/run-ledger";
import {
  appendMessages,
  type Executor,
  messagesFor,
  type StoredMessage,
} from "../runner/thread-store";
import {
  type LoopAgent,
  outcomeContent,
  RunDeadline,
  RunFailed,
  RunStopped,
  runTurnLoop,
} from "../runner/turn-loop";
import type { WorkingRun } from "../runner/working";
import { createRunMeter } from "../telemetry/run-meter";
import type { ChatToolkit, ChatTurnContext } from "./chat-tools";
import type { TurnHub, TurnState, TurnStatus } from "./hub";

/** How many times one turn may come back asking for tools: CopilotKit's own follow-up bound. */
export const CHAT_MAX_STEPS = 100;

/**
 * The whole turn. A browsing task legitimately runs for many minutes and may wait ten on each
 * question it raises; this bounds a turn that cannot end, not one that works for a long time.
 */
export const CHAT_TURN_TIMEOUT_MS = 90 * 60_000;

/** The result a call gets when the person stopped the turn while it was out: `laf:stopped`. */
const STOPPED_RESULT = { ok: false, code: "laf:stopped", stopped: true };

/** A turn that ran out of its whole time: the same fact a routine's deadline is. */
export const RUN_TIMED_OUT = "laf:run_timed_out";

/** A fact, whole: what the ledger's `error` column and the window's failure line may carry. */
const WHOLE_FACT = /^laf:[a-z0-9_]{1,60}$/;

/** Why a send was not taken. */
export type SendRefusal =
  | "laf:turn_in_progress"
  | "laf:turn_message_invalid"
  | "laf:not_admitted";

export type SendInput = {
  threadId: string;
  channelId: string;
  owner: AgentActor;
  botId: string;
  /** The skill instructions first, then what the person said — the last is always theirs. */
  messages: Message[];
  /** The tools the window offered, or null to let the server offer what it can describe. */
  tools: readonly Tool[] | null;
  /** The device's clock and language, as the window's CopilotKit properties carried them. */
  device?: unknown;
};

export type TurnEngineOptions = {
  database: Executor;
  ledger: RunLedger;
  hub: TurnHub;
  /** The one queue per Bot every server-side path shares. */
  lane?: BotLane;
  work?: WorkInFlight;
  /** The same agents every run path resolves, as the conversation's owner. */
  resolveAgents: (
    actor: AgentActor,
  ) => Promise<Record<string, TurnAgent | undefined>>;
  /** The turn's tools, carried out here (`chat-tools.ts`). */
  tools: (
    context: ChatTurnContext,
    declared: readonly Tool[] | null,
  ) => Promise<ChatToolkit>;
  /** Whether the person may still act here; an account the list no longer admits acts on nothing. */
  admits?: (userId: string) => Promise<boolean>;
  /** The Bot answered: the roster row, every open tab, and a notice for a person with none. */
  announce?: (input: {
    owner: AgentActor;
    channelId: string;
    agentId: string | null;
    text: string;
  }) => Promise<void>;
  maxSteps?: number;
  timeoutMs?: number;
};

/** The Bot as a turn drives it: the loop's slice, and the conversation it answers in. */
type TurnAgent = LoopAgent & { threadId?: string };

type LiveTurn = {
  id: string;
  threadId: string;
  ownerId: string;
  botId: string;
  /** What the person asked, as 오늘 names the turn. */
  label: string | null;
  startedAt: Date;
  status: TurnStatus;
  asked: string[];
  stop: AbortController;
  /** Free the conversation for its next turn and take the turn off the stoppable list. Twice is harmless. */
  free: () => void;
  /** Settles once the turn has written its end. */
  ended: Promise<void>;
};

/** A message as the Bot is handed it: AG-UI's fields, none of the store's own. */
function forTheBot(message: Message): Message {
  const {
    lafAt: _at,
    lafAgentId: _by,
    lafRedacted: _redacted,
    ...rest
  } = message as StoredMessage;
  return rest as Message;
}

/**
 * The thread with every call that never got an answer answered, where it was made — a provider
 * rejects a conversation holding one, and an old call must never be carried out now. The same
 * repair the window made before every run (`repair-history.ts` in the app).
 */
export function repairUnanswered(messages: readonly Message[]): Message[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      answered.add((message as { toolCallId: string }).toolCallId);
    }
  }
  const repaired: Message[] = [];
  for (const message of messages) {
    repaired.push(message);
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (answered.has(call.id)) continue;
      repaired.push({
        id: randomUUID(),
        role: "tool",
        toolCallId: call.id,
        // Half a call — a process that died while it streamed — is the cut, as at a turn's end.
        content: arrivedWhole(call.function.arguments)
          ? UNANSWERED_RESULT
          : streamCutResult(),
      } as Message);
      answered.add(call.id);
    }
  }
  return repaired;
}

/**
 * Whether a call's arguments arrived whole: an object, or nothing at all — which is what a provider
 * sends for a call that takes none, and so cannot be told from a cut right after the name.
 */
function arrivedWhole(raw: string | undefined): boolean {
  const text = (raw ?? "").trim();
  return text === "" || jsonObjectOf(text) !== null;
}

/** A message the window may hand over: the person's words, or a skill's instruction before them. */
function acceptable(messages: readonly Message[]): boolean {
  if (messages.length === 0 || messages.length > 24) return false;
  if (messages.at(-1)?.role !== "user") return false;
  return messages.every(
    (message) =>
      typeof message.id === "string" &&
      message.id.length > 0 &&
      message.id.length <= 128 &&
      (message.role === "user" || message.role === "system") &&
      (typeof message.content === "string" || Array.isArray(message.content)),
  );
}

/** The text of the last thing the Bot said in a turn, for the roster row. */
function lastSaid(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return "";
    if (
      message?.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.trim()
    ) {
      return message.content.trim();
    }
  }
  return "";
}

/**
 * What ended a turn, as a fact the surface has words for — never the words of whatever threw.
 *
 * A Drizzle failure's message is its statement and its bound parameters (`failure-text.ts`), and the
 * window and the ledger's `error` column were both being handed it. The Bot service's own facts
 * (`laf:model_rate_limited`, the stall guard's `laf:agent_stalled`) pass as they are; its transport's
 * prose ("Unable to connect…") is reduced to the turn-failure fact both classifiers read
 * (`channels/turn-failures.ts`, `app/src/lib/channels/turn-failure.ts`); the turn's own deadline is
 * `laf:run_timed_out`, as a routine's is; anything else is logged here and reaches nobody but the
 * operator.
 */
export function turnFailureOf(error: unknown, threadId: string): string {
  if (error instanceof RunDeadline) return RUN_TIMED_OUT;
  if (error instanceof RunFailed) {
    return WHOLE_FACT.test(error.reason)
      ? error.reason
      : classifyTurnFailure(error.reason);
  }
  const said = error instanceof Error ? error.message : "";
  if (WHOLE_FACT.test(said)) return said;
  log.error("turn_failed", {
    thread: threadId,
    reason: describeFailure(error),
  });
  return TURN_FAILURE_CODES.unknown;
}

export function createTurnEngine(options: TurnEngineOptions) {
  const live = new Map<string, LiveTurn>();
  const maxSteps = options.maxSteps ?? CHAT_MAX_STEPS;
  const timeoutMs = options.timeoutMs ?? CHAT_TURN_TIMEOUT_MS;
  const lane = options.lane;

  const announceTurn = (turn: LiveTurn, status: TurnStatus, code?: string) => {
    turn.status = status;
    const state: TurnState = {
      id: turn.id,
      status,
      asked: turn.asked,
      ...(code ? { code } : {}),
    };
    options.hub.turn(turn.threadId, state);
  };

  /** Write the turn's messages as they stand. Never throws: persistence must not break a turn. */
  const persist = async (
    threadId: string,
    runId: string,
    messages: readonly Message[],
  ): Promise<void> => {
    if (messages.length === 0) return;
    try {
      await appendMessages(options.database, threadId, messages, { runId });
    } catch (error) {
      log.error("turn_messages_not_persisted", {
        thread: threadId,
        reason: describeFailure(error),
      });
    }
  };

  const run = async (turn: LiveTurn, input: SendInput): Promise<void> => {
    const { threadId, owner, botId } = input;
    const meter = createRunMeter();
    const signal = turn.stop.signal;
    /** When each assistant message began streaming: the stamp the transcript's separators read. */
    const startedAt = new Map<string, string>();
    /** When each result was filed. */
    const filedAt = new Map<string, string>();
    let target: TurnAgent | undefined;
    let from = 0;
    let events = 0;
    let failure: string | null = null;
    let stopped = false;

    /*
     * THE BOT'S LANE: HELD WHILE THE TURN DRIVES THE BOT, LET GO OF WHILE IT WAITS ON A PERSON.
     *
     * A turn used to hold the lane from its first step to its last, and a turn waiting on a
     * question holds it for up to ten minutes a question: the 07:30 briefing, queued behind it, ran
     * at nine (review H1, 2026-09-27). The lane is released for every wait on a person and taken
     * back before the turn touches the Bot again, and whoever reads a wait's outcome is told whether
     * anybody else drove the Bot meanwhile — a routine may have moved the shared browser.
     *
     * A stop never waits for the lane: taking it back races the stop, and a hold granted after the
     * turn is over is handed straight back, so nothing abandoned mid-wait can keep the Bot forever.
     */
    let hold: LaneHold | null = null;
    let over = false;
    const stoppedNow = new Promise<null>((resolve) => {
      if (signal.aborted) resolve(null);
      else
        signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    const take = async (): Promise<void> => {
      if (!lane) return;
      const granted = lane.acquire(botId);
      const won = await Promise.race([
        granted.then((held) => ({ held })),
        stoppedNow,
      ]);
      if (!won) {
        void granted.then((held) => held.release());
        return;
      }
      if (over) {
        won.held.release();
        return;
      }
      hold = won.held;
    };
    const letGo = () => {
      hold?.release();
      hold = null;
    };
    const awaitPerson = async <T>(
      wait: () => Promise<T>,
    ): Promise<{ value: T; moved: boolean }> => {
      if (!lane) return { value: await wait(), moved: false };
      const before = lane.grants(botId);
      letGo();
      let value: T;
      try {
        value = await wait();
      } finally {
        await take();
      }
      // Our own grant back is one; anything more is somebody else who held the Bot meanwhile.
      return { value, moved: lane.grants(botId) - before > 1 };
    };

    /** The turn's messages with the store's own fields, as the thread keeps them. */
    const turnMessages = (): Message[] =>
      (target?.messages.slice(from) ?? []).map((message) => {
        const at =
          startedAt.get(message.id) ?? filedAt.get(message.id) ?? undefined;
        return {
          ...message,
          ...(at ? { lafAt: at } : {}),
          ...(message.role === "assistant" ? { lafAgentId: botId } : {}),
        } as Message;
      });

    try {
      // Queued until the Bot is free: a routine it is running finishes first.
      await take();
      if (signal.aborted) throw new RunStopped([]);
      if (options.admits && !(await options.admits(owner.id))) {
        throw new Error("laf:not_admitted");
      }
      const agents = await options.resolveAgents(owner);
      target = agents[botId];
      if (!target) throw new Error("laf:bot_not_found");
      /*
       * THE CONVERSATION'S OWN ID ON EVERY RUN. An agent resolved here is a fresh one, and AG-UI
       * mints it a random thread id: every run of the turn then looked like a conversation nobody
       * had seen, so each turn began a new epoch ("resumed") and was billed its whole history
       * again, and its usage rows named a thread that does not exist. Measured on the usage rows:
       * every server-owned turn started an epoch, where the window's turns went on in one.
       */
      target.threadId = threadId;
      const stored = repairUnanswered(
        (await messagesFor(options.database, threadId)).map(forTheBot),
      );
      target.setMessages(stored);
      // The turn's own messages start at what the person asked, which the send already filed.
      const askedAt = stored.findIndex((message) =>
        turn.asked.includes(message.id),
      );
      from = askedAt === -1 ? stored.length : askedAt;
      // Earlier calls the repair answered are filed with the turn, the way the window's run did.
      const repairedEarlier = stored
        .slice(0, from)
        .filter((message) => message.role === "tool");
      if (repairedEarlier.length > 0) {
        await persist(threadId, turn.id, repairedEarlier);
      }
      const agent = target;
      options.hub.watchLive(threadId, () => agent.messages.slice(from));
      announceTurn(turn, "running");
      options.hub.event(threadId, turn.id, {
        type: "RUN_STARTED",
        threadId,
        runId: turn.id,
      } as BaseEvent);

      const toolkit = await options.tools(
        { botId, owner, threadId, runId: turn.id, awaitPerson },
        input.tools,
      );
      let persisting: Promise<void> = Promise.resolve();
      const persistNow = () => {
        persisting = persisting.then(() =>
          persist(threadId, turn.id, turnMessages()),
        );
        return persisting;
      };
      await runTurnLoop(agent, {
        tools: toolkit.tools,
        execute: toolkit.execute,
        timeoutMs,
        maxSteps,
        // What the window's CopilotKit properties carried: the device's clock and language.
        forwardedProps:
          input.device === undefined ? {} : { device: input.device },
        /*
         * Each run of the model under the turn's own id, so the `model.usage` rows it writes are
         * the ledger's turn's (`insights/read.ts` joins on the part before the dot). The first run
         * is the turn's id itself; the rest are numbered after it.
         */
        runIdFor: (n) => (n === 0 ? turn.id : `${turn.id}.${n}`),
        signal,
        observe: (event) => {
          events += 1;
          meter.observe(event);
          const type = String(event.type);
          const started = event as BaseEvent & { messageId?: string };
          if (
            type === "TEXT_MESSAGE_START" &&
            started.messageId &&
            !startedAt.has(started.messageId)
          ) {
            startedAt.set(started.messageId, new Date().toISOString());
          }
          // One run to every window, however many times the model is asked: the inner run's
          // beginning and end are the loop's business, and an error ends the turn below.
          if (
            type === "RUN_STARTED" ||
            type === "RUN_FINISHED" ||
            type === "RUN_ERROR"
          ) {
            return;
          }
          options.hub.event(threadId, turn.id, event);
        },
        onToolResult: (message) => {
          filedAt.set(message.id, new Date().toISOString());
          options.hub.event(threadId, turn.id, {
            type: "TOOL_CALL_RESULT",
            messageId: message.id,
            toolCallId: message.toolCallId,
            content: message.content,
            role: "tool",
          } as BaseEvent);
          void persistNow();
        },
        onStep: async () => {
          // The server's own copies, which put right anything a window pieced together from deltas.
          options.hub.messages(
            threadId,
            turn.id,
            agent.messages
              .slice(from)
              .filter((message) => message.role === "assistant"),
          );
          await persistNow();
        },
      });
      await persisting;
    } catch (error) {
      if (error instanceof RunStopped || signal.aborted) {
        stopped = true;
      } else {
        failure = turnFailureOf(error, threadId);
      }
    }
    meter.end();
    // Nothing of this turn drives the Bot any more: whoever is next may have it.
    over = true;
    letGo();

    /*
     * A STOP LEAVES NO CALL UNANSWERED. The one in flight when the person pressed it — a click, a
     * wait for an answer — gets the stopped result the window's handler would have filed, so the
     * thread reads as a task the person stopped (이어서 하기) and not as one a closed window lost.
     *
     * A FAILURE LEAVES NO HALF A CALL. When the Bot's own stream stops mid-call — the service died,
     * a proxy closed it — nobody answered the call, and its arguments are whatever had arrived:
     * `{"fact": "가게는`. Filed as merely unanswered, every later request handed it back to the model
     * as `remember({})` (`shared/stream-cut.ts`). Arguments that are not a whole object never
     * finished arriving, so the call gets the cut's answer, which keeps it out of every later
     * request. A call whose arguments did arrive is only unanswered, and says so.
     */
    if (target && (stopped || failure !== null)) {
      const answered = new Set(
        target.messages
          .slice(from)
          .filter((message) => message.role === "tool")
          .map((message) => (message as { toolCallId: string }).toolCallId),
      );
      for (const message of target.messages.slice(from)) {
        if (message.role !== "assistant") continue;
        for (const call of message.toolCalls ?? []) {
          if (answered.has(call.id)) continue;
          const result = {
            id: randomUUID(),
            role: "tool" as const,
            toolCallId: call.id,
            content: stopped
              ? outcomeContent(STOPPED_RESULT)
              : arrivedWhole(call.function.arguments)
                ? UNANSWERED_RESULT
                : streamCutResult(),
          };
          target.addMessage(result);
          filedAt.set(result.id, new Date().toISOString());
          options.hub.event(threadId, turn.id, {
            type: "TOOL_CALL_RESULT",
            messageId: result.id,
            toolCallId: call.id,
            content: result.content,
            role: "tool",
          } as BaseEvent);
          answered.add(call.id);
        }
      }
    }
    if (target) {
      options.hub.messages(threadId, turn.id, target.messages.slice(from));
      await persist(threadId, turn.id, turnMessages());
    }

    const status: "done" | "error" | "stopped" = stopped
      ? "stopped"
      : failure !== null
        ? "error"
        : "done";
    /*
     * FREE, THEN SAY SO — IN ONE STEP. A window that hears the turn is over may send the person's
     * next message that instant, and was answered 409 `laf:turn_in_progress` while this function
     * was still writing the ledger (review L1). And nothing may be awaited between the two, or a new
     * turn's frames could be published before this one's end and be reset by it.
     */
    turn.free();
    options.hub.event(
      threadId,
      turn.id,
      (status === "error"
        ? { type: "RUN_ERROR", message: failure ?? "", code: failure ?? "" }
        : { type: "RUN_FINISHED", threadId, runId: turn.id }) as BaseEvent,
    );
    announceTurn(
      turn,
      status,
      status === "error" ? (failure ?? undefined) : undefined,
    );
    try {
      await options.ledger.settle(turn.id, {
        status,
        error: status === "error" ? failure : null,
        eventCount: events,
        measure: meter.read(),
      });
    } catch (error) {
      log.error("run_end_not_persisted", {
        thread: threadId,
        reason: describeFailure(error),
      });
    }

    // The roster row and every open tab; a notice for a person with no tab at all.
    const said = target ? lastSaid(target.messages.slice(from)) : "";
    if (said && options.announce) {
      await options
        .announce({
          owner,
          channelId: input.channelId,
          agentId: botId,
          text: said,
        })
        .catch((error: unknown) => {
          log.warn("turn_activity_not_recorded", {
            thread: threadId,
            reason: describeFailure(error),
          });
        });
    }
  };

  return {
    /**
     * Take what the person said and start the turn that answers it.
     *
     * Refused while the conversation already has a turn: the window holds a correction typed
     * mid-answer and sends it when the turn ends, exactly as it did when it drove the turn — two
     * turns racing on one thread would interleave their messages in the store.
     */
    async send(
      input: SendInput,
    ): Promise<
      { ok: true; turnId: string } | { ok: false; code: SendRefusal }
    > {
      if (!acceptable(input.messages)) {
        return { ok: false, code: "laf:turn_message_invalid" };
      }
      const current = live.get(input.threadId);
      if (current) return { ok: false, code: "laf:turn_in_progress" };
      if (options.admits && !(await options.admits(input.owner.id))) {
        return { ok: false, code: "laf:not_admitted" };
      }

      const turnId = randomUUID();
      let free: () => void = () => {};
      const turn: LiveTurn = {
        id: turnId,
        threadId: input.threadId,
        ownerId: input.owner.id,
        botId: input.botId,
        label: chatLabelOf(input.messages),
        startedAt: new Date(),
        status: "queued",
        asked: input.messages.map((message) => message.id),
        stop: new AbortController(),
        free: () => free(),
        ended: Promise.resolve(),
      };
      // Re-checked after every await below: a second send can arrive while this one is writing.
      if (live.has(input.threadId)) {
        return { ok: false, code: "laf:turn_in_progress" };
      }
      live.set(input.threadId, turn);
      try {
        await options.ledger.begin({
          runId: turnId,
          threadId: input.threadId,
          agentId: input.botId,
          userId: input.owner.id,
          origin: "chat",
          // What the person asked, for 오늘 to name the turn by.
          label: turn.label,
          continues: false,
        });
        // The person's side is safe from here, whatever happens to the turn.
        await appendMessages(options.database, input.threadId, input.messages, {
          runId: turnId,
        });
      } catch (error) {
        live.delete(input.threadId);
        throw error;
      }
      const asked = input.messages;
      options.hub.watchLive(input.threadId, () => [...asked]);
      announceTurn(turn, "queued");
      /*
       * WHAT WAS ASKED, TO EVERY WINDOW, BEFORE ANY OF THE ANSWER. A window other than the sender's
       * has only the turn's frames to go by; without these it met the question for the first time in
       * the turn's last copy of its messages and drew it BELOW the answer (measured: two windows, the
       * second one's transcript ending on the question, and its sources counted across two turns).
       */
      options.hub.messages(input.threadId, turnId, [...asked]);

      // Listed for 모두 멈추기 from the moment it is accepted, queued behind a routine included.
      const done = options.work?.track({
        kind: "chat",
        userId: input.owner.id,
        agentId: input.botId,
        threadId: input.threadId,
        stop: async () => {
          turn.stop.abort();
          return true;
        },
      });
      free = () => {
        done?.();
        if (live.get(input.threadId) === turn) live.delete(input.threadId);
      };
      turn.ended = run(turn, input)
        .catch((error: unknown) => {
          log.error("turn_crashed", { reason: describeFailure(error) });
        })
        .finally(() => turn.free());
      return { ok: true, turnId };
    },

    /** Stop the conversation's turn, from any window. False when there is none. */
    stop(threadId: string): boolean {
      const turn = live.get(threadId);
      if (!turn) return false;
      turn.stop.abort();
      return true;
    },

    /**
     * Stop every turn this person has going, and wait until each has written its end. What an
     * account's deletion does first, so no turn goes on writing into a conversation being deleted.
     */
    async stopFor(userId: string): Promise<void> {
      const theirs = [...live.values()].filter(
        (turn) => turn.ownerId === userId,
      );
      for (const turn of theirs) turn.stop.abort();
      await Promise.all(theirs.map((turn) => turn.ended));
    },

    /** Whether the conversation has a turn queued or running. */
    busy(threadId: string): boolean {
      return live.has(threadId);
    },

    /**
     * The turns going on for one person, as the roster reads work: a turn this process is running
     * is running however long ago it started, which the ledger's ten-minute presumption cannot say.
     */
    working(userId: string): WorkingRun[] {
      return [...live.values()]
        .filter((turn) => turn.ownerId === userId)
        .map((turn) => ({
          agentId: turn.botId,
          origin: "chat",
          label: turn.label,
          startedAt: turn.startedAt.toISOString(),
        }));
    },
  };
}

export type TurnEngine = ReturnType<typeof createTurnEngine>;
