import { describe, expect, test } from "bun:test";
import { fridaysMeantThisWeek } from "../evals/scenarios";

describe("this-weeks-friday grades against the calendar a person means", () => {
  test("on a weekday there is one Friday", () => {
    // Tuesday 2026-09-22, 10:00 KST.
    expect(
      fridaysMeantThisWeek(new Date("2026-09-22T01:00:00Z"), "Asia/Seoul"),
    ).toEqual([{ month: 9, day: 25 }]);
  });

  test("on a Sunday both the Friday just gone and the coming one are honest answers", () => {
    // Sunday 2026-09-27, 01:23 KST — when the eval's one miss was graded against 9/25 alone.
    expect(
      fridaysMeantThisWeek(new Date("2026-09-26T16:23:00Z"), "Asia/Seoul"),
    ).toEqual([
      { month: 9, day: 25 },
      { month: 10, day: 2 },
    ]);
  });

  test("the weekday is Seoul's, not the machine's: Saturday 23:30 UTC is already Sunday there", () => {
    expect(
      fridaysMeantThisWeek(new Date("2026-09-26T23:30:00Z"), "Asia/Seoul"),
    ).toEqual([
      { month: 9, day: 25 },
      { month: 10, day: 2 },
    ]);
  });
});
