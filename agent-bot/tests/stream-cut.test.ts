import { afterAll, describe, expect, spyOn, test } from "bun:test";
import OpenAI from "openai";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import {
  type Behaviour,
  calls,
  type FakeProvider,
  says,
  startFakeProvider,
} from "./fake-provider";

/**
 * A stream that stops before the model said it was done.
 *
 * MEASURED (audit A2, 2026-09-10, row 8): a provider that sent "주문이 세 건 " and "들어왔고, 그중"
 * and then closed the connection — a clean EOF and a reset after the flush, both — reached the
 * person as a finished answer: TEXT_MESSAGE_END, RUN_FINISHED, `done` in the ledger, and nothing
 * anywhere saying half a sentence was missing. A routine delivered the half as its morning report.
 *
 * The SDK is why it was invisible: on a body that ends without `data: [DONE]` its iterator ends
 * silently. The evidence is in the chunks — a completed stream carries a `finish_reason` on its
 * last choice, and a usage chunk only once the end is reached — and these pin that rule at the
 * seam and through the real client pointed at a real (fake) endpoint.
 */

type Chunk = {
  choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

type Event = Record<string, unknown> & { type: string };

const INPUT = {
  threadId: "t1",
  runId: "r1",
  messages: [{ id: "u1", role: "user", content: "주문 확인해줘" }],
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

const eventsOf = (body: string) =>
  body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as Event);

const kinds = (events: Event[]) => events.map((event) => event.type);

/** Every log line the run wrote, parsed, whatever its level. */
function captureLog() {
  const lines: Array<Record<string, unknown>> = [];
  const keep = (line: unknown) => {
    try {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
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
    lines,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/** One run over a scripted iterator: the provider seam, which every other test here uses. */
async function runOver(source: () => AsyncIterable<Chunk>) {
  process.env.OPENAI_API_KEY ??= "test-key";
  const { runAgent } = await import("../src/index");
  const log = captureLog();
  try {
    const response = await runAgent(
      INPUT as never,
      async () => source() as never,
    );
    const body = await response.text();
    return { events: eventsOf(body), log: log.lines };
  } finally {
    log.restore();
  }
}

const scripted = (chunks: Chunk[]) => () => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) yield chunk;
  },
});

