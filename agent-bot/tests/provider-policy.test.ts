import { afterAll, describe, expect, spyOn, test } from "bun:test";
import OpenAI from "openai";
import { type FakeProvider, startFakeProvider } from "./fake-provider";

/**
 * Which endpoints may answer, and when a request is sent twice (agent-harness-design row 7, R9).
 *
 * Through the REAL SDK against a fake endpoint, because both halves were the SDK's own decisions
 * before: it retried a 429, a 5xx and a dropped connection twice, silently, and on OpenRouter every
 * retry is a new routing decision — a way off the endpoint holding the conversation's cache.
 */

type Event = Record<string, unknown> & { type: string };

const fakes: FakeProvider[] = [];
afterAll(() => {
  for (const fake of fakes) fake.stop();
});

const eventsOf = (body: string): Event[] =>
  body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as Event);

const INPUT = {
  threadId: "thread_owner_chat",
  runId: "r1",
  messages: [{ id: "u1", role: "user", content: "안녕" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: { botId: "agent_miso" },
};

const answered = {
  kind: "stream" as const,
  choices: [{ delta: { content: "안녕하세요." } }, { finish_reason: "stop" }],
};

async function overTheWire(
  script: Parameters<typeof startFakeProvider>[0],
  routing: import("../src/provider").ProviderRouting | null = null,
) {
  process.env.OPENAI_API_KEY ??= "test-key";
  const { runAgent } = await import("../src/index");
  const { createProvider } = await import("../src/provider");
  const fake = startFakeProvider(script);
  fakes.push(fake);
  const provider = createProvider(
    // As production builds it: the SDK retries nothing on its own.
    new OpenAI({ apiKey: "test-key", baseURL: fake.url, maxRetries: 0 }),
    routing,
  );
  const logged: string[] = [];
  const spies = [
    spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    }),
    spyOn(console, "warn").mockImplementation((line: unknown) => {
      logged.push(String(line));
    }),
    spyOn(console, "error").mockImplementation((line: unknown) => {
      logged.push(String(line));
    }),
  ];
  try {
    const response = await runAgent(INPUT as never, provider);
    return { fake, events: eventsOf(await response.text()), logged };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe("retries are the loop's, once, and said", () => {
  test("a server error before a byte arrived is sent once more, and the log says so", async () => {
    const { fake, events, logged } = await overTheWire([
      { kind: "status", status: 502 },
      answered,
    ]);
    expect(fake.requests).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    expect(logged.some((line) => line.includes("provider_retrying"))).toBe(
      true,
    );
  });

  test("the retry is said on the wire too, as a fact the server's run meter counts", async () => {
    const { events } = await overTheWire([
      { kind: "status", status: 502 },
      answered,
    ]);
    const retries = events.filter(
      (event) => event.type === "CUSTOM" && event.name === "laf.retry",
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ value: { kind: "provider" } });
  });

  test("a 429 is never retried: a refusal wants waiting, and the run says it was refused", async () => {
    const { fake, events } = await overTheWire([
      { kind: "status", status: 429, retryAfter: "1" },
      answered,
    ]);
    expect(fake.requests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      message: "laf:model_rate_limited",
    });
  });

  test("a second server error ends the run: once is the whole of the retry", async () => {
    const { fake, events } = await overTheWire([
      { kind: "status", status: 503 },
      { kind: "status", status: 503 },
      answered,
    ]);
    expect(fake.requests).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      message: "laf:model_unavailable",
    });
  });
});

describe("which endpoints may answer", () => {
  test("the deployment's routing rides on every request, on the body OpenRouter reads", async () => {
    const { fake } = await overTheWire([answered], {
      order: ["z-ai"],
      ignore: ["wafer", "relace"],
    });
    expect(fake.requests[0]?.body.provider).toEqual({
      order: ["z-ai"],
      ignore: ["wafer", "relace"],
    });
  });

  test("none is sent when none is configured", async () => {
    const { fake } = await overTheWire([answered]);
    expect(fake.requests[0]?.body).not.toHaveProperty("provider");
  });

  /*
   * KEYED BY MODEL. Which endpoints are good is a fact about one model's endpoints, so a deployment
   * that swaps its model sends no routing until the new model's line is written.
   */
  test("read from the environment, for this model only, and only for OpenRouter", async () => {
    const { providerRoutingOf } = await import("../src/provider");
    const router = "https://openrouter.ai/api/v1";
    const env = {
      BOT_PROVIDER_POLICY: JSON.stringify({
        "z-ai/glm-5.3-flash": {
          order: ["z-ai"],
          ignore: ["wafer", " relace "],
        },
        "vendor/other": { allow_fallbacks: false },
      }),
    };
    expect(providerRoutingOf(env, router, "z-ai/glm-5.3-flash")).toEqual({
      order: ["z-ai"],
      ignore: ["wafer", "relace"],
    });
    expect(providerRoutingOf(env, router, "vendor/other")).toEqual({
      allow_fallbacks: false,
    });
    // Another model — the one a deployment just swapped to — gets nothing it was not measured for.
    expect(providerRoutingOf(env, router, "xiaomi/mimo-v2.6-pro")).toBeNull();
    // Nothing said: the measured lines, because laf-control's env writer cannot carry JSON to a
    // customer's VM. A model nobody measured still gets nothing.
    expect(providerRoutingOf({}, router, "xiaomi/mimo-v2.6-pro")).toEqual({
      order: ["xiaomi"],
    });
    expect(providerRoutingOf({}, router, "z-ai/glm-5.3-flash")).toEqual({
      order: ["z-ai"],
      ignore: ["wafer", "relace"],
    });
    // DeepSeek without the endpoint that cut parallel bridged calls three times in three.
    expect(
      providerRoutingOf({}, router, "deepseek/deepseek-v4.1-flash")?.ignore,
    ).toContain("sail-research");
    expect(providerRoutingOf({}, router, "vendor/unmeasured")).toBeNull();
    // Said as `{}`: the operator turned routing off, and nothing is sent.
    expect(
      providerRoutingOf(
        { BOT_PROVIDER_POLICY: "{}" },
        router,
        "xiaomi/mimo-v2.6-pro",
      ),
    ).toBeNull();
    // Said unreadably: nothing sent, never half-applied.
    expect(
      providerRoutingOf(
        { BOT_PROVIDER_POLICY: "{not json" },
        router,
        "z-ai/glm-5.3-flash",
      ),
    ).toBeNull();
    // An unknown body field is a 400 on OpenAI's own API.
    expect(
      providerRoutingOf(env, "https://api.openai.com/v1", "z-ai/glm-5.3-flash"),
    ).toBeNull();
    expect(providerRoutingOf(env, undefined, "z-ai/glm-5.3-flash")).toBeNull();
  });
});
