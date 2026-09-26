/**
 * What a run's meter reads out of its events: times and counts, never words.
 *
 * The clock is handed in, so each part of a run is exactly as long as the test says it was.
 */
import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { createRunMeter } from "../src/telemetry/run-meter";

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    pass: (ms: number) => {
      now += ms;
    },
  };
}

const event = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, ...extra }) as unknown as BaseEvent;
const custom = (name: string, value: unknown = {}) =>
  event("CUSTOM", { name, value });
const usage = (value: Record<string, unknown>) =>
  custom("laf.model.usage", { model: "m", ...value });

describe("the run meter", () => {
  test("splits a run into queued, first answer, stream and total", () => {
    const time = clock();
    const meter = createRunMeter(time.now);
    time.pass(120);
    meter.observe(event("RUN_STARTED"));
    time.pass(2_300);
    meter.observe(event("TEXT_MESSAGE_START"));
    meter.observe(event("TEXT_MESSAGE_CONTENT", { delta: "안" }));
    time.pass(900);
    meter.observe(event("TEXT_MESSAGE_CONTENT", { delta: "녕" }));
    time.pass(100);
    meter.end();
    expect(meter.read()).toMatchObject({
      queuedMs: 120,
      firstTokenMs: 2_300,
      streamMs: 1_000,
      totalMs: 3_420,
    });
  });

  test("a routine's later steps start runs of their own, and the first is the start", () => {
    const time = clock();
    const meter = createRunMeter(time.now);
    time.pass(50);
    meter.observe(event("RUN_STARTED"));
    time.pass(400);
    meter.observe(event("TOOL_CALL_START", { toolCallName: "computer_read" }));
    time.pass(5_000);
    meter.observe(event("RUN_STARTED"));
    time.pass(10);
    meter.end();
    expect(meter.read()).toMatchObject({ queuedMs: 50, firstTokenMs: 400 });
  });

  test("a tool call is output too: the first answer can be a call", () => {
    const time = clock();
    const meter = createRunMeter(time.now);
    meter.observe(event("RUN_STARTED"));
    time.pass(700);
    meter.observe(
      event("TOOL_CALL_START", { toolCallName: "computer_navigate" }),
    );
    meter.observe(event("TOOL_CALL_ARGS", { delta: "{}" }));
    meter.observe(event("TOOL_CALL_END"));
    meter.observe(event("TOOL_CALL_START", { toolCallName: "computer_read" }));
    meter.end();
    expect(meter.read()).toMatchObject({ firstTokenMs: 700, toolCalls: 2 });
  });

  test("counts requests, retries and money from the Bot's own events", () => {
    const meter = createRunMeter(clock().now);
    meter.observe(event("RUN_STARTED"));
    meter.observe(
      usage({ promptTokens: 4_000, cachedPromptTokens: 3_000, costUsd: 0.01 }),
    );
    meter.observe(custom("laf.retry", { kind: "empty" }));
    meter.observe(usage({ promptTokens: 4_100, costUsd: 0.002 }));
    meter.observe(custom("laf.retry", { kind: "provider" }));
    meter.end();
    const read = meter.read();
    expect(read).toMatchObject({
      modelRequests: 2,
      retries: 2,
      promptTokens: 8_100,
      cachedTokens: 3_000,
      emptyAnswer: false,
    });
    expect(read.costUsd).toBeCloseTo(0.012, 10);
  });

  test("a call that hands the wheel to the person is noticed; any other is not", () => {
    const asked = createRunMeter(clock().now);
    asked.observe(
      event("TOOL_CALL_START", { toolCallName: "computer_request_secret" }),
    );
    expect(asked.read().personNeeded).toBe(true);

    const helped = createRunMeter(clock().now);
    helped.observe(
      event("TOOL_CALL_START", { toolCallName: "computer_request_help" }),
    );
    expect(helped.read().personNeeded).toBe(true);

    const browsed = createRunMeter(clock().now);
    browsed.observe(
      event("TOOL_CALL_START", { toolCallName: "computer_click" }),
    );
    browsed.observe(event("TOOL_CALL_START", { toolCallName: 42 }));
    expect(browsed.read().personNeeded).toBe(false);
  });

  test("an empty answer, even when asked again, is flagged", () => {
    const meter = createRunMeter(clock().now);
    meter.observe(custom("laf.empty_answer"));
    expect(meter.read().emptyAnswer).toBe(true);
  });

  test("a run that never started and never said anything has no times but its total", () => {
    const time = clock();
    const meter = createRunMeter(time.now);
    time.pass(3_000);
    meter.observe(event("RUN_ERROR", { message: "fetch failed" }));
    meter.end();
    time.pass(9_999);
    meter.end();
    expect(meter.read()).toMatchObject({
      queuedMs: null,
      firstTokenMs: null,
      streamMs: null,
      totalMs: 3_000,
      modelRequests: 0,
    });
  });

  test("what it reads is numbers and two flags, whatever the events said", () => {
    const planted = "사장님 비밀번호는 hunter2-7731 입니다";
    const meter = createRunMeter(clock().now);
    meter.observe(event("RUN_STARTED", { input: planted }));
    meter.observe(event("TEXT_MESSAGE_CONTENT", { delta: planted }));
    meter.observe(
      event("TOOL_CALL_START", { toolCallName: planted, input: planted }),
    );
    meter.observe(event("TOOL_CALL_ARGS", { delta: planted }));
    meter.observe(custom("laf.retry", { kind: planted }));
    meter.observe(usage({ model: planted, provider: planted }));
    meter.observe(event("RUN_ERROR", { message: planted }));
    meter.end();
    const read = meter.read();
    expect(JSON.stringify(read)).not.toContain("hunter2");
    for (const [key, value] of Object.entries(read)) {
      expect([
        key,
        typeof value === "number" ||
          typeof value === "boolean" ||
          value === null,
      ]).toEqual([key, true]);
    }
  });
});
