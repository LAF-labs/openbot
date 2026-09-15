import { describe, expect, test } from "bun:test";
import { parseTrial } from "../src/lib/auth/queries";
import { ko } from "../src/lib/i18n-ko";
import {
  TRIAL_BANNER_SENTENCES,
  trialBannerLines,
  trialDaysLeft,
  trialEndDate,
} from "../src/components/layout/trial-banner";

/**
 * The line a trial counts down on, and the day it counts to.
 *
 * The fleet ends a trial at 23:59:59 in SEOUL on its last day (self-serve contract §9), and the
 * banner is the only countdown there is: no mail goes to a trial's owner. So the day it names must be
 * Seoul's whatever the machine's clock says — a laptop in another zone, a VM on UTC — and D-0 must be
 * the whole of that last day, not the hours after midnight UTC.
 *
 * The sentences are read through `t(variable)`, which `i18n-coverage.test.ts` cannot see, so the
 * table is walked here the way `agent-presets.test.ts` walks its own.
 */

/** 23:59:59.999 in Seoul on 2026-09-29, as `.env` carries it. */
const ENDS = "2026-09-29T14:59:59.999Z";
const at = (iso: string) => new Date(iso);

const trial = (
  overrides: Partial<Parameters<typeof trialBannerLines>[0]> = {},
) => ({
  endsAt: ENDS,
  holdDays: 30,
  dailyTokenBudget: 3_000_000,
  budgetReachedToday: false,
  ...overrides,
});

describe("the banner's sentences", () => {
  test("every one of them is in Korean", () => {
    const missing = Object.values(TRIAL_BANNER_SENTENCES).filter(
      (sentence) => !ko[sentence],
    );
    expect(missing).toEqual([]);
  });

  test("the Korean keeps every placeholder the English has", () => {
    for (const sentence of Object.values(TRIAL_BANNER_SENTENCES)) {
      for (const [placeholder] of sentence.matchAll(/\{\w+\}/g)) {
        expect([sentence, ko[sentence]?.includes(placeholder)]).toEqual([
          sentence,
          true,
        ]);
      }
    }
  });

  test("say what the contract says, in Korean", () => {
    expect(ko[TRIAL_BANNER_SENTENCES.counting]).toBe(
      "무료 체험 D-{days} · {date}에 끝나요",
    );
    expect(ko[TRIAL_BANNER_SENTENCES.download]).toContain(
      "끝나기 전에 설정 → 내 데이터에서 전부 내려받을 수 있어요",
    );
    expect(ko[TRIAL_BANNER_SENTENCES.tonight]).toContain(
      "오늘 밤 12시에 무료 체험이 끝나요",
    );
  });
});

describe("how many days are left", () => {
  test.each([
    // [now, days] — every boundary is a Seoul midnight, never a UTC one.
    ["2026-09-14T15:00:00.000Z", 14], // 09-15 00:00 KST
    ["2026-09-15T14:59:59.999Z", 14], // 09-15 23:59:59.999 KST
    ["2026-09-15T15:00:00.000Z", 13], // 09-16 00:00 KST
    ["2026-09-25T14:59:59.999Z", 4], // 09-25 23:59:59.999 KST
    ["2026-09-25T15:00:00.000Z", 3], // 09-26 00:00 KST
    ["2026-09-28T15:00:00.000Z", 0], // 09-29 00:00 KST, the last day
    ["2026-09-29T14:59:59.999Z", 0], // its last millisecond
    ["2026-09-29T15:00:00.000Z", -1], // 09-30 00:00 KST, over
  ] as const)("at %s it is D-%i", (now, days) => {
    expect(trialDaysLeft(ENDS, at(now))).toBe(days);
  });

  test("an extension counts past fourteen the same way", () => {
    expect(
      trialDaysLeft("2026-10-06T14:59:59.999Z", at("2026-09-15T01:00:00Z")),
    ).toBe(21);
  });

  test("an end the surface cannot read counts nothing", () => {
    expect(trialDaysLeft("not a date", at("2026-09-15T01:00:00Z"))).toBeNaN();
  });
});

describe("the date it names", () => {
  test("is the Seoul day, in the reader's language", () => {
    expect(trialEndDate(ENDS, "ko")).toBe("9월 29일");
    expect(trialEndDate(ENDS, "en")).toBe("September 29");
    // 00:30 in Seoul on the 30th is still the 29th in UTC.
    expect(trialEndDate("2026-09-29T15:30:00.000Z", "ko")).toBe("9월 30일");
  });
});

describe("what the banner says on a given day", () => {
  test("D-14 to D-4: the count and the date", () => {
    expect(trialBannerLines(trial(), at("2026-09-15T01:00:00Z"))).toEqual([
      "counting",
    ]);
    expect(trialBannerLines(trial(), at("2026-09-25T14:00:00Z"))).toEqual([
      "counting",
    ]);
  });

  test("D-3 to D-1: the count, and where to take everything before it ends", () => {
    for (const now of [
      "2026-09-25T15:00:00.000Z",
      "2026-09-27T03:00:00.000Z",
      "2026-09-28T14:59:59.999Z",
    ]) {
      expect(trialBannerLines(trial(), at(now))).toEqual([
        "counting",
        "download",
      ]);
    }
  });

  test("D-0: tonight, and nothing else", () => {
    expect(trialBannerLines(trial(), at("2026-09-29T03:00:00Z"))).toEqual([
      "tonight",
    ]);
  });

  test("after the end, that it has ended — the machine is about to stop saying anything", () => {
    expect(trialBannerLines(trial(), at("2026-09-29T15:00:01Z"))).toEqual([
      "ended",
    ]);
  });

  test("a spent day is the conversation's to say, not a third line here", () => {
    // Measured: drawn here it wrapped the label across the header and the first message, beside the
    // same sentence already under the refused question.
    expect(
      trialBannerLines(
        trial({ budgetReachedToday: true }),
        at("2026-09-26T01:00:00Z"),
      ),
    ).toEqual(["counting", "download"]);
  });

  test("nothing, for an end that cannot be read", () => {
    expect(
      trialBannerLines(trial({ endsAt: "soon" }), at("2026-09-15T01:00:00Z")),
    ).toEqual([]);
  });
});

describe("what the surface reads off /api/me", () => {
  test("a trial the server described", () => {
    expect(
      parseTrial({
        endsAt: ENDS,
        holdDays: 30,
        dailyTokenBudget: 3_000_000,
        budgetReachedToday: true,
      }),
    ).toEqual({
      endsAt: ENDS,
      holdDays: 30,
      dailyTokenBudget: 3_000_000,
      budgetReachedToday: true,
    });
  });

  test("no trial when the server said none, or said something that is not one", () => {
    expect(parseTrial(undefined)).toBeUndefined();
    expect(parseTrial(null)).toBeUndefined();
    expect(parseTrial({ endsAt: 5 })).toBeUndefined();
    expect(
      parseTrial({ endsAt: ENDS, holdDays: "30", dailyTokenBudget: 1 }),
    ).toBeUndefined();
  });
});
