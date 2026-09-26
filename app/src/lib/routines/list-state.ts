import {
  liveTurnFailureCode,
  turnFailureSentence,
} from "@/lib/channels/turn-failure";
import { t } from "@/lib/i18n";
import { type ReadLine, readLineOf } from "@/lib/read-line";
import { type Reading, settledOf } from "@/lib/reading";
import type { Routine, RoutineRun } from "@/lib/routines/queries";
import { RUN_STOPPED } from "@/lib/work/stop-all";

/**
 * WHAT THE ROUTINES PAGE SAYS ABOUT ITS LIST AND ITS RUNS, DECIDED OUT OF THE JSX.
 *
 * The page used to decide inline, branch by branch, which is how it came to draw a red "could not
 * be loaded" over rows it was still showing, and how a failed run's line came to be whatever the
 * server had written — `its stream ended before the run finished`, or a `laf:` code — on a Korean
 * screen. Pure functions over the facts, the way `lib/channels/turn-failure.ts` decides a failed
 * turn's sentence, so each case can be pinned without drawing anything (`routine-list-state.test.ts`).
 */

/** What the list area draws: rows, placeholders, one line about them, and "none yet". */
export type RoutineListView = {
  /** The routines to draw — the answer, or the answer from before when refreshing it failed. */
  rows: Routine[];
  isLoading: boolean;
  /** The line the list says besides its rows, for its `ReadNotice`. */
  notice: ReadLine;
  /** "None yet", said once the answer is in. */
  empty: string | null;
};

export function routineListView(
  reading: Reading<Routine[]>,
  { isCreating }: { isCreating: boolean },
): RoutineListView {
  return {
    rows: settledOf(reading)?.data ?? [],
    isLoading: reading.state === "loading",
    notice: readLineOf(reading, {
      failed: t("Your routines could not be loaded."),
      notHere: t("Routines are not offered here."),
    }),
    /*
     * Not while the form for the first one is open beside it: "none yet" next to the routine
     * somebody is writing is a sentence arguing with them. And not over a list that could not be
     * refreshed — that one was empty when it was read, and the notice says the rest.
     */
    empty:
      reading.state === "empty" && !isCreating
        ? t("No routines yet. Give a Bot something to do every morning.")
        : null,
  };
}

/**
 * A run that stopped for a question only the person can answer, as its receipt records it
 * (`server/src/runner/unattended.ts`, `AWAITING_APPROVAL`). A code, so the words are ours.
 */
export const AWAITING_APPROVAL = "laf:awaiting_approval";

/**
 * A run whose routine was switched off under it — waiting its turn, or already going — as its receipt
 * records it (`server/src/routines/settlement.ts`, `RUN_SWITCHED_OFF`). A stop, and not one
 * anybody made with 모두 멈추기.
 */
export const RUN_SWITCHED_OFF = "laf:run_switched_off";

/** How one run ended, as its row in the history says it. */
export type RunOutcome = {
  label: string;
  /** Only a failure is drawn in the destructive colour; a stop somebody asked for is not one. */
  tone: "done" | "waiting" | "stopped" | "failed";
  /** The answer, or what went wrong — in this surface's words, never the server's. */
  text: string;
};

/**
 * A run's row, from its receipt.
 *
 * A FAILED RUN'S REASON IS A FACT TO LOOK UP, NOT A SENTENCE TO PRINT. The receipt carries what the
 * run failed with — a Bot's `laf:` code, or the runner's own English ("its stream ended before the
 * run finished") — and the row printed it as it came. It goes through the same classifier and the
 * same sentences a failed turn in a conversation does, so the two say one thing about one fact.
 * A stop is its own fact (`RUN_STOPPED`), and not a failure.
 */
export function runOutcome(run: RoutineRun): RunOutcome {
  /*
   * STOPPED FOR THE PERSON'S YES. The run worked — finding out was its job — and its answer says
   * so in the Bot's own words. The receipt used to carry that in the answer as a line the server
   * appended, and the line was the instruction written for the model; now it is a fact, and this is
   * the sentence for it. The question itself reaches the person through its own notification.
   */
  if (run.ok && run.awaiting === AWAITING_APPROVAL) {
    return {
      label: t("Needs your yes"),
      tone: "waiting",
      text: run.answer?.trim()
        ? run.answer
        : t("It stopped at a step that needs your yes."),
    };
  }
  if (run.ok) {
    return { label: t("Ran"), tone: "done", text: run.answer ?? "" };
  }
  if (run.error === RUN_SWITCHED_OFF) {
    return {
      label: t("Stopped"),
      tone: "stopped",
      text: t("The routine was switched off before this run finished."),
    };
  }
  if (run.error === RUN_STOPPED) {
    return {
      label: t("Stopped"),
      tone: "stopped",
      text: t("It was stopped with Stop everything."),
    };
  }
  return {
    label: t("Failed"),
    tone: "failed",
    text: turnFailureSentence(liveTurnFailureCode(run.error)),
  };
}
