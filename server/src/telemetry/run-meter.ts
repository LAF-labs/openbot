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
 * list, and the numbers `laf.model.usage` carries — that is the whole input. What leaves is numbers
 * and two flags, so the columns it lands in cannot hold what anybody typed.
 */
import type { BaseEvent } from "@ag-ui/client";
import { COMPUTER_TOOLS } from "../../../shared/tools/computer";
import { modelUsageOf } from "../usage/model-usage";

export type RunMeasure = {
  /** Accepted → the Bot's service said it started (`RUN_STARTED`). Null when it never did. */
  queuedMs: number | null;
  /** Started → the model's first output: text, or a tool call. Null when there was none. */
  firstTokenMs: number | null;
  /** First output → the stream ended. Null when there was no output. */
  streamMs: number | null;
  /** Accepted → the stream ended. */
  totalMs: number;
  /** Requests the model answered: one `laf.model.usage` per request, a retried empty one included. */
  modelRequests: number;
  /** Tool calls the model made. */
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

export type RunMeter = {
  observe(event: BaseEvent): void;
  /** The stream ended. The first call counts; a later one changes nothing. */
  end(): void;
  read(): RunMeasure;
};

const elapsed = (from: number | null, to: number | null) =>
  from === null || to === null ? null : Math.max(0, Math.round(to - from));

/**
 * A meter started now — the moment the run was accepted, which is what "queued" means.
 *
 * `now` is injectable so a test can say how long each part took without waiting for it.
 */
export function createRunMeter(now: () => number = Date.now): RunMeter {
  const queuedAt = now();
  let startedAt: number | null = null;
  let firstOutputAt: number | null = null;
  let endedAt: number | null = null;
  let modelRequests = 0;
  let toolCalls = 0;
  let retries = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let personNeeded = false;
  let emptyAnswer = false;

  return {
    observe(event) {
      const type = String(event.type);
      if (type === "RUN_STARTED") {
        // A routine asks the model once per step, and each step starts a run: the first is the one.
        startedAt ??= now();
        return;
      }
      if (OUTPUT_EVENTS.has(type)) {
        firstOutputAt ??= now();
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

    end() {
      endedAt ??= now();
    },

    read() {
      const ended = endedAt ?? now();
      return {
        queuedMs: elapsed(queuedAt, startedAt),
        firstTokenMs: elapsed(startedAt ?? queuedAt, firstOutputAt),
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
      };
    },
  };
}
