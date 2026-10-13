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

/*
 * A CALL THE PROVIDER ANSWERED IS A ROW, WHETHER OR NOT IT WAS COUNTED. A reply with no `usage`
 * used to tell nobody, and one with an empty `usage` told 0/0/0 as though that were a count: the
 * day's budget could see neither, and nothing could tell them from a call that never happened.
 */
describe("a call whose provider did not say what it used", () => {
  const UNKNOWN = {
    model: "some/model",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    usageUnknown: true as const,
  };

  test.each([
    ["no usage on the reply", undefined],
    ["a usage with no count in it", {}],
    [
      "a usage of nothing but zeros",
      { ...COUNTS, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    ],
    [
      "counts that are not numbers",
      { prompt_tokens: "many", total_tokens: null },
    ],
  ])("is still told, marked as unknown: %s", async (_what, usage) => {
    expect(await usageOf(usage)).toEqual([UNKNOWN]);
  });

  test("keeps the price where the provider gave one without the counts", async () => {
    expect(await usageOf({ cost: 0.0002 })).toEqual([
      { ...UNKNOWN, costUsd: 0.0002 },
    ]);
  });

  test("a call that was counted carries no such mark", async () => {
    const [told] = await usageOf(COUNTS);
    expect(told).not.toHaveProperty("usageUnknown");
  });

  test("the two halves without their sum are a counted call: the sum is theirs", async () => {
    const [told] = await usageOf({
      prompt_tokens: 1200,
      completion_tokens: 30,
    });
    expect(told).toEqual(TOLD);
    expect(told).not.toHaveProperty("usageUnknown");
  });
});
