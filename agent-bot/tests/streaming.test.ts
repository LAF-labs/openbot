import { describe, expect, test } from "bun:test";

/**
 * That a Bot's tool call reaches the surface FRAGMENT BY FRAGMENT, not in one lump at the end.
 *
 * Speaking in a room is a tool call, and every Bot a person creates in this product runs through
 * `agent-bot` — so if this service buffers, a room shows nothing at all while a Bot writes and then
 * the whole message appears at once. That is what it used to do.
 *
 * Driven through the real HTTP surface with a fake provider, because the buffering lived in the
 * loop that reads the provider's stream and nothing below that layer would have caught it.
 */

type Chunk = {
  choices: Array<{ delta: Record<string, unknown> }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

/** A provider that streams a `send_message` call the way OpenAI-compatible endpoints do. */
function fakeCompletion(chunks: Chunk[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

const SPEECH: Chunk[] = [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "call_1", function: { name: "send_message" } },
          ],
        },
      },
    ],
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '{"text":"안녕' } }],
        },
      },
    ],
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '하세요"}' } }],
        },
      },
    ],
  },
];

async function eventsFor(chunks: Chunk[]): Promise<string[]> {
  process.env.OPENAI_API_KEY ??= "test-key";
  const { runAgent } = await import("../src/index");
  const response = await runAgent(
    {
      threadId: "t1",
      runId: "r1",
      messages: [{ id: "m1", role: "user", content: "인사해줘" }],
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
    } as never,
    async () => fakeCompletion(chunks) as never,
  );
  const body = await response.text();
  return body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
}

describe("a tool call on the wire", () => {
  test("opens as soon as its name is known and forwards every fragment", async () => {
    const events = (await eventsFor(SPEECH)).map(
      (line) => JSON.parse(line) as { type: string; delta?: string },
    );
    const kinds = events.map((event) => event.type);

    expect(kinds).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);

    // TWO args events, in order, each carrying only its own fragment: that is what lets a watcher
    // read a partial value. One event carrying the whole thing is what it used to send.
    const deltas = events
      .filter((event) => event.type === "TOOL_CALL_ARGS")
      .map((event) => event.delta);
    expect(deltas).toEqual(['{"text":"안녕', '하세요"}']);
  });

  test("a call whose name never arrived is never opened, and never closed", async () => {
    const kinds = (
      await eventsFor([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: "{" } }],
              },
            },
          ],
        },
      ])
    ).map((line) => (JSON.parse(line) as { type: string }).type);

    expect(kinds).not.toContain("TOOL_CALL_START");
    expect(kinds).not.toContain("TOOL_CALL_END");
  });
});

/**
 * The effort the run was asked for, on the request this service makes.
 *
 * EVERY BOT ANYBODY CREATES RUNS THROUGH HERE. Only a Bot a package shipped is `built_in`; the rest
 * are remote and are answered by this service, so a model setting that reaches only the built-in
 * configuration reaches nothing anybody will ever make. That is what shipped, and it read as
 * working because the Bot it was tried on answered perfectly well with the setting going nowhere.
 *
 * The words on the wire are the product's, not the provider's: the caller says `thorough` and each
 * service translates into whatever its own API spells it as.
 */
