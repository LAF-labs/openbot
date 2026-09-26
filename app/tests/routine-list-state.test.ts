import { describe, expect, test } from "bun:test";
import { ko } from "../src/lib/i18n-ko";
import type { Reading } from "../src/lib/reading";
import {
  AWAITING_APPROVAL,
  routineListView,
  runOutcome,
} from "../src/lib/routines/list-state";
import type { Routine, RoutineRun } from "../src/lib/routines/queries";
import { RUN_STOPPED } from "../src/lib/work/stop-all";

/**
 * THE ROUTINES PAGE'S WORDS, DECIDED FROM FACTS.
 *
 * What the list area draws and what a run's row says used to be decided inside the page's JSX,
 * which is how a failed refresh came to put a red alert over rows that were still there, and a
 * failed run's row came to print whatever the runner had written — English prose or a `laf:` code —
 * on a Korean screen. Pinned here as the pure functions they are now.
 */

const routine = (id: string): Routine => ({
  id,
  agentId: "agent-1",
  name: id,
  instruction: "오늘 날짜 알려줘",
  scheduleKind: "daily",
  intervalMinutes: null,
  dailyLocal: "09:00",
  dailyTimeZone: "Asia/Seoul",
  dailyDays: [],
  enabled: true,
  lastRunAt: null,
  nextRunAt: "2026-09-19T00:00:00.000Z",
});

const run = (overrides: Partial<RoutineRun>): RoutineRun => ({
  id: "run-1",
  startedAt: "2026-09-18T00:00:00.000Z",
  ok: false,
  answer: null,
  error: null,
  steps: null,
  ...overrides,
});

const view = (reading: Reading<Routine[]>, isCreating = false) =>
  routineListView(reading, { isCreating });

describe("the list area", () => {
  test("draws placeholders and says nothing while nothing has been read", () => {
    expect(view({ state: "loading" })).toEqual({
      rows: [],
      isLoading: true,
      notice: null,
      empty: null,
    });
  });

  test("keeps the rows when a refresh fails, and says so quietly instead of in red", () => {
    const rows = [routine("아침 점검")];
    expect(
      view({
        state: "failed",
        previous: { state: "ready", data: rows },
        isRetrying: false,
      }),
    ).toEqual({
      rows,
      isLoading: false,
      notice: { kind: "stale", isRetrying: false },
      empty: null,
    });
  });

  test("says it could not load when there is nothing to show, never that there are none", () => {
    const failed = view({ state: "failed", previous: null, isRetrying: false });
    expect(failed.rows).toEqual([]);
    expect(failed.notice).toEqual({
      kind: "failed",
      message: "Your routines could not be loaded.",
      isRetrying: false,
    });
    expect(failed.empty).toBeNull();
    expect(ko["Your routines could not be loaded."]).toBeTruthy();
  });

  test("offers nothing to press when this place has no routines at all", () => {
    expect(
      view({
        state: "unavailable",
        code: "laf:not_found",
        why: "not_configured",
      }),
    ).toEqual({
      rows: [],
      isLoading: false,
      notice: {
        kind: "unavailable",
        message: "Routines are not offered here.",
      },
      empty: null,
    });
  });

  test("says none yet only once the answer is in, and not beside the form for the first one", () => {
    expect(view({ state: "empty", data: [] }).empty).toBe(
      "No routines yet. Give a Bot something to do every morning.",
    );
    expect(view({ state: "empty", data: [] }, true).empty).toBeNull();
    // A list that was empty when it was read, and could not be read again, is not "none yet" now.
    expect(
      view({
        state: "failed",
        previous: { state: "empty", data: [] },
        isRetrying: false,
      }).empty,
    ).toBeNull();
  });
});

describe("a run's row", () => {
  test("a run that worked shows its answer", () => {
    expect(
      runOutcome(run({ ok: true, answer: "오늘은 9월 18일이에요." })),
    ).toEqual({
      label: "Ran",
      tone: "done",
      text: "오늘은 9월 18일이에요.",
    });
  });

  test("a run that stopped for the person's yes says so in the surface's words", () => {
    // The Bot's own words stand; the label is ours, from the receipt's fact.
    expect(
      runOutcome(
        run({
          ok: true,
          answer: "결제 버튼 앞에서 사장님 확인을 기다리고 있어요.",
          awaiting: AWAITING_APPROVAL,
        }),
      ),
    ).toEqual({
      label: "Needs your yes",
      tone: "waiting",
      text: "결제 버튼 앞에서 사장님 확인을 기다리고 있어요.",
    });
    // A Bot that said nothing still leaves a true sentence, never a blank row.
    const blank = runOutcome(
      run({ ok: true, answer: "", awaiting: AWAITING_APPROVAL }),
    );
    expect(blank.text).toBe("It stopped at a step that needs your yes.");
    expect(ko[blank.text]).toBeTruthy();
    expect(ko[blank.label]).toBeTruthy();
  });

  test("a run somebody stopped is a stop, not a failure", () => {
    expect(runOutcome(run({ error: RUN_STOPPED }))).toEqual({
      label: "Stopped",
      tone: "stopped",
      text: "It was stopped with Stop everything.",
    });
  });

  test("a failed run says what the failure means, never what the runner wrote", () => {
    // The runner's own English, recorded as the reason when a stream just ends.
    const cut = runOutcome(
      run({ error: "its stream ended before the run finished" }),
    );
    expect(cut.tone).toBe("failed");
    expect(cut.text).not.toContain("stream ended");
    expect(ko[cut.text]).toBeTruthy();

    // A Bot's fact code: the same sentence a failed turn in the conversation gets for it.
    const limited = runOutcome(run({ error: "laf:model_rate_limited" }));
    expect(limited.text).toBe(
      "Answers are coming faster than the model can take right now. Give it a moment and ask again.",
    );
    expect(limited.text).not.toContain("laf:");

    // A receipt with no reason at all still says something true.
    expect(runOutcome(run({ error: null })).text).toBe("No answer came back.");
  });
});
