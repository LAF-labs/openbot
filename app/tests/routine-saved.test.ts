import { describe, expect, test } from "bun:test";
import {
  routineSavedText,
  TOOL_RESULT_KO,
} from "../../shared/prompt/tool-results.ko";

/**
 * What a Bot is told when it has saved a routine. Audit 2026-09-16, R2 F1.
 *
 * It was told "루틴을 저장했다" and nothing else, while a daily schedule with no zone was being stored
 * as UTC: "매일 7시 반" ran at 16:30 in Seoul and the Bot said it was done. The server fills the
 * deployment's zone in now, and the tool result says the schedule back as the server STORED it —
 * the time, the days and the zone — so the Bot can repeat it and a wrong one is caught in the same
 * conversation instead of the next morning.
 *
 * The sentence is here; that a save answers with it, from the row and not from the request, is
 * `server/tests/chat-tools.test.ts`, where the call is carried out.
 */

/** The schedule half of a routine row, as `POST /api/routines` answers it. */
const daily = (
  days: number[] | null,
  timeZone: string | null = "Asia/Seoul",
) => ({
  scheduleKind: "daily",
  intervalMinutes: null,
  dailyLocal: "07:30",
  dailyTimeZone: timeZone,
  dailyDays: days,
});

describe("the saved schedule, in the model's words", () => {
  test("a daily routine names its time, every day, and its zone", () => {
    const said = routineSavedText(daily([]));
    expect(said).toContain("매일 07:30");
    expect(said).toContain("Asia/Seoul");
    // What the Bot is to do with it: say it back, and put it right if it is not what was asked.
    expect(said).toContain("그대로 말해");
  });

  test("restricted days are named in week order, whatever order they were stored in", () => {
    expect(routineSavedText(daily([5, 1, 3]))).toContain("매주 월·수·금 07:30");
    expect(routineSavedText(daily([0, 6]))).toContain("매주 일·토 07:30");
  });

  test("all seven days, or none, is every day", () => {
    for (const days of [[], null, [0, 1, 2, 3, 4, 5, 6]]) {
      expect(routineSavedText(daily(days))).toContain("매일 07:30");
    }
  });

  test("a row from before zones is said as UTC, because that is the clock it runs on", () => {
    expect(routineSavedText(daily([], null))).toContain("UTC");
  });

  test("an interval says how often, and no zone", () => {
    const said = routineSavedText({
      scheduleKind: "interval",
      intervalMinutes: 30,
      dailyLocal: null,
      dailyTimeZone: null,
      dailyDays: null,
    });
    expect(said).toContain("저장된 일정: 30분마다.");
    expect(said).not.toContain("(시간대");
  });

  test("a reply it cannot read is not turned into a schedule", () => {
    /*
     * A schedule the Bot repeats to a person has to be the stored one or nothing. A body with no
     * routine, a time that is not HH:MM or a day list that is not one gets the sentence that says
     * the schedule could not be read — never "매일", which is what a missing day list would
     * otherwise look like.
     */
    const unread = TOOL_RESULT_KO["laf:routine_saved_unread"];
    expect(unread).toBeDefined();
    for (const reply of [
      undefined,
      null,
      "saved",
      {},
      { ...daily([]), dailyLocal: 730 },
      { ...daily([]), dailyLocal: "7:30" },
      { ...daily([]), dailyDays: { 0: 1 } },
      { ...daily([]), dailyDays: [7] },
      { ...daily([]), dailyTimeZone: 9 },
      { ...daily([]), scheduleKind: "weekly" },
      { scheduleKind: "interval", intervalMinutes: "30" },
    ]) {
      expect({ reply, said: routineSavedText(reply) }).toEqual({
        reply,
        said: unread as string,
      });
    }
  });

  test("no placeholder reaches the model", () => {
    for (const said of [
      routineSavedText(daily([1, 2, 3, 4, 5])),
      routineSavedText({ scheduleKind: "interval", intervalMinutes: 5 }),
      routineSavedText(null),
    ]) {
      expect(said).not.toMatch(/[{}]/);
      expect(said).not.toContain("laf:");
    }
  });
});
