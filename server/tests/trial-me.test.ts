import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { DailyBudget } from "../src/usage/daily-budget";
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

function judge(reached: boolean) {
  const asked = { count: 0 };
  const budget: DailyBudget = {
    tokens: 3_000_000,
    usedToday: async () => 0,
    reachedToday: async () => {
      asked.count += 1;
      return reached;
    },
  };
  return { budget, asked };
}

/**
 * `createApp` takes its collaborators by position and the judge is the last of them. A tuple typed
 * from the function keeps the compiler on the shape; a wrong index shows up here as a trial that
 * never says its day is spent, which the second test reads.
 */
function surface(environment: Record<string, string>, budget?: DailyBudget) {
  const args: Parameters<typeof createApp> = [
    loadConfig(testEnvironment(environment)),
    signedIn,
    roles,
  ];
  args[45] = budget;
  return createApp(...args);
}

async function deployment(app: ReturnType<typeof createApp>) {
  const response = await app.request("http://laf.local/api/me");
  expect(response.status).toBe(200);
  return ((await response.json()) as { deployment: Record<string, unknown> })
    .deployment;
}

describe("what /api/me says about a trial", () => {
  test("the four values, as the .env wrote them", async () => {
    const { budget } = judge(false);
    expect((await deployment(surface(TRIAL, budget))).trial).toEqual({
      endsAt: "2026-09-29T14:59:59Z",
      holdDays: 30,
      dailyTokenBudget: 3_000_000,
      budgetReachedToday: false,
    });
  });

  test("whether today is spent, from the same judge a run is refused by", async () => {
    const { budget, asked } = judge(true);
    const said = await deployment(surface(TRIAL, budget));
    expect(said.trial).toMatchObject({ budgetReachedToday: true });
    expect(asked.count).toBe(1);
  });

  test("a budget of one, which is how an operator proves a push arrived", async () => {
    const said = await deployment(
      surface({ ...TRIAL, LAF_DAILY_TOKEN_BUDGET: "1" }, judge(false).budget),
    );
    expect(said.trial).toMatchObject({ dailyTokenBudget: 1 });
  });

  test("nothing at all on a deployment that is not a trial, and the judge is never asked", async () => {
    const { budget, asked } = judge(true);
    const said = await deployment(surface({}, budget));
    expect(said).not.toHaveProperty("trial");
    // The capabilities are untouched beside it.
    expect(said).toMatchObject({ effort: true, autoReview: true });
    expect(asked.count).toBe(0);
  });
});
