import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { BudgetDay, DailyBudget } from "../src/usage/daily-budget";
import { testEnvironment } from "./support/environment";

/**
 * The four facts a trial is drawn from, beside the person they are drawn for.
 *
 * `GET /api/me` → `deployment.trial` (self-serve contract §4.6): when it ends, how long it is kept
 * after, the day's budget, and whether today's is spent. Facts and no sentence — the banner owns
 * the words. And a deployment that is not a trial has no key at all, rather than a trial of nothing:
 * the surface draws a banner for a key that exists, and the key that is absent is the one that can
 * never draw a countdown on somebody's paid machine.
 */

const TRIAL = {
  LAF_PLAN: "trial",
  LAF_TRIAL_ENDS_AT: "2026-09-29T14:59:59Z",
  LAF_TRIAL_HOLD_DAYS: "30",
  LAF_DAILY_TOKEN_BUDGET: "3000000",
};

const signedIn = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "owner", email: "owner@laf.test", name: "사장님" },
    }),
  },
};
const roles = { rolesForUser: async () => ["admin" as const] };

/** A judge that read the day as given (null: it could not), counting how often it was asked. */
function judge(day: Partial<BudgetDay> | null = {}, usd?: number) {
  const asked = { read: 0 };
  const budget: DailyBudget = {
    tokens: 3_000_000,
    ...(usd === undefined ? {} : { usd }),
    today: async () => {
      asked.read += 1;
      return day ? { tokens: 0, usd: 0, reached: false, ...day } : null;
    },
    reachedToday: async () => {
      throw new Error("/api/me reads the day once, and the verdict is in it");
    },
  };
  return { budget, asked };
}

function surface(environment: Record<string, string>, budget?: DailyBudget) {
  return createApp({
    config: loadConfig(testEnvironment(environment)),
    auth: signedIn,
    roleRepository: roles,
    dailyBudget: budget,
  });
}

async function deployment(app: ReturnType<typeof createApp>) {
  const response = await app.request("http://laf.local/api/me");
  expect(response.status).toBe(200);
  return ((await response.json()) as { deployment: Record<string, unknown> })
    .deployment;
}

describe("what /api/me says about a trial", () => {
  test("the four values, as the .env wrote them, and what today has used", async () => {
    const { budget } = judge();
    expect((await deployment(surface(TRIAL, budget))).trial).toEqual({
      endsAt: "2026-09-29T14:59:59Z",
      holdDays: 30,
      dailyTokenBudget: 3_000_000,
      budgetReachedToday: false,
      tokensUsedToday: 0,
    });
  });

  test("today's use is the count the judge sums, and the day is read once", async () => {
    // It was three reads of the same rows for one answer (review, 2026-10-10).
    const { budget, asked } = judge({ tokens: 2_412_345 });
    const said = await deployment(surface(TRIAL, budget));
    expect(said.trial).toMatchObject({ tokensUsedToday: 2_412_345 });
    expect(asked.read).toBe(1);
  });

  test("a day that cannot be read is left out, not said as nothing used — and is not a refusal", async () => {
    // Zero would be a meter drawn empty on the day somebody may be one question from the limit.
    const said = await deployment(surface(TRIAL, judge(null).budget));
    expect(said.trial).toMatchObject({ budgetReachedToday: false });
    expect(said.trial).not.toHaveProperty("tokensUsedToday");
  });

  test("whether today is spent, from the same judge a run is refused by", async () => {
    const { budget, asked } = judge({ reached: true });
    const said = await deployment(surface(TRIAL, budget));
    expect(said.trial).toMatchObject({ budgetReachedToday: true });
    expect(asked.read).toBe(1);
  });

  test("a budget of one, which is how an operator proves a push arrived", async () => {
    const said = await deployment(
      surface({ ...TRIAL, LAF_DAILY_TOKEN_BUDGET: "1" }, judge().budget),
    );
    expect(said.trial).toMatchObject({ dailyTokenBudget: 1 });
  });

  test("a day counted in tokens says no dollar figure, though the read carries one", async () => {
    const said = await deployment(
      surface(TRIAL, judge({ tokens: 5, usd: 0.0001 }).budget),
    );
    expect(said.trial).not.toHaveProperty("dailyBudgetUsd");
    expect(said.trial).not.toHaveProperty("costUsdToday");
  });

  test("a day counted in dollars says the budget and today's cost beside the four, read once", async () => {
    const { budget, asked } = judge({ tokens: 812_000, usd: 0.2031 }, 0.55);
    const said = await deployment(
      surface({ ...TRIAL, LAF_DAILY_BUDGET_USD: "0.55" }, budget),
    );
    expect(said.trial).toEqual({
      endsAt: "2026-09-29T14:59:59Z",
      holdDays: 30,
      dailyTokenBudget: 3_000_000,
      dailyBudgetUsd: 0.55,
      budgetReachedToday: false,
      tokensUsedToday: 812_000,
      costUsdToday: 0.2031,
    });
    expect(asked.read).toBe(1);
  });

  test("a cost that cannot be read is left out, like the count — never said as nothing spent", async () => {
    const said = await deployment(
      surface(
        { ...TRIAL, LAF_DAILY_BUDGET_USD: "0.55" },
        judge(null, 0.55).budget,
      ),
    );
    expect(said.trial).toMatchObject({ dailyBudgetUsd: 0.55 });
    expect(said.trial).not.toHaveProperty("costUsdToday");
    expect(said.trial).not.toHaveProperty("tokensUsedToday");
  });

  test("nothing at all on a deployment that is not a trial, and the judge is never asked", async () => {
    const { budget, asked } = judge({ reached: true });
    const said = await deployment(surface({}, budget));
    expect(said).not.toHaveProperty("trial");
    // The capabilities are untouched beside it (`effort` is false everywhere since 2026-10-08).
    expect(said).toMatchObject({ effort: false, autoReview: true });
    expect(asked.read).toBe(0);
  });
});
