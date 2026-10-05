/**
 * What one run measured, from the events it produced: times and counts, never words.
 *
 * WHY. Nothing measured whether the Bot succeeded for a real owner, or how long it took to answer
 * (team-lead plan 2026-09-26, Tech §1; teardown G3). The ledger row every run already writes was the
 * one record every path shares, so this feeds it: the chat runner and the routine loop each hand
 * every event of a run to a meter, and the ledger writes what the meter read (`run-ledger.ts`).
 *
 * NOT THE `copilot.ts` SUBSCRIBER, though every run passes it. That seam keys each run by AG-UI's
 * `runId`, and a routine asks the model once per step with a fresh one, none of them the ledger's.
 * The two writers are where the ledger's id and the events meet.
 *
 * NOTHING HERE READS A WORD. An event's type, a tool's name checked against the catalogue's closed
 * list, and the numbers `laf.model.usage` carries — that is the whole input, but for one look: a
 * text delta is asked whether there is anything in it to draw (`draws`), and nothing of it is
 * kept. What leaves is numbers, two flags and, for a turn's first move, words from two closed
 * lists — so the columns it lands in cannot hold what anybody typed.
 */
import type { BaseEvent } from "@ag-ui/client";
import type {
  FirstMoveEnding,
  FirstMoveKind,
} from "../../../shared/first-move";
import { COMPUTER_TOOLS } from "../../../shared/tools/computer";
import { modelUsageOf } from "../usage/model-usage";

/**
 * A turn's first move (`turns/first-move.ts`), as its own measure keeps it: which kinds the
 * decisions model was asked about, what came of asking, and what the two halves cost the person
 * waiting. Until 2026-10-05 this time was inside `queuedMs` with no name, and whether a move was
 * made was only in the trail.
 */
export type FirstMoveMeasure = {
  /** The kinds the decisions model was asked about in its one request. */
  asked: readonly FirstMoveKind[];
  verdict: FirstMoveEnding;
  /** The kind whose call the server made. Null unless the verdict is `moved`. */
  kind: FirstMoveKind | null;
  /**
   * How long the turn waited to learn whether it opens with a move: the words checked, the
   * person's connections read, the day's budget asked about and the decisions model's answer —
   * all of it, since all of it is before the Bot's model is asked.
   */
  decisionMs: number;
  /**
   * The move's call, from leaving to whatever came back: an answer, a refusal, a stop that landed
   * while it was out, a throw. Null on every other verdict, and on a `moved` whose call NEVER
   * LEFT — the person stopped the turn while the decision was out. The verdict is `moved` there
   * all the same: the trail's `turn.first_move` row is written when the decision is made, before
   * the turn has looked at the stop, and the row says what the trail says.
   */
  callMs: number | null;
};

