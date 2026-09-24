import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { cacheReadOf, modelUsageOf } from "../src/usage/model-usage";

const event = (value: unknown, name = "laf.model.usage") =>
  ({ type: "CUSTOM", name, value }) as unknown as BaseEvent;

describe("what a run's stream says a turn cost", () => {
  test("reads the usage event the Bot service emits", () => {
    const usage = modelUsageOf([
      { type: "RUN_STARTED" } as BaseEvent,
      event({
        model: "stealth/ox-alpha",
        promptTokens: 812,
        completionTokens: 44,
        totalTokens: 856,
      }),
      { type: "RUN_FINISHED" } as BaseEvent,
    ]);
    expect(usage).toEqual([
      {
        model: "stealth/ox-alpha",
        promptTokens: 812,
        completionTokens: 44,
        totalTokens: 856,
      },
    ]);
  });

  test("what was served from cache is carried only when the endpoint said", () => {
    const [said, silent] = modelUsageOf([
      event({
        model: "m",
        promptTokens: 3000,
        completionTokens: 1,
        totalTokens: 3001,
        cachedPromptTokens: 2816,
      }),
      event({ model: "m", promptTokens: 3000, completionTokens: 1 }),
    ]);
    expect(said?.cachedPromptTokens).toBe(2816);
    // Absent, not zero: "not reported" and "nothing hit" are different facts about an endpoint.
    expect(silent).not.toHaveProperty("cachedPromptTokens");
  });

  /*
   * WHAT CACHING NEEDS AND THE ROW NEVER HAD (agent-harness-review §5.9): the provider, the
   * dollars, what was written to the cache, the reasoning, and what was billed at the full price.
   * Without the provider a hit rate averages caches that never met.
   */
  test("the provider, the cost, cache writes, reasoning — and the uncached share derived", () => {
    const [usage] = modelUsageOf([
      event({
        model: "z-ai/glm-5.3-flash",
        promptTokens: 9192,
        completionTokens: 120,
        totalTokens: 9312,
        cachedPromptTokens: 8960,
        cacheWriteTokens: 0,
        reasoningTokens: 64,
        costUsd: 0.00041,
        provider: "Z.AI",
      }),
    ]);
    expect(usage).toEqual({
      model: "z-ai/glm-5.3-flash",
      promptTokens: 9192,
      completionTokens: 120,
      totalTokens: 9312,
      cachedPromptTokens: 8960,
      uncachedPromptTokens: 232,
      cacheWriteTokens: 0,
      reasoningTokens: 64,
      costUsd: 0.00041,
      provider: "Z.AI",
    });
    expect(usage && cacheReadOf(usage)).toBeCloseTo(0.975, 3);
  });

  test("a provider name that is not a name is not kept, and no cache read is no share", () => {
    const [usage] = modelUsageOf([
      event({
        model: "m",
        promptTokens: 100,
        completionTokens: 1,
        totalTokens: 101,
        provider: "<script>alert(1)</script>",
        costUsd: -3,
      }),
    ]);
    expect(usage).not.toHaveProperty("provider");
    expect(usage).not.toHaveProperty("costUsd");
    expect(usage && cacheReadOf(usage)).toBeNull();
  });

  test("other CUSTOM events are not usage", () => {
    expect(modelUsageOf([event({ promptTokens: 5 }, "laf.other")])).toEqual([]);
  });

  test("a stream with no usage event costs nothing to record", () => {
    expect(
      modelUsageOf([
        { type: "RUN_STARTED" } as BaseEvent,
        { type: "RUN_FINISHED" } as BaseEvent,
      ]),
    ).toEqual([]);
  });

  test("malformed counts become zero, not a crash", () => {
    // The event crossed a service boundary. A ledger that throws on a bad count is a run that
    // fails on metering, which is the one thing metering must never do.
    const usage = modelUsageOf([
      event({ model: 7, promptTokens: "many", completionTokens: null }),
    ]);
    expect(usage).toEqual([
      {
        model: "unknown",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    ]);
  });
});
