import { afterAll, describe, expect, spyOn, test } from "bun:test";
import OpenAI from "openai";
import {
  type Behaviour,
  type FakeProvider,
  startFakeProvider,
} from "./fake-provider";

/**
 * The bound on one model request, through the REAL SDK.
 *
 * `context-budget.test.ts` proves the bound exists with a fake provider that rejects when its
 * signal aborts. The real client does not: once the response has begun, an abort makes its
 * iterator return quietly (openai 4.104, `streaming.js`). MEASURED 2026-09-26: a provider that sent
 * its headers and a thought and then went quiet came out of the bound as an empty answer, was asked
 * again for a second full bound, and ended RUN_FINISHED with `laf.empty_answer`; one caught mid-prose
 * came out as `laf:provider_stream_cut`. Every OpenRouter request has begun within a second, so
 * this is the ordinary shape of a timeout here, not an edge of it.
 */

type Event = Record<string, unknown> & { type: string };

const INPUT = {
  threadId: "t1",
  runId: "r1",
  messages: [{ id: "u1", role: "user", content: "주간 매출 정리해줘" }],
  tools: [
    {
      name: "computer_read",
      description: "읽는다",
      parameters: { type: "object", properties: {} },
    },
  ],
  context: [],
  forwardedProps: {},
  state: {},
};

const BOUND_MS = 300;

const eventsOf = (body: string) =>
  body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as Event);

const kinds = (events: Event[]) => events.map((event) => event.type);

describe("a request that outlives its bound, through the real SDK", () => {
  const fakes: FakeProvider[] = [];
  afterAll(() => {
    for (const fake of fakes) fake.stop();
  });

  async function run(behaviour: Behaviour) {
    process.env.OPENAI_API_KEY ??= "test-key";
    const { runAgent } = await import("../src/index");
    const { createProvider } = await import("../src/provider");
    const fake = startFakeProvider([behaviour]);
    fakes.push(fake);
    const provider = createProvider(
      new OpenAI({ apiKey: "test-key", baseURL: fake.url, maxRetries: 0 }),
    );
    const logged: Array<Record<string, unknown>> = [];
    const keep = (line: unknown) => {
      try {
        logged.push(JSON.parse(String(line)) as Record<string, unknown>);
      } catch {
        // Not one of ours.
      }
    };
    const spies = [
      spyOn(console, "log").mockImplementation(keep),
      spyOn(console, "warn").mockImplementation(keep),
      spyOn(console, "error").mockImplementation(keep),
    ];
    try {
      const response = await runAgent(INPUT as never, provider, {
        timeoutMs: BOUND_MS,
      });
      return {
        events: eventsOf(await response.text()),
        requests: fake.requests.length,
        logged,
      };
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }

  test("a stream that began and then went quiet ends on the timeout, asked once", async () => {
    const { events, requests, logged } = await run({ kind: "stall" });

    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      message: "laf:model_timed_out",
    });
    expect(kinds(events)).not.toContain("RUN_FINISHED");
    // Not an empty answer, and so not asked a second time for another whole bound.
    expect(events.some((event) => event.name === "laf.empty_answer")).toBe(
      false,
    );
    expect(requests).toBe(1);
    expect(logged.some((line) => line.event === "reply_empty_retrying")).toBe(
      false,
    );
  });

  test("a model still thinking at the bound is a timeout, not an empty answer", async () => {
    const { events, requests } = await run({
      kind: "stall",
      choices: [
        {
          delta: {
            role: "assistant",
            reasoning_details: [{ type: "reasoning.text", text: "음…" }],
          },
        },
      ],
    });

    expect(events.at(-1)?.message).toBe("laf:model_timed_out");
    expect(requests).toBe(1);
  });

  test("prose still arriving at the bound is closed and said as the timeout, not a dropped connection", async () => {
    const { events } = await run({
      kind: "stream",
      chunkDelayMs: 100,
      choices: [
        ...Array.from({ length: 8 }, (_, index) => ({
          delta: { content: `${index}번째 문장. ` },
        })),
        { delta: {}, finish_reason: "stop" },
      ],
    });

    // What arrived stays and is closed properly.
    expect(kinds(events)).toContain("TEXT_MESSAGE_CONTENT");
    expect(kinds(events)).toContain("TEXT_MESSAGE_END");
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      message: "laf:model_timed_out",
    });
    expect(
      events.some((event) => event.message === "laf:provider_stream_cut"),
    ).toBe(false);
  });

  test("a call caught mid-arguments at the bound is closed and answered, never left open", async () => {
    const { events } = await run({
      kind: "stall",
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "computer_read" } },
            ],
          },
        },
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"page":' } }],
          },
        },
      ],
    });

    expect(kinds(events)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_ERROR",
    ]);
    expect(events.at(-1)?.message).toBe("laf:model_timed_out");
  });
});