export type RunMeasure = {
  /** Accepted → the Bot's service said it started (`RUN_STARTED`). Null when it never did. */
  queuedMs: number | null;
  /** Started → the model's first output: text, or a tool call. Null when there was none. */
  firstTokenMs: number | null;
  /*
   * THREE FIRSTS, AND THEY ARE THREE NUMBERS (2026-10-05). `firstTokenMs` above was the only one,
   * and it is neither of the two a person has: timing two products by the window that afternoon
   * took a stopwatch, because nothing here ran from the message to the first word.
   *
   *   firstTokenMs  started → the MODEL's first output, a tool call counting as much as a word.
   *                 From the Bot's service saying it began, so the queue, the turn's setup and a
   *                 first move are all before it. What the model's endpoint costs; the fleet's
   *                 `firstAnswer` adds `queuedMs` to it.
   *   firstSignMs   accepted → the first thing a window can DRAW for the run at all: a step's
   *                 line — a call the model made, or the first move the server made for it — or a
   *                 word. With a move it is early: the step goes out before the model is asked.
   *   firstWordMs   accepted → the first WORD of the answer: a text delta with something in it.
   *                 What somebody holding a stopwatch to the window reads — ALL of it, the
   *                 person's own time included. A turn that asks them something before it has
   *                 said a word (an approval, a take-over, a value to type, a card) has the
   *                 minutes they took to answer in this number; whoever reads it as the Bot's
   *                 speed leaves such turns out, as far as the row can tell them
   *                 (`insights/turns.ts`).
   *
   * TWO ORIGINS, ON PURPOSE. The two new firsts start when the run was ACCEPTED: for a
   * conversation, the engine being handed what the person said (`turns/engine.ts`, `send`),
   * before the message is checked or written. Everything measured before they existed —
   * `queuedMs`, `totalMs`, and through `queuedMs` the fleet's `firstAnswer` — starts where it
   * always did, when the meter is made: for a conversation that is the turn's run beginning,
   * after the message is written, and it is what those fields' own lines call "accepted". A
   * series somebody compares across releases must not move because a column was added beside it.
   * So `firstSignMs` is NOT `queuedMs + firstTokenMs`, even with no first move: it is longer by
   * what the engine did before the run began. The runner's meter and a routine's are made at
   * acceptance and have the one origin. Nobody waits on a routine's first word; its row carries
   * these because they cost nothing to read off the same events, and the report reads
   * conversations only.
   */
  /** Accepted → the first step's line or the first word. Null when the run drew neither. */
  firstSignMs: number | null;
  /** Accepted → the first word of the answer. Null when the run said none. */
  firstWordMs: number | null;
  /** First output → the stream ended. Null when there was no output. */
  streamMs: number | null;
  /** Accepted → the stream ended. */
  totalMs: number;
  /** Requests the model answered: one `laf.model.usage` per request, a retried empty one included. */
  modelRequests: number;
  /**
   * Tool calls the model made. A turn's first move is a call the SERVER made for it, and is not
   * counted here: it is `firstMove`, and the model's own calls stay comparable turn to turn.
   */
  toolCalls: number;
  /** Requests the Bot's service sent again (`laf.retry`): a dropped connection, an empty answer. */
  retries: number;
  promptTokens: number;
  cachedTokens: number;
  costUsd: number;
  /** A call that hands the wheel to the person was made (`needsPerson` in the catalogue). */
  personNeeded: boolean;
  /** The model came back empty even when asked again (`laf.empty_answer`). */
  emptyAnswer: boolean;
  /** The turn's first move, when the decisions model was asked about one. Null for any other run. */
  firstMove: FirstMoveMeasure | null;
};

/** The tools whose step is the person's to take: a login, a password typed where the Bot can't see. */
const PERSON_TOOLS: ReadonlySet<string> = new Set(
  COMPUTER_TOOLS.filter((tool) => tool.needsPerson === true).map(
    (tool) => tool.name,
  ),
);

/** The events that are the model producing something a surface can draw. */
const OUTPUT_EVENTS: ReadonlySet<string> = new Set([
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_CHUNK",
  "TOOL_CALL_START",
  "TOOL_CALL_CHUNK",
]);

/**
 * Whether a text delta has anything in it for a window to draw.
 *
 * The one look this module takes at something a person could read, and it keeps none of it. A
 * model that opens its answer on a blank line has not said a word yet, and the window draws
 * nothing for one — so `firstWordMs` waits for a delta that is not all white space.
 */
const draws = (delta: unknown): boolean =>
  typeof delta === "string" && /\S/.test(delta);

export type RunMeter = {
  observe(event: BaseEvent): void;
  /**
   * A step the server itself put in front of the person went out to the windows: the call of a
   * turn's first move, which no event of the Bot's carries. The run's first sign, if it had none.
   */
  stepSent(): void;
  /** What came of asking about the turn's first move, and how long the turn waited to know. */
  firstMove(decided: Omit<FirstMoveMeasure, "callMs">): void;
  /** The first move's call came back, this long after it left. Nothing without a first move. */
  firstMoveCalled(ms: number): void;
  /** The stream ended. The first call counts; a later one changes nothing. */
  end(): void;
  read(): RunMeasure;
};

const elapsed = (from: number | null, to: number | null) =>
  from === null || to === null ? null : Math.max(0, Math.round(to - from));

