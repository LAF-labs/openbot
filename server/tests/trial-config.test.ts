import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * A free trial's four lines in `.env`, all of them or none of them.
 *
 * The fleet writes them at provision and `laf trial extend` and `laf trial budget` push them again
 * (self-serve contract §4.5). Each one alone is a promise nothing keeps: an end date with no
 * budget is a trial that can spend without limit, a budget with no plan is a limit nothing reads,
 * and a date the product cannot read draws a banner counting towards the wrong day. So a half — or
 * a line in a shape nobody wrote on purpose — refuses to start, by name, the same rule the sign-in
 * block keeps.
 */

const TRIAL = {
  LAF_PLAN: "trial",
  LAF_TRIAL_ENDS_AT: "2026-09-29T14:59:59Z",
  LAF_TRIAL_HOLD_DAYS: "30",
  LAF_DAILY_TOKEN_BUDGET: "3000000",
};

const LINES: Array<keyof typeof TRIAL> = [
  "LAF_TRIAL_ENDS_AT",
  "LAF_TRIAL_HOLD_DAYS",
  "LAF_DAILY_TOKEN_BUDGET",
];

describe("a deployment that is not a trial", () => {
  test("carries no trial at all", () => {
    expect(loadConfig(testEnvironment()).trial).toBeUndefined();
  });

  test("including the empty strings compose passes for unset lines", () => {
    // `${LAF_PLAN:-}` hands the server "" on every VM that is not a trial.
    expect(
      loadConfig(
        testEnvironment({
          LAF_PLAN: "",
          LAF_TRIAL_ENDS_AT: "",
          LAF_TRIAL_HOLD_DAYS: "",
          LAF_DAILY_TOKEN_BUDGET: "",
        }),
      ).trial,
    ).toBeUndefined();
  });

  test.each(LINES)(
    "refuses %s without LAF_PLAN=trial: a trial's line on a VM that is not one limits nothing",
    (name) => {
      expect(() =>
        loadConfig(testEnvironment({ [name]: TRIAL[name] })),
      ).toThrow(name);
      expect(() =>
        loadConfig(testEnvironment({ [name]: TRIAL[name] })),
      ).toThrow("LAF_PLAN");
    },
  );
});

describe("a trial", () => {
  test("is carried as the fleet wrote it", () => {
    expect(loadConfig(testEnvironment(TRIAL)).trial).toEqual({
      endsAt: "2026-09-29T14:59:59Z",
      holdDays: 30,
      dailyTokenBudget: 3_000_000,
    });
  });

  test("keeps the end exactly as written, milliseconds and all, because /api/me echoes it", () => {
    // The fleet's end of day is 23:59:59.999 in Seoul; `GET /api/me` must say the `.env` value back.
    expect(
      loadConfig(
        testEnvironment({
          ...TRIAL,
          LAF_TRIAL_ENDS_AT: "2026-09-29T14:59:59.999Z",
        }),
      ).trial?.endsAt,
    ).toBe("2026-09-29T14:59:59.999Z");
  });

  test("takes a budget of one token, which is how an operator proves the setting arrived", () => {
    expect(
      loadConfig(testEnvironment({ ...TRIAL, LAF_DAILY_TOKEN_BUDGET: "1" }))
        .trial?.dailyTokenBudget,
    ).toBe(1);
  });

  test.each(LINES)("refuses to start without %s, by name", (name) => {
    expect(() =>
      loadConfig(testEnvironment({ ...TRIAL, [name]: undefined })),
    ).toThrow(name);
    expect(() => loadConfig(testEnvironment({ ...TRIAL, [name]: "" }))).toThrow(
      name,
    );
  });

  test.each([
    "2026-09-29",
    "2026-09-29T14:59:59",
    "2026-09-29T23:59:59+09:00",
    "2026-02-30T14:59:59Z",
    "2026-13-01T00:00:00Z",
    "tomorrow",
    "1790000000",
  ])("refuses an end that is not one instant in UTC: %s", (value) => {
    expect(() =>
      loadConfig(testEnvironment({ ...TRIAL, LAF_TRIAL_ENDS_AT: value })),
    ).toThrow("LAF_TRIAL_ENDS_AT");
  });

  test.each(["3M", "0", "-1", "1.5", "3,000,000", "1e6", " "])(
    "refuses a budget that is not a whole number of tokens: %s",
    (value) => {
      expect(() =>
        loadConfig(
          testEnvironment({ ...TRIAL, LAF_DAILY_TOKEN_BUDGET: value }),
        ),
      ).toThrow("LAF_DAILY_TOKEN_BUDGET");
    },
  );

  test.each(["thirty", "0", "-30", "30.5", "30d"])(
    "refuses a hold that is not a whole number of days: %s",
    (value) => {
      expect(() =>
        loadConfig(testEnvironment({ ...TRIAL, LAF_TRIAL_HOLD_DAYS: value })),
      ).toThrow("LAF_TRIAL_HOLD_DAYS");
    },
  );

  test.each(["pilot", "Trial", "paid", "free"])(
    "refuses a plan it does not know rather than reading it as no trial: %s",
    (plan) => {
      // Read as "not a trial", a typo would be a trial with no budget — the expensive direction.
      expect(() =>
        loadConfig(testEnvironment({ ...TRIAL, LAF_PLAN: plan })),
      ).toThrow("LAF_PLAN");
    },
  );
});
