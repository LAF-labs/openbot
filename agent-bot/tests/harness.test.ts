import { afterAll, describe, expect, spyOn, test } from "bun:test";
import OpenAI from "openai";
import { type FakeProvider, startFakeProvider } from "./fake-provider";

/**
 * What the request looks like to the provider, beside the conversation: the `now` tool this service
 * answers itself, the session that keeps a conversation on one provider's cache, the effort in the
 * model's own words, and what the usage row learns about the request (agent-harness-design rows
 * 3, 6, 7 and 11).
 *
 * Through the REAL SDK against a fake endpoint where a header or the body's exact shape is the
 * point: a scripted iterator cannot show what the SDK actually puts on the wire.
 */

type Event = Record<string, unknown> & { type: string };

const fakes: FakeProvider[] = [];
afterAll(() => {
  for (const fake of fakes) fake.stop();
});

const quiet = () => {
  const spies = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
};

const eventsOf = (body: string): Event[] =>
  body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as Event);

const INPUT = {
  threadId: "thread_owner_chat",
  runId: "r1",
  messages: [{ id: "u1", role: "user", content: "지금 몇 시야?" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {
    botId: "agent_miso",
    effort: "balanced",
    timeZone: "Asia/Dubai",
  },
};

async function overTheWire(
  script: Parameters<typeof startFakeProvider>[0],
  input: object = INPUT,
) {
  process.env.OPENAI_API_KEY ??= "test-key";
  const { runAgent } = await import("../src/index");
  const { createProvider } = await import("../src/provider");
  const fake = startFakeProvider(script);
  fakes.push(fake);
  const provider = createProvider(
    new OpenAI({ apiKey: "test-key", baseURL: fake.url, maxRetries: 0 }),
  );
  const restore = quiet();
  try {
    const response = await runAgent(input as never, provider);
    return { fake, events: eventsOf(await response.text()) };
  } finally {
    restore();
  }
}

describe("now — the Bot's `date`", () => {
  test("is answered inside the run, in the person's zone, and the model is asked again with it", async () => {
    const { fake, events } = await overTheWire([
      {
        kind: "stream",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_now",
                  function: { name: "now", arguments: "{}" },
                },
              ],
            },
          },
          { finish_reason: "tool_calls" },
        ],
      },
      {
        kind: "stream",
        choices: [
          { delta: { content: "지금은 두바이 시각으로 알려 드릴게요." } },
          { finish_reason: "stop" },
        ],
      },
    ]);

    expect(fake.requests).toHaveLength(2);
    const result = events.find((event) => event.type === "TOOL_CALL_RESULT");
    const reading = JSON.parse(String(result?.content)) as Record<
      string,
      string
    >;
    expect(reading.timeZone).toBe("Asia/Dubai");
    expect(reading.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(reading.time).toMatch(/^\d{2}:\d{2}$/);
    expect(reading.weekday).toMatch(/^[일월화수목금토]요일$/);
    // The second request carries the call and its answer, as any lookup would.
    const second = fake.requests[1]?.body.messages as Array<{ role: string }>;
    expect(second.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });

  test("its minutes are the clock's, read in that zone", async () => {
    const { nowReading } = await import("../../shared/tools/now");
    const at = new Date("2026-09-24T21:05:00Z");
    expect(nowReading(at, "Asia/Seoul")).toEqual({
      date: "2026-09-25",
      weekday: "금요일",
      time: "06:05",
      timeZone: "Asia/Seoul",
    });
    expect(nowReading(at, "Asia/Dubai")).toEqual({
      date: "2026-09-25",
      weekday: "금요일",
      time: "01:05",
      timeZone: "Asia/Dubai",
    });
    // A zone nobody knows is Seoul, never this container's.
    expect(nowReading(at, "Mars/Olympus").timeZone).toBe("Asia/Seoul");
  });
});