/**
 * A meter started now — the moment the run begins to be measured, which is where "queued" starts.
 *
 * `acceptedAt` is when the run was accepted, for a caller that was handed it before the meter
 * could be made: the first sign and the first word are counted from it, and nothing else is (see
 * `RunMeasure`, "two origins"). Left out, the run was accepted now.
 *
 * `now` is injectable so a test can say how long each part took without waiting for it.
 */
export function createRunMeter(
  now: () => number = Date.now,
  acceptedAt?: number,
): RunMeter {
  const queuedAt = now();
  const accepted = acceptedAt ?? queuedAt;
  let startedAt: number | null = null;
  let firstOutputAt: number | null = null;
  let firstSignAt: number | null = null;
  let firstWordAt: number | null = null;
  let endedAt: number | null = null;
  let modelRequests = 0;
  let toolCalls = 0;
  let retries = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let personNeeded = false;
  let emptyAnswer = false;
  let firstMove: FirstMoveMeasure | null = null;

  return {
    observe(event) {
      const type = String(event.type);
      if (type === "RUN_STARTED") {
        // A routine asks the model once per step, and each step starts a run: the first is the one.
        startedAt ??= now();
        return;
      }
      if (OUTPUT_EVENTS.has(type)) {
        /*
         * THE CLOCK IS READ ONLY FOR AN EVENT THAT STAMPS SOMETHING, and once for it, so the
         * firsts one event sets agree to the millisecond. An answer is thousands of deltas: after
         * its first word each of them costs the comparison below and nothing more — no clock, and
         * no look at the delta.
         */
        if (firstWordAt === null) {
          const call = type === "TOOL_CALL_START" || type === "TOOL_CALL_CHUNK";
          const word = !call && draws((event as { delta?: unknown }).delta);
          if (
            firstOutputAt === null ||
            word ||
            (call && firstSignAt === null)
          ) {
            const at = now();
            firstOutputAt ??= at;
            // A call's line is drawn from its start, before any of its arguments have arrived.
            if (call || word) firstSignAt ??= at;
            if (word) firstWordAt = at;
          }
        }
        if (type === "TOOL_CALL_START") {
          toolCalls += 1;
          const name = (event as { toolCallName?: unknown }).toolCallName;
          if (typeof name === "string" && PERSON_TOOLS.has(name)) {
            personNeeded = true;
          }
        }
        return;
      }
      if (type !== "CUSTOM") return;
      const custom = event as BaseEvent & { name?: unknown };
      if (custom.name === "laf.retry") retries += 1;
      else if (custom.name === "laf.empty_answer") emptyAnswer = true;
      for (const usage of modelUsageOf([event])) {
        modelRequests += 1;
        promptTokens += usage.promptTokens;
        cachedTokens += usage.cachedPromptTokens ?? 0;
        costUsd += usage.costUsd ?? 0;
      }
    },

    /*
     * NOT AN OUTPUT OF THE MODEL'S, so `firstOutputAt` is left alone: the Bot's service has not
     * started yet when a first move's step goes out, and `firstTokenMs` — started → the model's
     * first output — would read zero, and `streamMs` would count the model's whole wait as stream.
     */
    stepSent() {
      firstSignAt ??= now();
    },

    firstMove(decided) {
      firstMove = { ...decided, asked: [...decided.asked], callMs: null };
    },

    firstMoveCalled(ms) {
      if (firstMove) firstMove = { ...firstMove, callMs: ms };
    },

    end() {
      endedAt ??= now();
    },

    read() {
      const ended = endedAt ?? now();
      return {
        queuedMs: elapsed(queuedAt, startedAt),
        firstTokenMs: elapsed(startedAt ?? queuedAt, firstOutputAt),
        firstSignMs: elapsed(accepted, firstSignAt),
        firstWordMs: elapsed(accepted, firstWordAt),
        streamMs: elapsed(firstOutputAt, ended),
        totalMs: elapsed(queuedAt, ended) ?? 0,
        modelRequests,
        toolCalls,
        retries,
        promptTokens,
        cachedTokens,
        costUsd,
        personNeeded,
        emptyAnswer,
        firstMove: firstMove
          ? { ...firstMove, asked: [...firstMove.asked] }
          : null,
      };
    },
  };
}
