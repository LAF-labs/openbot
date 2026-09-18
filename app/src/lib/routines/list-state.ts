import {
  liveTurnFailureCode,
  turnFailureSentence,
} from "@/lib/channels/turn-failure";
import { t } from "@/lib/i18n";
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

/** What the list area draws: rows, placeholders, and at most one line about them. */
export type RoutineListView = {
  /** The routines to draw — the answer, or the answer from before when refreshing it failed. */
  rows: Routine[];
  isLoading: boolean;
  line:
    | { kind: "failed"; text: string }
    | { kind: "stale"; isRetrying: boolean }
    | { kind: "unavailable"; why: "not_configured" | "not_allowed" }
    | { kind: "empty"; text: string }
    | null;
};

export function routineListView(
  reading: Reading<Routine[]>,
  { isCreating }: { isCreating: boolean },
): RoutineListView {
  const rows = settledOf(reading)?.data ?? [];
  switch (reading.state) {
    case "loading":
      return { rows, isLoading: true, line: null };
    case "unavailable":
      return {
        rows,
        isLoading: false,
        line: { kind: "unavailable", why: reading.why },
      };
    case "failed":
      return {
        rows,
        isLoading: false,
        line: reading.previous
          ? { kind: "stale", isRetrying: reading.isRetrying }
          : { kind: "failed", text: t("Your routines could not be loaded.") },
      };
    case "empty":
      /*
       * Not while the form for the first one is open beside it: "none yet" next to the routine
       * somebody is writing is a sentence arguing with them.
       */
      return {
        rows,
        isLoading: false,
        line: isCreating
          ? null
          : {
              kind: "empty",
              text: t(
                "No routines yet. Give a Bot something to do every morning.",
              ),
            },
      };
    case "ready":
      return { rows, isLoading: false, line: null };
  }
}

/** How one run ended, as its row in the history says it. */
export type RunOutcome = {
  label: string;
  /** Only a failure is drawn in the destructive colour; a stop somebody asked for is not one. */
  tone: "done" | "stopped" | "failed";
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
  if (run.ok) {
    return { label: t("Ran"), tone: "done", text: run.answer ?? "" };
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
