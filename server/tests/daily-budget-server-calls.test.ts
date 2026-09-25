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
 *   - a write-up is REFUSED with the same fact a run ends on, so the screen can say the same
 *     sentence rather than "try again" in front of a day that ends at midnight.
 *
 * What is asserted is what the model endpoint received — a fake one on a local port.
 */

const received: string[] = [];
const provider = Bun.serve({
  port: 0,
  fetch: async (request) => {
    received.push(new URL(request.url).pathname);
    // The judge asks on the review model and a write-up on the deployment's own; each gets its shape.
    const { model } = (await request.json()) as { model?: string };
    const content =
      model === "laf-small"
        ? '{"verdict": "allow", "reason": "주문을 읽기만 한다"}'
        : '{"title": "주문 확인", "summary": "주문을 본다", "instructions": "1. 주문 화면을 연다"}';
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
    usedToday: async () => (reached ? 3_000_000 : 0),
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
      reviewModel: "laf-small",
      decisionModel: "typesafe/jev-1.13-20260917",
    },
    dailyBudget: budget,
  });
}

const recording = {
  botId: "agent_shop",
  startedBy: "owner",
  startedAt: 0,
  finished: true,
  steps: [
    {
      kind: "pressed" as const,
      element: { role: "link", name: "주문" },
      at: 1,
    },
  ],
};

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

describe("a write-up on a spent day", () => {
  test("is refused with the fact a run ends on, before the model is called", async () => {
    received.length = 0;
    const thrown = await calls(true)
      .writeUp(recording)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(httpRefusalOf(thrown)).toMatchObject({ code: DAILY_BUDGET_REACHED });
    expect(received).toEqual([]);
  });

  test("on a day with room left it writes the recording up", async () => {
    received.length = 0;
    expect(await calls(false).writeUp(recording)).toMatchObject({ ok: true });
    expect(received).toEqual(["/v1/chat/completions"]);
  });
});
