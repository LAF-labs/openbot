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
import { isFirstMoveEnding } from "../../../shared/first-move";
import { jsonObjectOf } from "../../../shared/json-object";
import { streamCutResult } from "../../../shared/stream-cut";
import { UNANSWERED_RESULT } from "../../../shared/task-ending";
import { computerTool } from "../../../shared/tools/computer";
import { isDelegated } from "../../../shared/tools/delegate";
import { withheldToolsForwarded } from "../../../shared/tools/paused";
import type { AgentActor } from "../agents/profile-types";
import {
  classifyTurnFailure,
  TURN_FAILURE_CODES,
} from "../channels/turn-failures";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import {
  type BotLane,
  drivesTheBrowser,
  type LaneHold,
} from "../runner/bot-lane";
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
import type { FirstMoveFor } from "./first-move";
import type { TurnHub, TurnState, TurnStatus } from "./hub";

/** How many times one turn may come back asking for tools: CopilotKit's own follow-up bound. */
export const CHAT_MAX_STEPS = 100;

/**
 * The whole turn. A browsing task legitimately runs for many minutes and may wait ten on each
 * question it raises; this bounds a turn that cannot end, not one that works for a long time.
 */
export const CHAT_TURN_TIMEOUT_MS = 90 * 60_000;

/**
 * The waits before each further try at writing a turn's end: three more, a little over two seconds
 * in all — long enough for a connection that dropped to be replaced, short against a turn.
 */
const PERSIST_RETRY_MS: readonly number[] = [150, 500, 1_500];

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
  /**
   * Told when a turn's run is over, before the Bot and the conversation are free for the next:
   * what the Bot's computer held for the length of the run is let go of here
   * (`computer/gateway/secrets.ts`, `runEnded`). Never throws.
   */
  runEnded?: (run: { botId: string; threadId: string }) => Promise<void>;
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
  /**
   * The turn's first step, when the server can take it before the Bot's model is asked
   * (`first-move.ts`). Absent, or answering with no move, the turn is the loop and nothing else.
   * What it answers says what was decided as well as the call to make: the turn's own measure
   * keeps which kinds were asked about and how that ended, moved or not.
   */
  firstMove?: (input: {
    owner: AgentActor;
    botId: string;
    asked: readonly Message[];
    tools: readonly Tool[];
  }) => ReturnType<FirstMoveFor>;
  maxSteps?: number;
  timeoutMs?: number;
  /**
   * A conversation's Bot holds none of the browser's tools: its browsing is a run's it delegates
   * to (`ChatToolsDeps.delegatesBrowsing`, piece 6-2). What it is handed of its own past then
   * leaves out the browser steps it once took itself — see `withoutBrowserSteps`.
   */
  handsBrowsingOver?: boolean;
  /** How long to wait before each further try at a turn's last write. A test's are shorter. */
  persistRetryMs?: readonly number[];
  /**
   * The clock a turn's measure is read off (`telemetry/run-meter.ts`). A test's is moved by hand,
   * so each part of a turn took exactly as long as the test says it did.
   */
  now?: () => number;
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
  /**
   * Write what the turn has made so far, after whatever it is already writing. Set once the turn
   * has a Bot to speak for; see `flush` on the engine.
   */
  flush?: () => Promise<void>;
};

/** A message as the Bot is handed it: AG-UI's fields, none of the store's own. */
function forTheBot(message: Message): Message {
  const {
    lafAt: _at,
    lafAgentId: _by,
    lafRedacted: _redacted,
    lafFirstMove: _moved,
    lafDelegated: _delegated,
    ...rest
  } = message as StoredMessage;
  return rest as Message;
}

/** The conversation a conversation's delegated runs are made in: one, named after it. */
export const delegatedThreadOf = (threadId: string): string =>
  `${threadId}.browse`;

/** Whether a call is one of the browser's own: a tool of the computer's that drives a page. */
const isBrowserStep = (name: string | undefined): boolean =>
  name !== undefined &&
  computerTool(name) !== undefined &&
  drivesTheBrowser(name);