describe("how hard to think", () => {
  /** Run once with these forwarded props and hand back the request the provider was given. */
  async function requestFor(
    forwardedProps: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    process.env.OPENAI_API_KEY ??= "test-key";
    const { runAgent } = await import("../src/index");
    let sent: Record<string, unknown> = {};
    const response = await runAgent(
      {
        threadId: "t1",
        runId: "r1",
        messages: [{ id: "m1", role: "user", content: "안녕" }],
        tools: [],
        context: [],
        forwardedProps,
        state: {},
      } as never,
      /*
       * The FIRST request, not the last.
       *
       * `fakeCompletion([])` is an empty completion, and an empty completion is now retried once
       * at a lower effort — so recording every call would report `medium` for a Bot set to
       * `thorough` and prove the opposite of what this asks.
       */
      (async (request: Record<string, unknown>) => {
        if (Object.keys(sent).length === 0) sent = request;
        return fakeCompletion([]) as never;
      }) as never,
    );
    await response.text();
    return sent;
  }

  test("carries the three the product names, in this API's words", async () => {
    expect((await requestFor({ effort: "quick" })).reasoning_effort).toBe(
      "low",
    );
    expect((await requestFor({ effort: "balanced" })).reasoning_effort).toBe(
      "medium",
    );
    expect((await requestFor({ effort: "thorough" })).reasoning_effort).toBe(
      "high",
    );
  });

  test("sends nothing at all when nothing was asked for", async () => {
    // A deployment whose model does not reason forwards no effort, and must then get exactly the
    // request this service made before the setting existed — not a default, not a null.
    expect(await requestFor({})).not.toHaveProperty("reasoning_effort");
    // A value from somewhere else is silence too, rather than something passed through to the API.
    expect(await requestFor({ effort: "maximum" })).not.toHaveProperty(
      "reasoning_effort",
    );
  });
});

describe("what a turn cost", () => {
  test("the provider's counts leave as one usage event, before the finish", async () => {
    const events = (
      await eventsFor([
        {
          choices: [{ delta: { content: "안녕하세요" } }],
        },
        // The way OpenAI-compatible endpoints send it: a final chunk with no choices at all.
        {
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 8,
            total_tokens: 128,
          },
        },
      ])
    ).map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          name?: string;
          value?: Record<string, unknown>;
        },
    );

    const kinds = events.map((event) => event.type);
    expect(kinds).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "CUSTOM",
      "RUN_FINISHED",
    ]);

    const usage = events.find((event) => event.type === "CUSTOM");
    expect(usage?.name).toBe("laf.model.usage");
    expect(usage?.value).toMatchObject({
      promptTokens: 120,
      completionTokens: 8,
      totalTokens: 128,
    });
    // Counts and a model name only. The turn's words must not ride the metering event.
    expect(JSON.stringify(usage?.value)).not.toContain("안녕");
  });

  test("a provider that reports no usage produces no usage event", async () => {
    const kinds = (
      await eventsFor([{ choices: [{ delta: { content: "네" } }] }])
    ).map((line) => (JSON.parse(line) as { type: string }).type);
    expect(kinds).not.toContain("CUSTOM");
    expect(kinds.at(-1)).toBe("RUN_FINISHED");
  });
});

describe("a provider failure on a customer's screen", () => {
  /*
   * The RUN_ERROR message is a fact code from a closed set, never the provider's sentence. The day
   * the stealth alpha died, the provider's 404 body named its vendor, the real model and a URL —
   * and that stream ends on a customer's screen. The full error still goes to this service's log;
   * what leaves the building is only which of the three next steps applies.
   */
  async function runErrorFor(thrown: unknown): Promise<string> {
    process.env.OPENAI_API_KEY ??= "test-key";
    const { runAgent } = await import("../src/index");
    const response = await runAgent(
      {
        threadId: "t-err",
        runId: "r-err",
        messages: [{ id: "m1", role: "user", content: "인사해줘" }],
        tools: [],
        context: [],
        forwardedProps: {},
        state: {},
      } as never,
      async () => {
        throw thrown;
      },
    );
    const body = await response.text();
    const line = body.split("\n").find((entry) => entry.includes("RUN_ERROR"));
    return JSON.parse((line ?? "").replace(/^data: /, "")).message;
  }

  test("a rate limit says to wait, not that something broke", async () => {
    const limited = Object.assign(new Error("429 slow down"), { status: 429 });
    expect(await runErrorFor(limited)).toBe("laf:model_rate_limited");
  });

  test("any other refusal is the deployment's problem, in one word", async () => {
    const dead = Object.assign(
      new Error(
        "404 Thank you for participating in the Stealth Ox Alpha testing period.",
      ),
      { status: 404 },
    );
    expect(await runErrorFor(dead)).toBe("laf:model_unavailable");
  });

  test("a network failure carries no status and no vendor words", async () => {
    const message = await runErrorFor(new Error("fetch failed: ECONNRESET"));
    expect(message).toBe("laf:model_failed");
    expect(message).not.toContain("ECONNRESET");
  });
});