describe("the provider is told which conversation this is — in hashes", () => {
  test("x-session-id per conversation and user per Bot, and neither is the id itself", async () => {
    const said = {
      kind: "stream" as const,
      choices: [{ delta: { content: "네." } }, { finish_reason: "stop" }],
    };
    const first = await overTheWire([said]);
    const again = await overTheWire([said], { ...INPUT, runId: "r2" });
    const other = await overTheWire([said], {
      ...INPUT,
      threadId: "thread_other",
    });

    const session = (fake: FakeProvider) =>
      fake.requests[0]?.headers["x-session-id"];
    expect(session(first.fake)).toMatch(/^[0-9a-f]{32}$/);
    // The same conversation is the same session, run after run.
    expect(session(again.fake)).toBe(session(first.fake));
    expect(session(other.fake)).not.toBe(session(first.fake));
    const body = JSON.stringify(first.fake.requests[0]?.body);
    const headers = JSON.stringify(first.fake.requests[0]?.headers);
    for (const raw of ["thread_owner_chat", "agent_miso"]) {
      expect(body).not.toContain(raw);
      expect(headers).not.toContain(raw);
    }
    expect(first.fake.requests[0]?.body.user).toMatch(/^[0-9a-f]{32}$/);
    // Not in the body, where an endpoint that is not OpenRouter would refuse it.
    expect(first.fake.requests[0]?.body).not.toHaveProperty("session_id");
  });
});

describe("the usage row learns what caching needs", () => {
  test("provider, cost, cache writes and reasoning, as OpenRouter reports them", async () => {
    const { events } = await overTheWire([
      {
        kind: "stream",
        provider: "Z.AI",
        choices: [{ delta: { content: "네." } }, { finish_reason: "stop" }],
        usage: {
          prompt_tokens: 8072,
          completion_tokens: 43,
          total_tokens: 8115,
          cost: 0.0012323,
          prompt_tokens_details: { cached_tokens: 7680, cache_write_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      },
    ]);
    const usage = events.find((event) => event.name === "laf.model.usage");
    expect(usage?.value).toMatchObject({
      promptTokens: 8072,
      cachedPromptTokens: 7680,
      cacheWriteTokens: 0,
      reasoningTokens: 12,
      costUsd: 0.0012323,
      provider: "Z.AI",
    });
  });

  test("an endpoint that says none of it gets none of it written as zero", async () => {
    const { events } = await overTheWire([
      {
        kind: "stream",
        choices: [{ delta: { content: "네." } }, { finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ]);
    const value = events.find((event) => event.name === "laf.model.usage")
      ?.value as Record<string, unknown>;
    for (const key of [
      "cachedPromptTokens",
      "cacheWriteTokens",
      "reasoningTokens",
      "costUsd",
      "provider",
    ]) {
      expect(value).not.toHaveProperty(key);
    }
  });
});

describe("effort, in the model's own words", () => {
  const effortFor = async (model: string, effort: string) => {
    const { reasoningEffortOf } = await import("../src/transcript");
    return reasoningEffortOf({ forwardedProps: { effort } } as never, model);
  };

  test("GLM-5.3 is sent its own three words, never `medium`, which it does not define", async () => {
    const words = await Promise.all(
      ["quick", "balanced", "thorough"].map((effort) =>
        effortFor("z-ai/glm-5.3-flash", effort),
      ),
    );
    expect(words).toEqual(["low", "high", "max"]);
    // Three settings on the profile, three different requests: no control that saves nothing.
    expect(new Set(words).size).toBe(3);
  });

  test("MiMo-V2.6 defines no effort, so none is sent — not three words that think alike", async () => {
    for (const model of ["xiaomi/mimo-v2.6-pro", "xiaomi/mimo-v2.6-flash"]) {
      const words = await Promise.all(
        ["quick", "balanced", "thorough"].map((effort) =>
          effortFor(model, effort),
        ),
      );
      expect(words).toEqual([undefined, undefined, undefined]);
    }
  });

  test("any other model keeps the OpenAI words, and silence stays silence", async () => {
    expect(await effortFor("gpt-5.5", "balanced")).toBe("medium");
    expect(await effortFor("gpt-5.5", "nonsense")).toBeUndefined();
  });
});