/**
 * A thread as a Bot that hands its browsing over is handed it: without the browser steps it took
 * itself, before it handed them over.
 *
 * A CONVERSATION IS ONE FOR LIFE, AND ITS PAST IS FULL OF THE BOT OPENING PAGES. Handed that past
 * with the browser's tools gone from its list, the Bot did what its own history showed it doing:
 * on the first message after the change it called `computer_navigate`, was told there is no such
 * tool, and only then delegated — a wasted request, and a card on the person's screen for a task
 * that "did not finish" (pressed on the real stack, 2026-10-11). What it had read on those pages
 * is in what it said afterwards, which stays; the steps go, the way a delegated run's steps are
 * never handed to it (`isDelegated`). A pure reading of what is stored — the rows are not
 * rewritten, and the same rows always read the same, so the head of the conversation it is
 * handed does not move from one turn to the next.
 *
 * A reply that only took such a step, and said nothing, goes whole. Its other calls stay.
 */
export function withoutBrowserSteps(messages: Message[]): Message[] {
  const gone = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (isBrowserStep(call.function?.name)) gone.add(call.id);
    }
  }
  if (gone.size === 0) return messages;
  const kept: Message[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (!gone.has(message.toolCallId)) kept.push(message);
      continue;
    }
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      kept.push(message);
      continue;
    }
    const calls = message.toolCalls.filter((call) => !gone.has(call.id));
    if (calls.length === message.toolCalls.length) {
      kept.push(message);
      continue;
    }
    const { toolCalls: _taken, ...said } = message;
    if (calls.length > 0) kept.push({ ...said, toolCalls: calls });
    else if (typeof said.content === "string" && said.content.trim()) {
      kept.push(said);
    }
  }
  return kept;
}

/**
 * The thread with every call that never got an answer answered, where it was made — a provider
 * rejects a conversation holding one, and an old call must never be carried out now. The repair the
 * window made before every run it drove, until that path was removed (2026-10-05); this is the only
 * one there is.
 *
 * AND EVERY ANSWER FILED SOMEWHERE ELSE IS HANDED BACK WHERE ITS CALL WAS MADE. The thread is
 * append-only, so the answer this function makes is filed after the person's new message — the one
 * that started the turn — and not beside its call. That turn was handed the conversation in order;
 * every turn after it read the call, then the person, then the answer, and a provider refuses that
 * with a 400 on every request (measured in `turn-engine.integration.test.ts`): "봇이 모델에 닿지
 * 못했어요" under 이어서 하기's next answer, and 다시 시도 the same again, for good. So an answer that
 * is not in the run of results right after its call is moved there, behind the ones that are; a
 * thread already in order comes back as the very messages it was, because a provider has cached
 * those bytes.
 *
 * AN ANSWER BELONGS TO THE NEAREST CALL BEFORE IT BY THAT ID, not to the first: an endpoint that
 * numbers its calls (`call_0`) uses the same id in every turn, and the first call by that name would
 * take every later turn's answer away from its own call. An answer with no call before it is left
 * where it stands, as it always was.
 */
