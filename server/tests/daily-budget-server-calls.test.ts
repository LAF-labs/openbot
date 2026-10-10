import { afterAll, describe, expect, test } from "bun:test";
import type { ReviewSubject } from "../src/computer/auto-review";
import type { Database } from "../src/db/client";
import { httpRefusalOf } from "../src/failure-text";
import { createServerModelCalls } from "../src/server-model-calls";
import {
  DAILY_BUDGET_REACHED,
  type DailyBudget,
} from "../src/usage/daily-budget";

/**
 * The model calls this server makes on its own account, on a day the trial has spent.
 *
 * They draw on the same day as the Bots' (their `model.usage` rows are in the same sum), so they
 * answer to the same budget (self-serve contract §4.6) — each the way its own promise allows:
 *
 *   - auto-review is NOT JUDGED, which means a person is asked. That is the product's ordinary
 *     answer when there is nothing to judge with, and the boundary never lies in that direction:
 *     spending nothing never lets an action past unseen.
 *   - the mail's second look and the high-risk check's judge are NOT ASKED, and each says so by
 *     throwing, which its caller reads as a judge that could not answer. The mail's rules then
 *     stand alone — what they are sure of is withheld and nothing more (`plugins/mail-secrets.ts`)
 *     — and the check falls back to its own, which ask wherever anything personal was typed
 *     (`computer/high-risk.ts`).
 *
 * What is asserted is what the model endpoint received — a fake one on a local port.
 */

const received: string[] = [];
const provider = Bun.serve({
  port: 0,
  fetch: (request) => {
    received.push(new URL(request.url).pathname);
    // Every call here is a judge's, on the review or the server model, and gets the judge's shape.
    const content = '{"verdict": "allow", "reason": "주문을 읽기만 한다"}';
    return Response.json({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  },
});
afterAll(() => provider.stop(true));

/** The one read `autoReviewFor` makes, answered with an instruction to judge. */
const instructed = {
  select: () => ({
    from: () => ({
      where: async () => [{ instruction: "주문을 읽기만 하는 건 묻지 마" }],
    }),
  }),
} as unknown as Database;

const subject: ReviewSubject = {
  action: "computer_navigate",
  subject: {
    kind: "browser",
    intent: "navigate",
    host: "sell.smartstore.naver.com",
    reason: "policy_ask",
  },
};

function calls(reached: boolean) {
  const budget: DailyBudget = {
    tokens: 3_000_000,
    today: async () => ({ tokens: reached ? 3_000_000 : 0, usd: 0, reached }),
    reachedToday: async () => reached,
  };
  return createServerModelCalls({
    database: instructed,
    auditStore: { insert: async () => undefined },
    credentials: { readModelSecret: async () => null },
    encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    endpoint: {
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      apiKey: "sk-test",
    },
    model: {
      provider: "openai",
      credentialSecretRef: "model:openai",
      defaultModel: "laf-1",
      supportsEffort: false,
      serverModel: "laf-small",
      serverModelSupportsEffort: true,
      reviewModel: "laf-small",
      decisionModel: "typesafe/jev-1.13-20260917",
    },
    dailyBudget: budget,
  });
}

describe("auto-review on a spent day", () => {
  test("is not judged, so a person is asked, and the model is never called", async () => {
    received.length = 0;
    expect(await calls(true).autoReviewFor("agent_shop", subject)).toBeNull();
    expect(received).toEqual([]);
  });

  test("on a day with room left it judges as it always did", async () => {
    received.length = 0;
    expect(
      await calls(false).autoReviewFor("agent_shop", subject),
    ).toMatchObject({ allowed: true });
    expect(received).toEqual(["/v1/chat/completions"]);
  });
});

/** One yes/no question, the shape either judge is asked in. */
const QUESTION = { q: { type: "noul" as const, instructions: "Is it so?" } };

/** What an ask ended on: nothing where it was answered, or what it threw. */
const thrownBy = (asked: Promise<unknown>) =>
  asked.then(
    () => null,
    (error: unknown) => error,
  );

/*
 * For both judges below: the day is what stops the question. With room left the same question goes
 * to the model, and only the asking is read here — what a judge makes of an answer is
 * `server-model-calls.test.ts`'s, and this provider's answer is a verdict, not a probability.
 */

describe("the mail's second look on a spent day", () => {
  test("is not asked, and says so with the fact a run ends on", async () => {
    const state = { around: "인증번호는 ▢▢▢▢▢▢" };
    received.length = 0;
    const thrown = await thrownBy(
      calls(true).mailSecretJudge.ask(state, QUESTION),
    );
    expect(httpRefusalOf(thrown)).toMatchObject({ code: DAILY_BUDGET_REACHED });
    expect(received).toEqual([]);

    await thrownBy(calls(false).mailSecretJudge.ask(state, QUESTION));
    expect(received).toEqual(["/v1/chat/completions"]);
  });
});

describe("the high-risk check's judge on a spent day", () => {
  test("is not asked, and throws the word the check files the miss under", async () => {
    const state = { page: "결제" };
    received.length = 0;
    const thrown = await thrownBy(
      calls(true).highRiskAsker.ask(state, QUESTION),
    );
    // `high-risk.ts` reads the word before the colon into the verdict's `failed`, which the trail
    // keeps: a check nobody judged because the day was spent says `budget`, not `error`.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message.split(":")[0]).toBe("budget");
    expect(received).toEqual([]);

    await thrownBy(calls(false).highRiskAsker.ask(state, QUESTION));
    expect(received).toEqual(["/v1/chat/completions"]);
  });
});
