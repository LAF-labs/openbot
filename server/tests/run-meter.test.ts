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

/**
 * The wait as the person has it: from the run being accepted to the first thing a window can draw,
 * and to the first word. `firstTokenMs` is neither — it starts at the Bot's service and stops at
 * the model's first output, whatever that was — and it goes on meaning that.
 */
describe("the run meter: the first sign and the first word", () => {
  test("the first word is the first text with something in it, counted from acceptance — and nothing else is", () => {
    const time = clock();
    let reads = 0;
    const now = () => {
      reads += 1;
      return time.now();
    };
    // Accepted, and eighty milliseconds later the run begins: a meter is made, told when that was.
    const acceptedAt = time.now();
    time.pass(80);
    const meter = createRunMeter(now, acceptedAt);
    time.pass(120);
    meter.observe(event("RUN_STARTED"));
    time.pass(2_300);
    // A message opening says nothing, and neither does a blank line: both are before the word.
    meter.observe(event("TEXT_MESSAGE_START"));
    meter.observe(event("TEXT_MESSAGE_CONTENT", { delta: "\n\n" }));
    time.pass(60);
    meter.observe(event("TEXT_MESSAGE_CHUNK", { delta: "" }));
    meter.observe(event("TEXT_MESSAGE_CHUNK"));
    time.pass(20);
    meter.observe(event("TEXT_MESSAGE_CONTENT", { delta: " 안" }));
    // The meter's start, the Bot's start, the first output and the first word: four readings.
    expect(reads).toBe(4);
    time.pass(900);
    // The rest of the answer, and a step after it: nothing left to stamp, so the clock is not read.
    for (let delta = 0; delta < 500; delta += 1) {
      meter.observe(event("TEXT_MESSAGE_CONTENT", { delta: "녕하세요" }));
    }
    meter.observe(event("TOOL_CALL_START", { toolCallName: "computer_read" }));
    expect(reads).toBe(4);
    meter.end();
    expect(meter.read()).toMatchObject({
      // What was measured before the two firsts existed starts where it did: at the meter.
      queuedMs: 120,
      // The blank line is the model's first output, as it always was.
      firstTokenMs: 2_300,
      totalMs: 3_400,
      // The two firsts start at acceptance, eighty milliseconds before it.
      firstSignMs: 2_580,
      firstWordMs: 2_580,
      toolCalls: 1,
      firstMove: null,
    });
  });

  test("a call before the words: the first sign is the call's step, and the first word is later", () => {
    const time = clock();
    const meter = createRunMeter(time.now);
    time.pass(150);
    meter.observe(event("RUN_STARTED"));
    time.pass(700);
    meter.observe(
      event("TOOL_CALL_START", { toolCallName: "computer_navigate" }),
    );
    meter.observe(event("TOOL_CALL_ARGS", { delta: "{}" }));
    meter.observe(event("TOOL_CALL_END"));
    time.pass(4_000);
    // The next step of the same turn: its own start is not the run's.
    meter.observe(event("RUN_STARTED"));
    time.pass(1_100);
    meter.observe(event("TEXT_MESSAGE_CONTENT", { delta: "찾았어요." }));
    meter.end();
    expect(meter.read()).toMatchObject({
      queuedMs: 150,
      firstTokenMs: 700,
      firstSignMs: 850,
      firstWordMs: 5_950,
    });
  });

  test("a first move's step is the first sign, and the model's first output is still counted from the Bot's start", () => {
    const time = clock();
    const meter = createRunMeter(time.now);
    time.pass(260);
    meter.firstMove({
      asked: ["weather"],
      verdict: "moved",
      kind: "weather",
      decisionMs: 240,
    });
    // The move's step goes out to the windows before its call has come back.
    meter.stepSent();
    time.pass(1_200);
    meter.firstMoveCalled(1_200);
    // A second step of the server's would not be the first sign.
    meter.stepSent();
    time.pass(40);
    meter.observe(event("RUN_STARTED"));
    time.pass(2_000);
    meter.observe(event("TEXT_MESSAGE_CONTENT", { delta: "지금 7.8도예요." }));
    time.pass(500);
    meter.end();
    expect(meter.read()).toEqual({
      queuedMs: 1_500,
      firstTokenMs: 2_000,
      firstSignMs: 260,
      firstWordMs: 3_500,
      streamMs: 500,
      totalMs: 4_000,
      modelRequests: 0,
      // The server's call, not one the model made.
      toolCalls: 0,
      retries: 0,
      promptTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      personNeeded: false,
      emptyAnswer: false,
      firstMove: {
        asked: ["weather"],
        verdict: "moved",
        kind: "weather",
        decisionMs: 240,
        callMs: 1_200,
      },
    });
  });

  test("a run that only acted has a sign and no word; one that did nothing has neither", () => {
    const acted = createRunMeter(clock().now);
    acted.observe(event("RUN_STARTED"));
    acted.observe(event("TOOL_CALL_START", { toolCallName: "computer_click" }));
    acted.observe(event("TEXT_MESSAGE_CONTENT", { delta: "  \n" }));
    acted.end();
    expect(acted.read()).toMatchObject({ firstSignMs: 0, firstWordMs: null });

    const silent = createRunMeter(clock().now);
    silent.observe(event("RUN_STARTED"));
    silent.observe(event("RUN_ERROR", { message: "fetch failed" }));
    silent.end();
    expect(silent.read()).toMatchObject({
      firstSignMs: null,
      firstWordMs: null,
    });
  });

  test("a decision that left the step to the Bot is kept without a kind or a call, and the meter keeps its own copy", () => {
    const meter = createRunMeter(clock().now);
    const asked: Array<"calendar" | "mail"> = ["calendar", "mail"];
    meter.firstMove({
      asked,
      verdict: "ambiguous",
      kind: null,
      decisionMs: 310,
    });
    // What the caller does with its list afterwards is not the measure's.
    asked.pop();
    expect(meter.read().firstMove).toEqual({
      asked: ["calendar", "mail"],
      verdict: "ambiguous",
      kind: null,
      decisionMs: 310,
      callMs: null,
    });
    // A call that came back with no first move to belong to is nobody's.
    const none = createRunMeter(clock().now);
    none.firstMoveCalled(900);
    expect(none.read().firstMove).toBeNull();
  });
});