describe("a stream cut mid-way", () => {
  test("ends the run as failed with its own code, never as finished", async () => {
    // The audit's exact chunks: two fragments of prose, then nothing — no finish, no usage.
    const { events } = await runOver(
      scripted([
        { choices: [{ delta: { content: "주문이 세 건 " } }] },
        { choices: [{ delta: { content: "들어왔고, 그중" } }] },
      ]),
    );

    expect(kinds(events)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      // The half that arrived is closed properly, so it stays on screen and in the thread…
      "TEXT_MESSAGE_END",
      // …and the run fails, so the ledger, /failures and the person are all told.
      "RUN_ERROR",
    ]);
    expect(events.at(-1)?.message).toBe("laf:provider_stream_cut");
  });

  test("a call cut partway through its arguments is closed and answered, never left to run", async () => {
    // Half an argument list, forwarded live, then the connection goes. Left open, the browser
    // would parse `{"url": "` and put an English JSON error in the transcript.
    const { events } = await runOver(
      scripted([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "c1", function: { name: "computer_read" } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '{"url": "' } },
                ],
              },
            },
          ],
        },
      ]),
    );

    expect(kinds(events)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_ERROR",
    ]);
    const result = events.find((event) => event.type === "TOOL_CALL_RESULT");
    expect(JSON.parse(String(result?.content))).toEqual({
      ok: false,
      code: "laf:provider_stream_cut",
      reason: toolResultText("laf:provider_stream_cut"),
    });
    expect(events.at(-1)?.message).toBe("laf:provider_stream_cut");
  });

  test("a provider that fails after the first words is the same cut, not a model failure", async () => {
    const { events } = await runOver(() => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "주문이 세 건 " } }] };
        throw new Error("terminated");
      },
    }));
    expect(kinds(events)).toContain("TEXT_MESSAGE_END");
    expect(events.at(-1)?.type).toBe("RUN_ERROR");
    expect(events.at(-1)?.message).toBe("laf:provider_stream_cut");
  });

  test("says so in the log as facts, with none of the words that arrived", async () => {
    const { log } = await runOver(
      scripted([
        { choices: [{ delta: { content: "주문이 세 건 " } }] },
        { choices: [{ delta: { content: "들어왔고, 그중" } }] },
      ]),
    );
    const cut = log.find((line) => line.event === "reply_cut");
    expect(cut).toMatchObject({
      level: "error",
      reason: "ended_without_finish",
      chars: "주문이 세 건 들어왔고, 그중".length,
    });
    expect(JSON.stringify(log)).not.toContain("주문");
    // One line for one cut: it is not a model failure as well.
    expect(log.some((line) => line.event === "run_failed")).toBe(false);
  });

  test("a stream that ends properly is a finish, whichever of the two ends it sends", async () => {
    // A finish reason and no usage: the rule is not the usage chunk, which not every provider sends.
    const finished = await runOver(
      scripted([
        { choices: [{ delta: { content: "네." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
    expect(kinds(finished.events).at(-1)).toBe("RUN_FINISHED");

    // A usage chunk and no finish reason: the provider computed the usage, so it reached the end.
    const counted = await runOver(
      scripted([
        { choices: [{ delta: { content: "네." } }] },
        {
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        },
      ]),
    );
    expect(kinds(counted.events).at(-1)).toBe("RUN_FINISHED");
  });

  test("nothing at all is an empty answer, not a cut", async () => {
    // A body that ends before the first token has put nothing on the wire to mark. It is the empty
    // turn the loop already asks again, which is the same recovery a cut that early wants.
    const { events } = await runOver(scripted([]));
    expect(kinds(events)).not.toContain("RUN_ERROR");
    expect(events.map((event) => event.name)).toContain("laf.empty_answer");
    expect(kinds(events).at(-1)).toBe("RUN_FINISHED");
  });
});

describe("a reader that leaves partway", () => {
  /*
   * A person's Stop, as this service sees it: the runtime cancels the request and the next enqueue
   * throws. Measured in the audit as `run_failed code=laf:model_failed reason="Invalid state:
   * Controller is already closed"` — a Stop counted as a model outage. After the first token it
   * must not read as a cut either.
   */
  test("is logged as the consumer leaving, and not as a failure or a cut", async () => {
    process.env.OPENAI_API_KEY ??= "test-key";
    const { runAgent } = await import("../src/index");
    const log = captureLog();
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = () => {};
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    try {
      const response = await runAgent(
        INPUT as never,
        async () =>
          ({
            async *[Symbol.asyncIterator]() {
              try {
                yield { choices: [{ delta: { content: "주문이 " } }] };
                await released;
                yield { choices: [{ delta: { content: "세 건" } }] };
                yield { choices: [{ delta: {}, finish_reason: "stop" }] };
              } finally {
                finished();
              }
            },
          }) as never,
      );
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let seen = "";
      while (!seen.includes("TEXT_MESSAGE_CONTENT")) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        seen += new TextDecoder().decode(value);
      }
      await reader.cancel();
      release();
      // The provider's stream is left — which is what aborts the request — once the run notices.
      await done;
      await Bun.sleep(10);
    } finally {
      log.restore();
    }

    const events = log.lines.map((line) => line.event);
    expect(events).toContain("consumer_gone");
    expect(events).not.toContain("run_failed");
    expect(events).not.toContain("reply_cut");
  });
});

describe("the same cut, through the real SDK", () => {
  const fakes: FakeProvider[] = [];
  afterAll(() => {
    for (const fake of fakes) fake.stop();
  });

  async function overTheWire(behaviour: Behaviour) {
    process.env.OPENAI_API_KEY ??= "test-key";
    const { runAgent } = await import("../src/index");
    const { createProvider } = await import("../src/provider");
    const fake = startFakeProvider([behaviour]);
    fakes.push(fake);
    const provider = createProvider(
      new OpenAI({ apiKey: "test-key", baseURL: fake.url, maxRetries: 0 }),
    );
    const log = captureLog();
    try {
      const response = await runAgent(INPUT as never, provider);
      return eventsOf(await response.text());
    } finally {
      log.restore();
    }
  }

  test("a body that ends without [DONE] is the cut, though the SDK never said so", async () => {
    const events = await overTheWire({
      kind: "stream",
      choices: [
        { delta: { content: "주문이 세 건 " } },
        { delta: { content: "들어왔고, 그중" } },
      ],
      end: "eof",
    });
    expect(kinds(events)).toContain("TEXT_MESSAGE_CONTENT");
    expect(kinds(events)).not.toContain("RUN_FINISHED");
    expect(events.at(-1)?.message).toBe("laf:provider_stream_cut");
  });

  test("a connection reset after the flush is the same cut", async () => {
    const events = await overTheWire({
      kind: "stream",
      choices: [{ delta: { content: "주문이 세 건 " } }],
      end: "reset",
    });
    expect(kinds(events)).toContain("TEXT_MESSAGE_CONTENT");
    expect(kinds(events)).not.toContain("RUN_FINISHED");
    expect(events.at(-1)?.message).toBe("laf:provider_stream_cut");
  });

  test("a stream that ends properly is a finish, with its usage", async () => {
    const events = await overTheWire({
      kind: "stream",
      choices: says("주문이 세 건 ", "들어왔습니다."),
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(kinds(events)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "CUSTOM",
      "RUN_FINISHED",
    ]);
  });

  test("a tool call that ends properly goes through as it always did", async () => {
    const events = await overTheWire({
      kind: "stream",
      choices: calls("c1", "computer_read", "{}"),
    });
    expect(kinds(events)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);
  });
});

/*
 * THE CONVERSATION AFTER A CUT MID-CALL.
 *
 * Measured 2026-09-27 on the 지원사업 walk: a provider cut the stream in the middle of a round of
 * `remember` calls, and from then on every 다시 시도 failed the same way. Two things kept it broken,
 * and each is modelled here: the half-written calls went back to the model on every later request
 * (as `remember({})`, which it copied), and the retry went to the same endpoint under the same
 * session — the request byte for byte, to the endpoint that had just cut it.
 */
describe("a conversation cut mid-call, asked again", () => {
  const fakes: FakeProvider[] = [];
  afterAll(() => {
    for (const fake of fakes) fake.stop();
  });

  const REMEMBER_TOOL = {
    name: "remember",
    description: "사실 하나를 적어 둔다",
    parameters: {
      type: "object",
      properties: { fact: { type: "string" } },
    },
  };

  const cutAnswer = JSON.stringify({
    ok: false,
    code: "laf:provider_stream_cut",
    reason: toolResultText("laf:provider_stream_cut"),
  });

  /** One run through the real SDK, against the fake. */
  async function run(
    fake: FakeProvider,
    threadId: string,
    runId: string,
    messages: unknown[],
  ) {
    process.env.OPENAI_API_KEY ??= "test-key";
    const { runAgent } = await import("../src/index");
    const { createProvider } = await import("../src/provider");
    const provider = createProvider(
      new OpenAI({ apiKey: "test-key", baseURL: fake.url, maxRetries: 0 }),
    );
    const log = captureLog();
    try {
      const response = await runAgent(
        {
          ...INPUT,
          threadId,
          runId,
          messages,
          tools: [REMEMBER_TOOL],
        } as never,
        provider,
      );
      return eventsOf(await response.text());
    } finally {
      log.restore();
    }
  }

  test("the retry leaves the half call out, goes to another endpoint, and answers", async () => {
    const threadId = `cut-${crypto.randomUUID()}`;
    /*
     * An endpoint that cuts this conversation every time, as Sail Research did (3 of 3): whatever
     * is routed under the session the first request came with is cut mid-arguments. Any other
     * session reaches an endpoint that answers whole.
     */
    let cutter: string | undefined;
    const fake = startFakeProvider((ordinal, request) => {
      if (ordinal === 0) cutter = request.headers["x-session-id"];
      if (request.headers["x-session-id"] === cutter) {
        return {
          kind: "stream",
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "c1", function: { name: "remember" } },
                ],
              },
            },
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '{"fact": "가게는' } },
                ],
              },
            },
          ],
          end: "eof",
        };
      }
      return {
        kind: "stream",
        choices: calls(
          "c2",
          "remember",
          '{"fact": "가게는 춘천의 한식당이다."}',
        ),
      };
    });
    fakes.push(fake);

    const asked = {
      id: "u1",
      role: "user",
      content: "춘천에서 한식당 해요. 기억해 둬.",
    };
    const first = await run(fake, threadId, "r1", [asked]);
    expect(first.at(-1)?.message).toBe("laf:provider_stream_cut");
    const answered = first.find((event) => event.type === "TOOL_CALL_RESULT");
    expect(answered?.content).toBe(cutAnswer);

    // The thread as the server files it: the question, the half call, and the cut's answer.
    const stored = [
      asked,
      {
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "remember", arguments: '{"fact": "가게는' },
          },
        ],
      },
      { id: "tool_c1", role: "tool", toolCallId: "c1", content: cutAnswer },
    ];
    const retry = await run(fake, threadId, "r2", stored);

    // The model is not shown the half call, under any id or in any shape.
    const sent = fake.requests[1]?.body.messages as Array<
      Record<string, unknown>
    >;
    expect(JSON.stringify(sent)).not.toContain('"c1"');
    expect(sent.at(-1)).toMatchObject({ role: "user" });
    // Routed afresh: the session it was cut under is not the one it is retried under.
    expect(fake.requests[1]?.headers["x-session-id"]).toBeString();
    expect(fake.requests[1]?.headers["x-session-id"]).not.toBe(cutter);
    // And it answers: the call arrives whole, for the surface to carry out.
    expect(kinds(retry).at(-1)).toBe("RUN_FINISHED");
    const args = retry
      .filter((event) => event.type === "TOOL_CALL_ARGS")
      .map((event) => event.delta)
      .join("");
    expect(JSON.parse(args)).toEqual({ fact: "가게는 춘천의 한식당이다." });
  });

  test("only the cut calls are left out: the words, the other calls and a guard's answer stay", async () => {
    const { toProviderMessages } = await import("../src/transcript");
    const sent = toProviderMessages([
      { id: "u1", role: "user", content: "기억해 둬" },
      {
        id: "a1",
        role: "assistant",
        content: "적어 둘게요.",
        toolCalls: [
          {
            id: "whole",
            type: "function",
            function: { name: "remember", arguments: '{"fact": "하나"}' },
          },
          {
            id: "half",
            type: "function",
            function: { name: "remember", arguments: '{"fact": "둘' },
          },
          {
            id: "broken",
            type: "function",
            function: { name: "remember", arguments: '{"fact": ' },
          },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "whole", content: "기억했다." },
      { id: "t2", role: "tool", toolCallId: "half", content: cutAnswer },
      {
        id: "t3",
        role: "tool",
        toolCallId: "broken",
        content: JSON.stringify({
          ok: false,
          code: "laf:tool_arguments_invalid",
          reason: toolResultText("laf:tool_arguments_invalid"),
        }),
      },
    ] as never);

    expect(sent).toHaveLength(4);
    expect(sent[1]).toMatchObject({
      role: "assistant",
      content: "적어 둘게요.",
      tool_calls: [
        { id: "whole", function: { arguments: '{"fact": "하나"}' } },
        // A guard's answer is how the model learns what to fix, so its call stays — as `{}`.
        { id: "broken", function: { arguments: "{}" } },
      ],
    });
    expect(
      sent.flatMap((message) =>
        message.role === "tool" ? [message.tool_call_id] : [],
      ),
    ).toEqual(["whole", "broken"]);
  });

  test("a turn that was only cut calls is gone; an empty answer that never called stays", async () => {
    const { toProviderMessages } = await import("../src/transcript");
    const sent = toProviderMessages([
      { id: "u1", role: "user", content: "기억해 둬" },
      {
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "remember", arguments: "" },
          },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "c1", content: cutAnswer },
      { id: "u2", role: "user", content: "다시" },
      { id: "a2", role: "assistant", content: "" },
    ] as never);
    expect(sent.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
  });
});
