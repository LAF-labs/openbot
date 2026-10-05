import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import {
  createDailyBudget,
  dailyBudgetFor,
  seoulDayOf,
} from "../src/usage/daily-budget";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * What a trial may spend in a day, counted where the product already counts it.
 *
 * The judge reads `audit_events`: every `model.usage` row written in the Seoul day `now` falls in,
 * summed on `totalTokens` (self-serve contract §4.6). Three things about that sentence are easy to
 * get wrong and invisible from a green run elsewhere — which day (Seoul's, whatever the host's
 * clock says), which rows (usage, and nothing that merely carries a number with the same name), and
 * what a trail that cannot be read means (not a refusal: telling somebody they used up their day is
 * a sentence only a count may say).
 *
 * WHY THE ROWS LIVE IN JUNE 2003, AND WHY NOTHING HERE IS DELETED. `audit_events` is append-only and
 * shared by every suite, so no count over a day can be asserted exactly. Each reading is taken before
 * and after the rows this file writes and the difference is asserted, in days nothing else writes to:
 * after the insights suite's era (before 2000) and far behind today's rows. The retention sweep other
 * files run removes them in time; nothing here needs to.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const HOUR = 3_600_000;

/** A wall-clock reading in Seoul, as the instant it names. Seoul has kept no summer time since 1988. */
const seoul = (wall: string) => new Date(Date.parse(`${wall}Z`) - 9 * HOUR);

async function usageAt(
  at: Date,
  totalTokens: unknown,
  eventType = "model.usage",
): Promise<void> {
  await database.insert(auditEvents).values({
    eventType,
    targetType: "agent",
    targetId: `daily-budget-${suite}`,
    payload: { totalTokens, source: "bot-turn", suite },
    createdAt: at,
  });
}

const budgetAt = (wall: string, tokens = 1_000_000_000) =>
  createDailyBudget({ database, tokens, now: () => seoul(wall) });

afterAll(async () => {
  await database.$client.end();
});

describe("which day is today", () => {
  test("the Seoul day, from its midnight to the next", () => {
    expect(seoulDayOf(new Date("2026-09-15T14:59:59.999Z"))).toEqual({
      start: new Date("2026-09-14T15:00:00.000Z"),
      end: new Date("2026-09-15T15:00:00.000Z"),
    });
    expect(seoulDayOf(new Date("2026-09-15T15:00:00.000Z"))).toEqual({
      start: new Date("2026-09-15T15:00:00.000Z"),
      end: new Date("2026-09-16T15:00:00.000Z"),
    });
  });

  test("across a month and a year, where a UTC day and a Seoul day disagree most", () => {
    // 2027-01-01 00:30 in Seoul is still 2026-12-31 in UTC.
    expect(seoulDayOf(new Date("2026-12-31T15:30:00.000Z")).start).toEqual(
      new Date("2026-12-31T15:00:00.000Z"),
    );
    expect(seoulDayOf(new Date("2026-02-28T16:00:00.000Z")).end).toEqual(
      new Date("2026-03-01T15:00:00.000Z"),
    );
  });
});

describe("today's count", () => {
  test("is the Seoul day's model.usage rows, and nothing either side of midnight", async () => {
    const yesterday = budgetAt("2003-06-14T18:00:00.000");
    const today = budgetAt("2003-06-15T12:00:00.000");
    const tomorrow = budgetAt("2003-06-16T06:00:00.000");
    const before = {
      yesterday: await yesterday.usedToday(),
      today: await today.usedToday(),
      tomorrow: await tomorrow.usedToday(),
    };

    await usageAt(seoul("2003-06-14T23:59:59.999"), 1000);
    await usageAt(seoul("2003-06-15T00:00:00.000"), 20);
    await usageAt(seoul("2003-06-15T23:59:59.999"), 300);
    await usageAt(seoul("2003-06-16T00:00:00.000"), 4000);
    // A number with the same name on another row is not usage.
    await usageAt(seoul("2003-06-15T12:00:00.000"), 50_000, "routine.ran");
    // A count that crossed a service boundary malformed is nothing, not a failed read.
    await usageAt(seoul("2003-06-15T13:00:00.000"), "many");
    await usageAt(seoul("2003-06-15T13:00:00.000"), -7);

    expect({
      yesterday: (await yesterday.usedToday()) - before.yesterday,
      today: (await today.usedToday()) - before.today,
      tomorrow: (await tomorrow.usedToday()) - before.tomorrow,
    }).toEqual({ yesterday: 1000, today: 320, tomorrow: 4000 });
  });

  test("reaches the budget when it meets it, not a token before", async () => {
    const reading = budgetAt("2003-06-20T09:00:00.000");
    const before = await reading.usedToday();
    await usageAt(seoul("2003-06-20T08:00:00.000"), 320);

    expect(
      await budgetAt("2003-06-20T09:00:00.000", before + 320).reachedToday(),
    ).toBe(true);
    expect(
      await budgetAt("2003-06-20T09:00:00.000", before + 321).reachedToday(),
    ).toBe(false);
    // And at the next midnight the day is new, whatever yesterday spent.
    const next = await budgetAt("2003-06-21T00:00:00.000").usedToday();
    expect(
      await budgetAt("2003-06-21T00:00:00.000", next + 1).reachedToday(),
    ).toBe(false);
  });

  test("a trail that cannot be read is not a refusal", async () => {
    const unreachable = createDatabase(
      "postgres://nobody:nobody@127.0.0.1:1/nothing",
      { max: 1 },
    );
    try {
      const budget = createDailyBudget({ database: unreachable, tokens: 1 });
      expect(await budget.reachedToday()).toBe(false);
    } finally {
      await unreachable.$client.end().catch(() => undefined);
    }
  });
});

describe("which deployments are judged at all", () => {
  test("a trial is, on the budget its .env gave it", () => {
    const trial = loadConfig(
      testEnvironment({
        LAF_PLAN: "trial",
        LAF_TRIAL_ENDS_AT: "2026-09-29T14:59:59Z",
        LAF_TRIAL_HOLD_DAYS: "30",
        LAF_DAILY_TOKEN_BUDGET: "3000000",
      }),
    ).trial;
    expect(dailyBudgetFor(trial, database)?.tokens).toBe(3_000_000);
  });

  test("a deployment that is not a trial never is", () => {
    expect(
      dailyBudgetFor(loadConfig(testEnvironment()).trial, database),
    ).toBeUndefined();
  });
});
