import { describe, expect, test } from "bun:test";
import {
  callsOf,
  discipline,
  eventsOfSse,
  hangulShare,
  resultsOf,
  saysNumber,
  usageOf,
  usagesOf,
} from "../evals/lib";

const sse = (events: object[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n");

describe("reading a run back from its wire", () => {
  test("parses data lines and drops heartbeat comments", () => {
    const body = `: keepalive\n\n${sse([{ type: "RUN_STARTED" }, { type: "RUN_FINISHED" }])}`;
    expect(eventsOfSse(body).map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "RUN_FINISHED",
    ]);
  });

  test("reassembles a tool call from its fragments", () => {
    const events = eventsOfSse(
      sse([
        { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "remember" },
        { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"fact":"일요' },
        { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '일 휴무"}' },
        { type: "TOOL_CALL_END", toolCallId: "c1" },
      ]),
    );
    expect(callsOf(events)).toEqual([
      {
        id: "c1",
        name: "remember",
        rawArguments: '{"fact":"일요일 휴무"}',
        arguments: { fact: "일요일 휴무" },
      },
    ]);
  });

  test("a call the Bot service answered itself reads back with its answer", () => {
    const events = eventsOfSse(
      sse([
        {
          type: "TOOL_CALL_START",
          toolCallId: "c1",
          toolCallName: "tool_search",
        },
        { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"query":"메일"}' },
        { type: "TOOL_CALL_END", toolCallId: "c1" },
        {
          type: "TOOL_CALL_RESULT",
          messageId: "tool_c1",
          toolCallId: "c1",
          content: "- mcp__gmail__send_message: 메일을 실제로 보낸다.",
        },
      ]),
    );
    expect(resultsOf(events).get("c1")).toContain("mcp__gmail__send_message");
    expect(callsOf(events)[0]?.id).toBe("c1");
  });

  test("a run's cost is the sum of its rounds", () => {
    const usage = (promptTokens: number) => ({
      type: "CUSTOM",
      name: "laf.model.usage",
      value: {
        promptTokens,
        completionTokens: 5,
        totalTokens: promptTokens + 5,
      },
    });
    const events = eventsOfSse(sse([usage(1_000), usage(1_400)]));
    expect(usagesOf(events)).toEqual({
      promptTokens: 2_400,
      completionTokens: 10,
      totalTokens: 2_410,
      requests: 2,
    });
    expect(usagesOf([]).requests).toBe(0);
  });

  test("arguments that never became JSON read as null, and discipline names them", () => {
    const events = eventsOfSse(
      sse([
        { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "remember" },
        { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"fact": broken' },
        { type: "TOOL_CALL_END", toolCallId: "c1" },
        { type: "RUN_FINISHED" },
      ]),
    );
    expect(callsOf(events)[0]?.arguments).toBeNull();
    expect(discipline(events)).toContain(
      "arguments are not a JSON object: remember",
    );
  });

  test("a clean stream has no discipline problems", () => {
    const events = eventsOfSse(
      sse([
        { type: "RUN_STARTED" },
        { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "x" },
        { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: "{}" },
        { type: "TOOL_CALL_END", toolCallId: "c1" },
        { type: "RUN_FINISHED" },
      ]),
    );
    expect(discipline(events)).toEqual([]);
  });

  test("an errored or truncated run is named, not passed", () => {
    expect(discipline(eventsOfSse(sse([{ type: "RUN_STARTED" }])))).toContain(
      "no RUN_FINISHED",
    );
    expect(
      discipline(
        eventsOfSse(
          sse([
            { type: "RUN_ERROR", message: "boom" },
            { type: "RUN_FINISHED" },
          ]),
        ),
      ),
    ).toContain("RUN_ERROR: boom");
  });

  test("reads the usage event, and only that event", () => {
    const events = eventsOfSse(
      sse([
        { type: "CUSTOM", name: "laf.other", value: { totalTokens: 1 } },
        {
          type: "CUSTOM",
          name: "laf.model.usage",
          value: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        },
      ]),
    );
    expect(usageOf(events)).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      // Not reported is null, not zero: the two are different facts about an endpoint.
      cachedPromptTokens: null,
    });
    expect(usageOf([])).toBeNull();
    expect(
      usageOf([
        {
          type: "CUSTOM",
          name: "laf.model.usage",
          value: { promptTokens: 3000, cachedPromptTokens: 2816 },
        },
      ])?.cachedPromptTokens,
    ).toBe(2816);
  });
});

describe("the deterministic checks", () => {
  test("hangul share tells Korean prose from English", () => {
    expect(hangulShare("총액은 이만 원입니다")).toBeGreaterThan(0.9);
    expect(hangulShare("The total is 20,000 won")).toBeLessThan(0.2);
    expect(hangulShare("1234 !@#")).toBe(0);
  });

  test("numbers are found with or without separators", () => {
    expect(saysNumber("총액 29,500원입니다", 29500)).toBe(true);
    expect(saysNumber("총액 29500원", 29500)).toBe(true);
    expect(saysNumber("총액 2,950원", 29500)).toBe(false);
  });
});
