import { afterAll, describe, expect, spyOn, test } from "bun:test";
import OpenAI from "openai";
import { type FakeProvider, startFakeProvider } from "./fake-provider";

/**
 * A person presses Stop while the model is still thinking.
 *
 * The runtime drops the request, which cancels this run's stream — and nothing listened. The run
 * noticed only when an `emit` threw, and a reasoning model emits nothing while it thinks, so the
 * provider went on thinking, and billing, until its first word or the bound. MEASURED 2026-09-26:
 * the provider's signal was never aborted.
 */

const INPUT = {
  threadId: "t1",
  runId: "r1",
  messages: [{ id: "u1", role: "user", content: "이번 달 재고 정리해줘" }],
  tools: [],
  context: [],
  forwardedProps: {},
  state: {},
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function quiet() {
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
  return {
    logged,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

describe("a reader that leaves while the model thinks", () => {
  const fakes: FakeProvider[] = [];
  afterAll(() => {
    for (const fake of fakes) fake.stop();
  });

  test("aborts the request in flight, at once", async () => {
    process.env.OPENAI_API_KEY ??= "test-key";
    const { runAgent } = await import("../src/index");
    const started = Date.now();
    let abortedAt: number | null = null;
    const provider = (async (
      _request: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      options?.signal?.addEventListener("abort", () => {
        abortedAt = Date.now() - started;
      });
      return (async function* () {
        // Thinking: a thought every 100 ms and not a word, for well past the Stop.
        for (let index = 0; index < 10; index += 1) {
          await sleep(100);
          yield {
            choices: [
              {
                index: 0,
                delta: {
                  reasoning_details: [{ type: "reasoning.text", text: "음" }],
                },
              },
            ],
          };
        }
      })();
    }) as never;
    const log = quiet();
    try {
      const response = await runAgent(INPUT as never, provider, {
        timeoutMs: 5000,
      });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      await reader.read(); // RUN_STARTED
      await sleep(50);
      await reader.cancel(); // Stop
      await sleep(150);
    } finally {
      log.restore();
    }
    expect(abortedAt).not.toBeNull();
    expect(abortedAt as unknown as number).toBeLessThan(400);
  });

  test("through the real SDK, the endpoint sees the request go", async () => {
    process.env.OPENAI_API_KEY ??= "test-key";
    const { runAgent } = await import("../src/index");
    const { createProvider } = await import("../src/provider");
    const fake = startFakeProvider([
      {
        kind: "stall",
        choices: [
          {
            delta: {
              role: "assistant",
              reasoning_details: [{ type: "reasoning.text", text: "음…" }],
            },
          },
        ],
      },
    ]);
    fakes.push(fake);
    const provider = createProvider(
      new OpenAI({ apiKey: "test-key", baseURL: fake.url, maxRetries: 0 }),
    );
    const log = quiet();
    let cancelledAt = 0;
    try {
      const response = await runAgent(INPUT as never, provider, {
        timeoutMs: 5000,
      });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      await reader.read(); // RUN_STARTED
      await sleep(100);
      cancelledAt = fake.now();
      await reader.cancel();
      await sleep(200);
    } finally {
      log.restore();
    }
    const aborted = fake.requests[0]?.abortedAt;
    expect(aborted).toBeDefined();
    expect((aborted as number) - cancelledAt).toBeLessThan(150);
    // Said as a person leaving, never as the model failing.
    expect(log.logged.some((line) => line.event === "consumer_gone")).toBe(
      true,
    );
    expect(log.logged.some((line) => line.event === "run_failed")).toBe(false);
  });
});
