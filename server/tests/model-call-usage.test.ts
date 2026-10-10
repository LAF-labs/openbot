import { describe, expect, test } from "bun:test";
import { askModel, type ModelUsage } from "../src/computer/model-call";

/**
 * What a call this server makes on its own says it cost (piece 6-1, 2026-10-10).
 *
 * `askModel` is the one place the judges, the day's summary and the dream ask a model, and until
 * that day it read the token counts off the reply and nothing else. Measured on a development
 * deployment: 45 such rows in two weeks, none with a price. A day counted in dollars
 * (`usage/daily-budget.ts`) sums the provider's figure, so the figure has to be on the row — and
 * where the provider said nothing, the field has to be ABSENT, because a zero is a price.
 */

async function usageOf(usage: unknown): Promise<ModelUsage[]> {
  const said: ModelUsage[] = [];
  const answer = await askModel(
    {
      baseUrl: "https://model.test/v1",
      model: "some/model",
      apiKey: async () => "key",
      onUsage: (told) => said.push(told),
      fetch: (async () =>
        Response.json({
          choices: [{ message: { content: "네" } }],
          usage,
        })) as unknown as typeof fetch,
    },
    { system: "s", user: "u", timeoutMs: 1000 },
  );
  expect(answer).toEqual({ ok: true, text: "네" });
  return said;
}

const COUNTS = {
  prompt_tokens: 1200,
  completion_tokens: 30,
  total_tokens: 1230,
};
const TOLD = {
  model: "some/model",
  promptTokens: 1200,
  completionTokens: 30,
  totalTokens: 1230,
};

describe("what a server-side model call says it cost", () => {
  test("the provider's figure and what it read from its cache, beside the counts", async () => {
    expect(
      await usageOf({
        ...COUNTS,
        cost: 0.000184,
        prompt_tokens_details: { cached_tokens: 1024 },
      }),
    ).toEqual([{ ...TOLD, costUsd: 0.000184, cachedPromptTokens: 1024 }]);
  });

  test("nothing where the provider said nothing — absent, not zero", async () => {
    const [told] = await usageOf(COUNTS);
    expect(told).toEqual(TOLD);
    expect(told).not.toHaveProperty("costUsd");
    expect(told).not.toHaveProperty("cachedPromptTokens");
  });

  test("a call that cost nothing by the provider's own word is a zero, which is a price", async () => {
    expect(await usageOf({ ...COUNTS, cost: 0 })).toEqual([
      { ...TOLD, costUsd: 0 },
    ]);
  });

  test.each([
    ["a word", "0.01"],
    ["a negative amount", -0.01],
    ["not a number", Number.NaN],
    ["nothing", null],
  ])("a figure that is not an amount is left out: %s", async (_what, cost) => {
    const [told] = await usageOf({
      ...COUNTS,
      cost,
      prompt_tokens_details: { cached_tokens: "many" },
    });
    expect(told).toEqual(TOLD);
  });
});