export function repairUnanswered(messages: readonly Message[]): Message[] {
  const callOf = (message: Message) =>
    (message as { toolCallId: string }).toolCallId;
  /** Each answer's call: the place of the nearest message before it that makes it. */
  const home = new Map<number, number>();
  /** Which call message's run of results each answer stands in, if any. */
  const runOf = new Map<number, number>();
  const latest = new Map<string, number>();
  let run: number | null = null;
  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) latest.set(call.id, index);
      run = index;
      return;
    }
    if (message.role !== "tool") {
      run = null;
      return;
    }
    if (run !== null) runOf.set(index, run);
    const maker = latest.get(callOf(message));
    if (maker !== undefined) home.set(index, maker);
  });
  /** Answers away from their call — filed after somebody spoke again — by the call's place. */
  const elsewhere = new Map<number, Message[]>();
  const isMoved = (index: number) =>
    home.has(index) && home.get(index) !== runOf.get(index);
  messages.forEach((message, index) => {
    if (!isMoved(index)) return;
    const maker = home.get(index) as number;
    elsewhere.set(maker, [...(elsewhere.get(maker) ?? []), message]);
  });

  const repaired: Message[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as Message;
    if (isMoved(index)) continue;
    repaired.push(message);
    if (message.role !== "assistant") continue;
    const answered = new Set<string>();
    let at = index + 1;
    for (; messages[at]?.role === "tool"; at += 1) {
      if (isMoved(at)) continue;
      const result = messages[at] as Message;
      repaired.push(result);
      if (home.get(at) === index) answered.add(callOf(result));
    }
    for (const result of elsewhere.get(index) ?? []) {
      repaired.push(result);
      answered.add(callOf(result));
    }
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
    index = at - 1;
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
  /*
   * EVERY TURN THAT HAS NOT WRITTEN ITS END, which is more than `live`. A turn leaves `live` the
   * moment the conversation is free for the next message, and only then settles its row in the
   * ledger and records what the Bot said — rows that name the conversation. A deletion that asked
   * `live` found nothing in that moment, removed the thread, and the rows landed after it
   * (review, 2026-10-10). Whoever must wait for a conversation to fall silent waits on this.
   */
  const unfinished = new Set<LiveTurn>();
  const maxSteps = options.maxSteps ?? CHAT_MAX_STEPS;
  const timeoutMs = options.timeoutMs ?? CHAT_TURN_TIMEOUT_MS;
  const persistRetryMs = options.persistRetryMs ?? PERSIST_RETRY_MS;
  const now = options.now ?? Date.now;
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

  /**
   * Write the turn's messages as they stand, and say whether they were written. Never throws: a
   * write that fails partway through a turn must not break the turn — the next one carries the
   * same messages again — but the LAST one is the turn's record, and its failure is the turn's
   * (`persistEnd`).
   */
  const persist = async (
    threadId: string,
    runId: string,
    messages: readonly Message[],
  ): Promise<boolean> => {
    if (messages.length === 0) return true;
    try {
      await appendMessages(options.database, threadId, messages, { runId });
      return true;
    } catch (error) {
      log.error("turn_messages_not_persisted", {
        thread: threadId,
        reason: describeFailure(error),
      });
      return false;
    }
  };

  /**
   * The turn's last write, tried again before it is given up on.
   *
   * A TURN WHOSE END WAS NEVER WRITTEN USED TO END `done`. `persist` swallowed every failure, the
   * status ignored it, and the ledger was settled as a turn that finished: a person watched the
   * whole answer arrive, reloaded, and found their question alone — no answer and no word of a
   * failure — and the Bot's next turn knew nothing of the step (refactoring review, 2026-10-02).
   * A database that hiccups for a moment is the ordinary cause, so the write is tried again over a
   * couple of seconds; one that still fails is a turn that failed, and is said so.
   */
  const persistEnd = async (
    threadId: string,
    runId: string,
    messages: () => readonly Message[],
  ): Promise<boolean> => {
    if (await persist(threadId, runId, messages())) return true;
    for (const wait of persistRetryMs) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (await persist(threadId, runId, messages())) return true;
    }
    return false;
  };

  const run = async (
    turn: LiveTurn,
    input: SendInput,
    /** When the engine was handed what the person said. See `send`. */
    acceptedAt: number,
  ): Promise<void> => {
    const { threadId, owner, botId } = input;
    // Made here, where it always was: what was measured before the two new firsts starts here.
    const meter = createRunMeter(now, acceptedAt);
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
     * THE BROWSER'S LANE: TAKEN AT THE FIRST CALL THAT USES THE BROWSER, HELD TO THE TURN'S END,
     * LET GO OF WHILE IT WAITS ON A PERSON.
     *
     * A turn used to take the lane before its first step (until piece 5-4, 2026-10-10), so a
     * conversation that only talked waited behind a routine that was browsing — and behind another
     * conversation of the same Bot's. What the lane keeps apart is two loops on one browser, and a
     * turn that never calls a browser tool is not one of them: it takes nothing and waits for
     * nobody. Once taken it is kept to the end, because what the turn saw (its snapshot's refs,
     * its tab) has to still be there at its next step.
     *
     * A turn waiting on a question held it for up to ten minutes a question: the 07:30 briefing,
     * queued behind it, ran at nine (review H1, 2026-09-27). The lane is released for every wait
     * on a person and taken back before the turn touches the browser again, and whoever reads a
     * wait's outcome is told whether anybody else drove it meanwhile — a routine may have moved
     * the shared browser.
     *
     * A stop never waits for the lane: taking it races the stop, and a hold granted after the
     * turn is over is handed straight back, so nothing abandoned mid-wait can keep the browser
     * forever.
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
    /*
     * WAITING FOR THE BROWSER IS SAID, AND ONLY WHEN THERE IS A WAIT. A turn that reaches for a
     * browser somebody else has goes quiet for as long as they keep it — minutes, behind a
     * routine — and `queued` is the word a window already draws for that. Not said where the
     * browser is free: the word would flash past on every turn that browses.
     */
    const takeSaying = async (): Promise<void> => {
      if (!lane) return;
      const waits = lane.busy(botId);
      if (waits && !over && !signal.aborted) announceTurn(turn, "queued");
      await take();
      if (waits && !over && !signal.aborted) announceTurn(turn, "running");
    };
    /*
     * One taking at a time: a second call that asked while the first was still in line would
     * queue behind this turn's own hold, which is let go of only when the turn ends.
     */
    let borrowing: Promise<void> | null = null;
    const borrowBrowser = async (): Promise<boolean> => {
      if (!lane) return true;
      if (!hold) {
        borrowing ??= takeSaying().finally(() => {
          borrowing = null;
        });
        await borrowing;
      }
      // Not held after asking is a stop that won the race, or a turn that is already over.
      return hold !== null;
    };
    const awaitPerson = async <T>(
      wait: () => Promise<T>,
    ): Promise<{ value: T; moved: boolean }> => {
      /*
       * A TURN THAT HAS NOT USED THE BROWSER HAS NOTHING TO GIVE BACK OR TAKE BACK. A question
       * about a plugin's call is waited on by a turn that may never browse; taking the lane
       * "back" after it would have that turn hold the browser to its end for nothing, and wait
       * behind a routine to do it.
       */
      if (!lane || !hold) return { value: await wait(), moved: false };
      const before = lane.grants(botId);
      letGo();
      let value: T;
      try {
        value = await wait();
      } finally {
        /*
         * WAITING FOR THE BOT AGAIN IS SAID. The person has answered, and whatever moved in while
         * they were away — a routine — may hold the Bot for minutes yet; a turn that just went
         * quiet there read as a Bot thinking with nothing true to look at. `queued` is the word the
         * turn began under, so no window needs a new one.
         */
        if (!over && !signal.aborted) announceTurn(turn, "queued");
        await take();
        if (!over && !signal.aborted) announceTurn(turn, "running");
      }
      // Our own grant back is one; anything more is somebody else who held the Bot meanwhile.
      return { value, moved: lane.grants(botId) - before > 1 };
    };

    /*
     * WHAT A DELEGATED RUN SAID AND DID, FILED BESIDE THE TURN'S OWN MESSAGES (piece 6-2).
     *
     * A turn that hands its browsing to a run of its own (`delegate`, below) has two records.
     * The Bot's is `target.messages`: the call it made and the one answer it was handed back.
     * A person's is that with the delegated run's steps in between — every page it opened and
     * every card it raised — because everything a window draws about browsing is folded from the
     * conversation's messages, and a question is drawn on the line of the call that raised it
     * (`app/src/lib/turns/questions.ts`). So the steps are kept here, marked with the call they
     * were made for, and woven in wherever the turn's messages are for people: every window's
     * frames and the thread's rows. Never into `target.messages`.
     */
    const beside: { callId: string; messages: StoredMessage[] }[] = [];
    /** The turn's messages as a person reads them: each delegated run's just before its answer. */
    const transcript = (): Message[] => {
      const own = target?.messages.slice(from) ?? [];
      if (beside.length === 0) return own;
      const woven: Message[] = [];
      const placed = new Set<string>();
      for (const message of own) {
        if (message.role === "tool") {
          for (const run of beside) {
            if (run.callId !== message.toolCallId || placed.has(run.callId)) {
              continue;
            }
            woven.push(...run.messages);
            placed.add(run.callId);
          }
        }
        woven.push(message);
      }
      // A run whose call has no answer yet: still going, or cut with the turn.
      for (const run of beside) {
        if (!placed.has(run.callId)) woven.push(...run.messages);
      }
      return woven;
    };

    /** What the Bot — and a run it delegated to — has said and asked for, in the turn's order. */
    const stepsSoFar = (): Message[] =>
      transcript().filter((message) => message.role === "assistant");

    /** The turn's messages with the store's own fields, as the thread keeps them. */
    const turnMessages = (): Message[] =>
      transcript().map((message) => {
        const at =
          startedAt.get(message.id) ?? filedAt.get(message.id) ?? undefined;
        return {
          ...message,
          ...(at ? { lafAt: at } : {}),
          ...(message.role === "assistant" ? { lafAgentId: botId } : {}),
        } as Message;
      });

    try {
      // Nothing is waited for here: the browser is asked for by the call that uses it.
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
      /*
       * WHAT A DELEGATED RUN WROTE IS LEFT OUT (piece 6-2). Its steps are in the thread for a
       * person to read — the sites it opened, the cards it raised — and the Bot that delegated
       * reads the one answer it was handed back, which is its call's result. Handed the steps
       * too, every later turn would pay for the browsing it was spared the tools of.
       */
      const kept = (await messagesFor(options.database, threadId))
        .filter((message) => !isDelegated(message))
        .map(forTheBot);
      const stored = repairUnanswered(
        options.handsBrowsingOver ? withoutBrowserSteps(kept) : kept,
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
      options.hub.watchLive(threadId, transcript);
      announceTurn(turn, "running");
      options.hub.event(threadId, turn.id, {
        type: "RUN_STARTED",
        threadId,
        runId: turn.id,
      } as BaseEvent);

      let persisting: Promise<void> = Promise.resolve();
      const persistNow = () => {
        persisting = persisting.then(async () => {
          await persist(threadId, turn.id, turnMessages());
        });
        return persisting;
      };
      turn.flush = persistNow;

      /*
       * A RUN OF THE BOT'S OWN, INSIDE THE TURN, FOR ONE CALL (piece 6-2,
       * `docs/laf/redesign-2026-10.md` §4). The turn's Bot hands a piece of work over — its
       * browsing — and what does it is the same Bot in a conversation of its own: a fresh thread
       * holding the instruction alone, so the tools that work needs sit at the head of THAT
       * conversation and of no turn the person's own conversation ever pays for.
       *
       * It is this turn's in everything else. Its calls are carried out by the turn's own
       * executor, so the boundary, the browser's lane, a wait on a person and the run a question
       * names are the turn's. What it costs and how many calls it made are on the turn's row. A
       * stop, the turn's deadline and a failure of the model end it as they end the turn, by the
       * same throw. And its steps are filed beside the turn's messages (`beside`, above): seen by
       * every window as they happen, kept in the thread, never read by the Bot that delegated.
       *
       * WHAT IS FILED IS THE STEPS, NOT THE ANSWER. A reply that asks for tools is a step: the
       * line a person watches, with whatever the run said before it. The reply that asks for
       * nothing is the answer, and it is the delegating Bot's to read — filed too, it would be
       * drawn as the Bot saying the same thing twice. For the same reason the run's words are
       * not streamed: nobody knows a reply is a step until it has asked for a tool.
       */
      let delegations = 0;
      /** When the turn's own loop runs out of time; a delegated run has what is left of it. */
      let endsAt = Date.now() + timeoutMs;
      const delegate: NonNullable<ChatTurnContext["delegate"]> = async (
        run,
      ) => {
        const worker = (await options.resolveAgents(owner))[botId];
        if (!worker) throw new Error("laf:bot_not_found");
        delegations += 1;
        const ordinal = delegations;
        /*
         * ITS OWN CONVERSATION — AND THE SAME ONE EVERY TIME THIS CONVERSATION DELEGATES. Nothing
         * of the person's thread is in it, and nothing of the last delegation either: it starts
         * from the instruction alone. But it is named after the person's thread rather than at
         * random, because the provider's cache is kept by conversation (`agent-bot/src/turn.ts`,
         * `prompt_cache_key`): under a new name each time, the tools and the prompt at its head
         * — 5.4K tokens, the same bytes every time — were billed whole on every delegation
         * (measured 2026-10-11: 0 of 5,384 read from the cache on the second of two delegations
         * four minutes apart, $0.00057 of a turn that cost $0.0018). The prompt layer keeps a
         * conversation that is not a chat for six hours and freezes its words once
         * (`context/conversations.ts`), which is what makes the head the same bytes.
         */
        worker.threadId = delegatedThreadOf(threadId);
        worker.setMessages([
          { id: randomUUID(), role: "user", content: run.instruction },
        ]);
        const filed: StoredMessage[] = [];
        const known = new Set<string>();
        beside.push({ callId: run.callId, messages: filed });
        const file = (message: Message) => {
          if (known.has(message.id)) return;
          known.add(message.id);
          filed.push({ ...message, lafDelegated: run.callId } as StoredMessage);
        };
        const { steps } = await runTurnLoop(worker, {
          tools: run.tools,
          execute: run.execute,
          timeoutMs: Math.max(1, endsAt - Date.now()),
          maxSteps,
          forwardedProps: {
            mode: run.mode,
            ...(input.device === undefined ? {} : { device: input.device }),
          },
          // Under the turn's id like every run of it, and apart from the turn's own `.1`, `.2`.
          runIdFor: (n) => `${turn.id}.d${ordinal}.${n}`,
          signal: run.signal,
          observe: (event) => {
            events += 1;
            // What it cost and what it called are the turn's. Its words are not a person's first
            // word: none of them is drawn until a step is filed.
            const type = String(event.type);
            if (type === "CUSTOM" || type === "TOOL_CALL_START") {
              meter.observe(event);
            }
          },
          onToolResult: (message) => {
            filedAt.set(message.id, new Date().toISOString());
            file(message);
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
            for (const message of worker.messages) {
              if (
                message.role !== "assistant" ||
                (message.toolCalls?.length ?? 0) === 0 ||
                known.has(message.id)
              ) {
                continue;
              }
              startedAt.set(message.id, new Date().toISOString());
              file(message);
            }
            options.hub.messages(threadId, turn.id, stepsSoFar());
            await persistNow();
          },
        });
        const said = worker.messages
          .filter((message) => message.role === "assistant")
          .map((message) =>
            typeof message.content === "string" ? message.content.trim() : "",
          )
          .filter(Boolean);
        return { answer: said.at(-1) ?? "", steps };
      };

      const toolkit = await options.tools(
        {
          botId,
          owner,
          threadId,
          runId: turn.id,
          awaitPerson,
          borrowBrowser,
          delegate,
        },
        input.tools,
      );

      /*
       * THE FIRST MOVE (`first-move.ts`): a call the server makes for the Bot before its model is
       * asked, when it is sure what the turn's first step is. Filed in the thread exactly as a call
       * the Bot made — an assistant message that asks, a result that answers — through the turn's
       * own executor, so the grant, the boundary and the audit row are the ones any call gets. The
       * loop below then starts with the result in hand: `runTurnLoop` carries out only the calls
       * made during itself, and these two messages are before it.
       *
       * Anything going wrong here makes no move. A decision that threw, a stop that landed while it
       * was out — the turn goes on as the turn it would have been.
       */
      const decidingAt = now();
      const decision =
        (await options
          .firstMove?.({
            owner,
            botId,
            asked: input.messages,
            tools: toolkit.tools,
          })
          .catch((error: unknown) => {
            log.warn("first_move_failed", { reason: describeFailure(error) });
            return null;
          })) ?? null;
      const move = decision?.move ?? null;
      /*
       * ON THE TURN'S OWN MEASURE, whenever the decisions model was asked (`run-meter.ts`,
       * `FirstMoveMeasure`). This wait used to be inside the turn's queued time with no name, and
       * whether a move was made was only in the trail; the owner's condition for first moves — a
       * kind that is seldom made comes out — is read off the turns themselves now. A move speaks
       * for itself; a decision that left the step to the Bot's model says which kinds it was
       * about and why. A message nobody was asked about is no first move, and measures none.
       *
       * BY THE LIST THE TRAIL GOES BY (`isFirstMoveEnding`, `shared/first-move.ts`): a row of
       * the trail and a first move on this turn's row are of the same decisions, because one
       * list says which they are.
       */
      if (decision && isFirstMoveEnding(decision.verdict)) {
        meter.firstMove({
          asked: decision.asked,
          verdict: decision.verdict,
          kind: move?.kind ?? null,
          decisionMs: now() - decidingAt,
        });
      }
      if (move && !signal.aborted) {
        const callId = `call_${randomUUID().replaceAll("-", "")}`;
        /*
         * Told from a call the Bot made by its message's `lafFirstMove`, and by nothing else
         * (`shared/first-move.ts`). ON THE TURN'S OWN COPY, not added on the way out: every window
         * is sent the turn's messages from that copy — the frame below, each step's copies, the
         * snapshot a window joining halfway is handed, the copies at the end — and the thread is
         * written from it. Riding it, the mark reaches the Bot service with this turn's run, which
         * builds what the model reads key by key (`agent-bot/src/transcript.ts`) and never sends it
         * on; a later turn is handed the thread without it (`forTheBot`).
         */
        const asking: StoredMessage = {
          id: randomUUID(),
          role: "assistant",
          content: "",
          lafFirstMove: true,
          toolCalls: [
            {
              id: callId,
              type: "function",
              function: {
                name: move.tool,
                arguments: JSON.stringify(move.args),
              },
            },
          ],
        };
        agent.addMessage(asking);
        startedAt.set(asking.id, new Date().toISOString());
        // The server's own copy to every window: there are no deltas of a message nobody streamed.
        options.hub.messages(threadId, turn.id, [asking]);
        // And so no event for the meter to see it by: the step every window draws from here.
        meter.stepSent();
        const callingAt = now();
        // Timed whatever comes back, a throw included: only a call that never left has no time.
        const outcome = await toolkit
          .execute(move.tool, move.args, { id: callId, signal })
          .finally(() => meter.firstMoveCalled(now() - callingAt));
        const answer = {
          id: randomUUID(),
          role: "tool" as const,
          toolCallId: callId,
          content: outcomeContent(outcome),
        };
        agent.addMessage(answer);
        filedAt.set(answer.id, new Date().toISOString());
        options.hub.event(threadId, turn.id, {
          type: "TOOL_CALL_RESULT",
          messageId: answer.id,
          toolCallId: callId,
          content: answer.content,
          role: "tool",
        } as BaseEvent);
        await persistNow();
      }

      endsAt = Date.now() + timeoutMs;
      await runTurnLoop(agent, {
        tools: toolkit.tools,
        execute: toolkit.execute,
        timeoutMs,
        maxSteps,
        /*
         * What the window's CopilotKit properties carried: the device's clock and language. And
         * what this turn's listing counted and could not list — the tools that wait for review and
         * are offered under no name (`ChatToolkit.withheld`), for the context layer to say
         * (`copilot.ts`). Beside the tools, never among them: the tool list is the head of the
         * prompt.
         */
        forwardedProps: {
          ...(input.device === undefined ? {} : { device: input.device }),
          ...withheldToolsForwarded(toolkit.withheld),
        },
        /*
         * Each run of the model under the turn's own id, so the `model.usage` rows it writes are
         * the ledger's turn's (a reader joins on the part before the dot, as `insights/read.ts`
         * did until it went on 2026-10-06). The first run is the turn's id itself; the rest are
         * numbered after it.
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
          options.hub.messages(threadId, turn.id, stepsSoFar());
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
    /*
     * THE RUN IS SAID TO BE OVER BEFORE THE BOT IS ANYBODY ELSE'S, AND BEFORE THE CONVERSATION IS
     * FREE. A value put into the Bot's browser for a person is held, and its tab kept, for the
     * length of the run (`computer/gateway/secrets.ts`). Told of the end only once the next run had
     * the Bot, the computer would close the tab that run was already working in — or let go of a
     * value that run had just had put in. Only here: a turn that never got this far put nothing in.
     */
    await options.runEnded?.({ botId, threadId }).catch((error: unknown) => {
      log.warn("turn_end_not_told", { reason: describeFailure(error) });
    });
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
      /*
       * AND NONE OF A DELEGATED RUN'S. Its calls are not the Bot's to be handed back, so no
       * provider would refuse the thread for one left open — but a window draws a call with no
       * answer as a step still going, and this one's turn is over.
       */
      for (const run of beside) {
        const done = new Set(
          run.messages
            .filter((message) => message.role === "tool")
            .map((message) => (message as { toolCallId: string }).toolCallId),
        );
        for (const message of [...run.messages]) {
          if (message.role !== "assistant") continue;
          for (const call of message.toolCalls ?? []) {
            if (done.has(call.id)) continue;
            const result = {
              id: randomUUID(),
              role: "tool" as const,
              toolCallId: call.id,
              content: stopped
                ? outcomeContent(STOPPED_RESULT)
                : arrivedWhole(call.function.arguments)
                  ? UNANSWERED_RESULT
                  : streamCutResult(),
              lafDelegated: run.callId,
            };
            run.messages.push(result);
            filedAt.set(result.id, new Date().toISOString());
            options.hub.event(threadId, turn.id, {
              type: "TOOL_CALL_RESULT",
              messageId: result.id,
              toolCallId: call.id,
              content: result.content,
              role: "tool",
            } as BaseEvent);
            done.add(call.id);
          }
        }
      }
    }
    delete turn.flush;
    if (target) {
      options.hub.messages(threadId, turn.id, transcript());
      const written = await persistEnd(threadId, turn.id, turnMessages);
      // Not a stop's to report, and not over the top of a failure that already has its name.
      if (!written && !stopped && failure === null) {
        failure = TURN_FAILURE_CODES.unknown;
      }
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
      /*
       * ACCEPTED NOW: the moment the wait to the first sign and to the first word is counted from
       * (`telemetry/run-meter.ts`). The engine has been handed what the person said, and nothing
       * has been checked or written yet — the admission asked about, the ledger row opened, the
       * message filed are all time the person is already waiting. ONLY THOSE TWO start here. What
       * was measured before they existed (`queuedMs`, `totalMs`) starts where it always did, with
       * the meter `run` makes: a number somebody compares from one release to the next does not
       * move because another was added beside it. What is still before this is not the engine's
       * to see: the request's own journey, and the route's reads of whose conversation and whose
       * Bot this is (`routes.ts`).
       */
      const acceptedAt = now();
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
      /*
       * ENDED WHEN IT HAS ENDED, FROM THE MOMENT IT IS LISTED (2026-09-27 code sprint). `ended` used to
       * be an already-resolved promise until the run was started, two awaits later — so `stopFor`
       * (an account's deletion) aborted a turn still writing its first rows and went straight on,
       * and those rows landed in a thread being deleted.
       */
      let finished: () => void = () => {};
      const ended = new Promise<void>((resolve) => {
        finished = resolve;
      });
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
        ended,
      };
      // Re-checked after every await below: a second send can arrive while this one is writing.
      if (live.has(input.threadId)) {
        return { ok: false, code: "laf:turn_in_progress" };
      }
      live.set(input.threadId, turn);
      unfinished.add(turn);
      void ended.then(() => unfinished.delete(turn));
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
        finished();
        /*
         * The row `begin` wrote is settled, not left `running` until the next boot calls it
         * unknown (2026-09-27 code sprint). A failed settle is only logged: the send has already
         * failed, and the error the caller sees is the one that did it.
         */
        await options.ledger
          .settle(turnId, {
            status: "error",
            error: "laf:turn_failed",
            eventCount: 0,
          })
          .catch((settling: unknown) => {
            log.warn("turn_setup_not_settled", {
              thread: input.threadId,
              reason: describeFailure(settling),
            });
          });
        throw error;
      }
      const asked = input.messages;
      /*
       * The turn first, then what it holds (2026-09-27 code sprint). `announceTurn` names a new turn
       * id, and the hub starts a new turn by clearing what it was watching — so watching first and
       * announcing after handed a window that joined while this turn was queued an empty snapshot.
       */
      announceTurn(turn, "queued");
      options.hub.watchLive(input.threadId, () => [...asked]);
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
      void run(turn, input, acceptedAt)
        .catch((error: unknown) => {
          log.error("turn_crashed", { reason: describeFailure(error) });
        })
        .finally(() => {
          turn.free();
          finished();
        });
      return { ok: true, turnId };
    },

    /** Stop the conversation's turn, from any window. False when there is none. */
    /**
     * Write what every live turn has made so far, and wait for it.
     *
     * FOR THE MOMENT BEFORE THE PROCESS LEAVES. Every upgrade restarts this server, and SIGTERM
     * used to be `process.exit` on the same tick: a step already on somebody's screen, its write
     * still in flight, went with the process, and so did the part of an answer that had streamed
     * (refactoring review, 2026-10-02). The turns themselves are not finished or resumed — the next
     * boot reconciles them as interrupted, as it always did, and the next send repairs a call left
     * unanswered (`repairUnanswered`, half a call included) — but what they had made is in the
     * thread when it does.
     */
    async flush(): Promise<void> {
      await Promise.allSettled(
        [...live.values()].map((turn) => turn.flush?.() ?? Promise.resolve()),
      );
    },

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
      // Aborting one that has already left `live` does nothing: it is past everything that listens.
      const theirs = [...unfinished].filter((turn) => turn.ownerId === userId);
      for (const turn of theirs) turn.stop.abort();
      await Promise.all(theirs.map((turn) => turn.ended));
    },

    /**
     * Stop this conversation's turn and wait until it has written its end. What a project's
     * deletion does before it removes the thread's rows (`channels/deleting.ts`): `stop` only asks,
     * and a turn asked to stop goes on writing until it has.
     */
    async stopThread(threadId: string): Promise<void> {
      /*
       * All of them, not one: the turn that has left `live` and is still writing its end, and the
       * one a window started the instant it heard the conversation was free.
       */
      const theirs = [...unfinished].filter(
        (turn) => turn.threadId === threadId,
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
