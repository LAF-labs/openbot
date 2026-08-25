import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { modelUsageOf } from "../src/runner/laf-runner";

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
