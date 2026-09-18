import { afterEach, describe, expect, test } from "bun:test";
import { parseTrial } from "../src/lib/auth/queries";
import {
  NOTICE_DISMISSED_KEY,
  noticeDue,
  readDismissedDay,
  seoulDayKey,
  usageOf,
  writeDismissedDay,
} from "../src/lib/usage/today";

/**
 * How much of a free trial's day is used, as the surface draws it.
 *
 * The server refuses a run once the day's budget is spent, and until now the surface said nothing
 * before that moment — a person learned how much was left by being refused. These pin the numbers
 * the Settings row and the notice above the composer draw, and the one rule the notice keeps: shown
 * from 80%, and once dismissed, gone for the rest of that SEOUL day, which is the day the server
 * counts — whatever this machine's clock says.
 */

const trial = (overrides: Record<string, unknown> = {}) => ({
  endsAt: "2026-09-29T14:59:59.999Z",
  holdDays: 30,
  dailyTokenBudget: 1_000_000,
  budgetReachedToday: false,
  tokensUsedToday: 250_000,
  ...overrides,
});

describe("what /api/me says today has used", () => {
  test("is carried beside the four facts", () => {
    expect(parseTrial(trial())).toMatchObject({ tokensUsedToday: 250_000 });
  });

  test("is left out when the server could not read it, and the trial still stands", () => {
    const { tokensUsedToday: _unread, ...withoutIt } = trial();
    const parsed = parseTrial(withoutIt);
    expect(parsed).toBeDefined();
    expect(parsed).not.toHaveProperty("tokensUsedToday");
  });

  test("a count that is not a count is not drawn", () => {
    for (const bad of ["250000", -5, Number.NaN, null]) {
      expect(parseTrial(trial({ tokensUsedToday: bad }))).not.toHaveProperty(
        "tokensUsedToday",
      );
    }
  });
});

describe("the share of today used", () => {
  test("is a whole percent, rounded down so it never says more than was used", () => {
    expect(usageOf(parseTrial(trial({ tokensUsedToday: 799_999 })))).toEqual({
      used: 799_999,
      budget: 1_000_000,
      ratio: 0.799999,
      percent: 79,
    });
  });

  test("stops at a hundred on a day that ran over", () => {
    // The budget is judged when a run starts, so the runs in flight can take a day past it.
    expect(
      usageOf(parseTrial(trial({ tokensUsedToday: 1_300_000 })))?.percent,
    ).toBe(100);
  });

  test("is nothing to draw without a trial, a count, or a budget", () => {
    expect(usageOf(undefined)).toBeNull();
    const { tokensUsedToday: _unread, ...unread } = trial();
    expect(usageOf(parseTrial(unread))).toBeNull();
    expect(usageOf(parseTrial(trial({ dailyTokenBudget: 0 })))).toBeNull();
  });
});

describe("the Seoul day", () => {
  test.each([
    ["2026-09-18T14:59:59.999Z", "2026-09-18"], // 23:59 in Seoul
    ["2026-09-18T15:00:00.000Z", "2026-09-19"], // midnight in Seoul, still the 18th in UTC
    ["2026-09-17T15:00:00.000Z", "2026-09-18"],
  ] as const)("at %s is %s", (now, day) => {
    expect(seoulDayKey(new Date(now))).toBe(day);
  });
});

describe("the notice above the composer", () => {
  const at = new Date("2026-09-18T03:00:00Z"); // noon in Seoul
  const used = (tokensUsedToday: number) =>
    usageOf(parseTrial(trial({ tokensUsedToday })));

  test("is shown from 80%, not before", () => {
    expect(noticeDue(used(799_999), null, at)).toBe(false);
    expect(noticeDue(used(800_000), null, at)).toBe(true);
    expect(noticeDue(used(1_000_000), null, at)).toBe(true);
    expect(noticeDue(null, null, at)).toBe(false);
  });

  test("dismissed, it stays away for the rest of that Seoul day and comes back the next", () => {
    expect(noticeDue(used(900_000), "2026-09-18", at)).toBe(false);
    // 00:00 in Seoul the next day; a day that is still above 80% says so again.
    expect(
      noticeDue(used(900_000), "2026-09-18", new Date("2026-09-18T15:00:00Z")),
    ).toBe(true);
  });
});

describe("where the dismissal is kept", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  function storage(behaviour: "works" | "throws") {
    const kept = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => {
          if (behaviour === "throws") throw new Error("SecurityError");
          return kept.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          if (behaviour === "throws") throw new Error("QuotaExceededError");
          kept.set(key, value);
        },
      },
    });
    return kept;
  }

  test("is this viewer's, per Seoul day", () => {
    const kept = storage("works");
    writeDismissedDay("2026-09-18");
    expect(kept.get(NOTICE_DISMISSED_KEY)).toBe("2026-09-18");
    expect(readDismissedDay()).toBe("2026-09-18");
  });

  test("a browser that refuses storage just shows the notice again, and never throws", () => {
    storage("throws");
    expect(() => writeDismissedDay("2026-09-18")).not.toThrow();
    expect(readDismissedDay()).toBeNull();
  });

  test("nothing stored, or something that is not a day, is not a dismissal", () => {
    const kept = storage("works");
    expect(readDismissedDay()).toBeNull();
    kept.set(NOTICE_DISMISSED_KEY, "yesterday");
    expect(readDismissedDay()).toBeNull();
  });
});
