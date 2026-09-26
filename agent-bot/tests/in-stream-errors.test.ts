import { afterAll, describe, expect, spyOn, test } from "bun:test";
import OpenAI from "openai";
import { isRetryable, runErrorCodeOf, statusOf } from "../src/log";
import {
  type Behaviour,
  type FakeProvider,
  says,
  startFakeProvider,
} from "./fake-provider";

/**
 * A provider that fails AFTER its response has begun says so inside the stream, and the SDK throws
 * that with no HTTP status — the provider's number is in `code`. MEASURED 2026-09-26: an in-stream
 * 429 ended the run as `laf:model_failed` ("ask again") rather than `laf:model_rate_limited`
 * ("give it a moment"), and an in-stream 502 was never retried.
 */

type Event = Record<string, unknown> & { type: string };

const INPUT = {
  threadId: "t1",
  runId: "r1",
  messages: [{ id: "u1", role: "user", content: "오늘 주문 몇 건이야" }],
  tools: [],
  context: [],
  forwardedProps: {},
  state: {},
};

const eventsOf = (body: string) =>
  body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as Event);

describe("the status an error carries, whatever shape it arrived in", () => {
  test("an HTTP status wins", () => {
    expect(statusOf({ status: 503, code: 429 })).toBe(503);
  });

  test("a provider's number inside the stream is read from `code`, or from `error.code`", () => {
    expect(statusOf({ status: undefined, code: 429 })).toBe(429);
    expect(statusOf({ error: { code: 502 } })).toBe(502);
    expect(statusOf({ code: "429" })).toBe(429);
    expect(runErrorCodeOf({ code: 429 })).toBe("laf:model_rate_limited");
    expect(isRetryable({ code: 429 })).toBe(false);
    expect(isRetryable({ error: { code: 503 } })).toBe(true);
  });

  test("a code that is not an HTTP status is no status at all", () => {
    for (const code of ["ECONNRESET", "server_error", 42, 1000, "4290", null]) {
      expect(statusOf({ code })).toBeUndefined();
    }
    expect(runErrorCodeOf({ code: "server_error" })).toBe("laf:model_failed");
  });
});

describe("an in-stream error, through the real SDK", () => {
  const fakes: FakeProvider[] = [];
  afterAll(() => {
    for (const fake of fakes) fake.stop();
  });

  async function run(script: Behaviour[]) {
    process.env.OPENAI_API_KEY ??= "test-key";
    const { runAgent } = await import("../src/index");
    const { createProvider } = await import("../src/provider");
    const fake = startFakeProvider(script);
    fakes.push(fake);
    const provider = createProvider(
      new OpenAI({ apiKey: "test-key", baseURL: fake.url, maxRetries: 0 }),
    );
    const spies = [
      spyOn(console, "log").mockImplementation(() => {}),
      spyOn(console, "warn").mockImplementation(() => {}),
      spyOn(console, "error").mockImplementation(() => {}),
    ];
    try {
      const response = await runAgent(INPUT as never, provider, {
        timeoutMs: 5000,
      });
      return {
        events: eventsOf(await response.text()),
        requests: fake.requests.length,
      };
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }

  test("a 429 is the rate limit, and is not asked again at once", async () => {
    const { events, requests } = await run([
      { kind: "stream-error", code: 429 },
      { kind: "stream", choices: says("세 건입니다.") },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      message: "laf:model_rate_limited",
    });
    expect(requests).toBe(1);
  });

  test("a 502 is retried once, like one that came as a status", async () => {
    const { events, requests } = await run([
      { kind: "stream-error", code: 502 },
      { kind: "stream", choices: says("세 건입니다.") },
    ]);
    expect(requests).toBe(2);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });

  test("an error with no number stays the model's failure", async () => {
    const { events, requests } = await run([
      { kind: "stream-error", code: "server_error" },
    ]);
    expect(events.at(-1)?.message).toBe("laf:model_failed");
    expect(requests).toBe(1);
  });
});
