/**
 * How a run ended, for the owner's reading of it: 끝남, 못 끝냄, 멈춤, or 사장님 차례.
 *
 * The ledger's `status` says what happened to the STREAM — it finished, it errored, somebody stopped
 * it, its step is with a window. That is the machine's account, and it cannot answer the one
 * question the weekly report asks: did the Bot get the owner's errand done? A step that never came
 * back is `stopped` either way, and it is a failure when the window just closed and nobody's fault
 * but the owner's when it was waiting on their 허용. So the ending is read here, from the status and
 * the facts the ledger has beside it, and a reason code rides with it.
 *
 * The words are the surface's (and laf-control's); these are the codes. A code is `laf:` and a closed
 * shape, never an error's text: `codeOf` matches the shape out of the text and throws the rest away.
 */

/**
 * Why a run that handed a step to a window was recorded `stopped` without anybody pressing Stop:
 * the step never came back — its window closed, or the person said something new instead.
 *
 * Defined here, where its ending is decided, and re-exported by `runner/laf-runner.ts`, which writes
 * it: the ledger reads this module, and the runner reads the ledger.
 */
export const STEP_NOT_RETURNED = "laf:step_not_returned";

/** 끝남 / 못 끝냄 / 멈춤 / 사장님 차례, in the order the report lists them. */
export const RUN_ENDINGS = [
  "finished",
  "unfinished",
  "stopped",
  "owner",
] as const;
export type RunEnding = (typeof RUN_ENDINGS)[number];

/** The one shape a code takes; the fleet's reader matches the same (`insights/read.ts`). */
export const ENDING_CODE_SOURCE = "^laf:[a-z0-9_]{1,60}$";
const CODE_IN_TEXT = /laf:[a-z0-9_]{1,60}/;

/** A step handed to a window whose tool hands the wheel to the person. Provisional: see `endingOf`. */
export const WITH_PERSON = "laf:with_person";
/** A step handed to a window for the window to run. Provisional. */
export const WITH_WINDOW = "laf:with_window";

export const ENDING_CODES = {
  stopped: "laf:run_stopped",
  approvalUnanswered: "laf:approval_unanswered",
  personNeeded: "laf:person_needed",
  emptyAnswer: "laf:empty_answer",
  unreachable: "laf:agent_unreachable",
  deadline: "laf:run_deadline",
  streamEnded: "laf:stream_ended",
  interrupted: "laf:turn_interrupted",
  uncoded: "laf:uncoded",
} as const;

/**
 * The reason code in a failure's text, or the class the text belongs to.
 *
 * The Bot's own service already fails with codes (`agent-bot/src/log.ts` `runErrorCodeOf`), and the
 * routine loop wraps them in a sentence; those are matched out. What is left is a transport failing
 * underneath — the Bot's service not there at all — and a deadline, each a class of its own, because
 * "the Bot's service is down" and "the model refused" want opposite reactions from an operator.
 */
export function codeOf(error: string | null | undefined): string | null {
  if (!error) return null;
  const coded = CODE_IN_TEXT.exec(error)?.[0];
  if (coded) return coded;
  if (
    /ECONNREFUSED|ECONNRESET|ConnectionRefused|fetch failed|Unable to connect|socket connection was closed|network error/i.test(
      error,
    )
  ) {
    return ENDING_CODES.unreachable;
  }
  if (/did not finish in time|timed out|deadline/i.test(error)) {
    return ENDING_CODES.deadline;
  }
  if (/stream ended before/i.test(error)) return ENDING_CODES.streamEnded;
  return ENDING_CODES.uncoded;
}

export type EndingFacts = {
  status: "done" | "error" | "stopped" | "waiting";
  error: string | null;
  /** The run, or the step it handed over, was one only the person can take. */
  personNeeded: boolean;
  /** The model came back empty twice. */
  emptyAnswer: boolean;
  /** A routine that stopped because a person has to answer something. */
  awaiting: boolean;
  /** Questions asked in this turn that nobody has answered, or null when that could not be read. */
  approvalsOpen: number | null;
};

/**
 * The ending, or null for a run whose step is still with a window.
 *
 * A `waiting` run's code is provisional — whose the step is — because the ending that settles it
 * later is written with nothing but a status (`laf-runner.ts` `endStepWait`), and by then the only
 * place left to know that the step was the person's is this row.
 */
export function endingOf(facts: EndingFacts): {
  ending: RunEnding | null;
  code: string | null;
} {
  switch (facts.status) {
    case "waiting":
      return {
        ending: null,
        code: facts.personNeeded ? WITH_PERSON : WITH_WINDOW,
      };
    case "done":
      if (facts.awaiting) {
        return { ending: "owner", code: ENDING_CODES.approvalUnanswered };
      }
      if (facts.emptyAnswer) {
        return { ending: "unfinished", code: ENDING_CODES.emptyAnswer };
      }
      return { ending: "finished", code: null };
    case "error":
      return {
        ending: "unfinished",
        code: codeOf(facts.error) ?? ENDING_CODES.uncoded,
      };
    case "stopped":
      if (facts.error === STEP_NOT_RETURNED) {
        if ((facts.approvalsOpen ?? 0) > 0) {
          return { ending: "owner", code: ENDING_CODES.approvalUnanswered };
        }
        if (facts.personNeeded) {
          return { ending: "owner", code: ENDING_CODES.personNeeded };
        }
        return { ending: "unfinished", code: STEP_NOT_RETURNED };
      }
      return {
        ending: "stopped",
        code: codeOf(facts.error) ?? ENDING_CODES.stopped,
      };
  }
}
