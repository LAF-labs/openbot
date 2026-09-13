import { describe, expect, spyOn, test } from "bun:test";
import { toolResultText } from "../../shared/prompt/tool-results.ko";

/**
 * A tool call the surface could not execute, answered inside the run instead.
 *
 * MEASURED (audit A2, 2026-09-10, rows 5 and 6): a model calling `computer_fly`, or calling
 * `computer_navigate` with `{"url": "…" oops`, ended the run with RUN_FINISHED and left the rest to
 * the surface. The browser has no handler for a made-up name, so nothing ran and the Bot's turn
 * ended in silence; broken JSON put `Error: JSON Parse error…` into the transcript, in English, with
 * no follow-up run. Neither reached the ledger or /failures, and "is the Bot dead" was the first
 * impression — glm-5.3-flash inventing a tool name is in the eval notes already.
 *
 * Both are answered the way a bridge lookup is: the call goes on the wire with a `laf:` fact as its
 * result, the model is asked again with the fact in front of it, and no surface executes anything.
 * Two recoveries, then the run ends on the fact — never on silence, and never in English.
 */

type Chunk = {
  choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string }>;
};

type Event = Record<string, unknown> & { type: string };

type Request = {
  messages: Array<{
    role: string;
    content?: string | null;
    tool_calls?: Array<{ function: { name: string; arguments: string } }>;
  }>;
  tools?: Array<{ function: { name: string } }>;
};

const said = (text: string): Chunk[] => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
];

/** One call, streamed the way a provider streams one: id and name, then the arguments in halves. */
const calls = (id: string, name: string, raw: string): Chunk[] => {
  const half = Math.ceil(raw.length / 2);
  return [
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, id, function: { name } }] } },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: raw.slice(0, half) } },
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
              { index: 0, function: { arguments: raw.slice(half) } },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
};

const tool = (name: string, properties = {}) => ({
  name,
  description: `${name} 설명`,
  parameters: { type: "object", properties, required: [] },
});

const TOOLS = [
  tool("computer_navigate", { url: { type: "string" } }),
  tool("computer_read"),
];

const ASK = [{ id: "u1", role: "user", content: "부산 매장 재고 확인해줘" }];

/** One run over a scripted provider: what it was asked, and what went on the wire. */
async function runFor(
  scripts: Chunk[][],
  options: { tools?: unknown[]; messages?: unknown[] } = {},
) {
  process.env.OPENAI_API_KEY ??= "test-key";
  const { runAgent } = await import("../src/index");
  const requests: Request[] = [];
  const quiet = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
  try {
    const response = await runAgent(
      {
        threadId: "t1",
        runId: "r1",
        messages: options.messages ?? ASK,
        tools: options.tools ?? TOOLS,
        context: [],
        forwardedProps: {},
        state: {},
      } as never,
      (async (request: Request) => {
        requests.push(request);
        const script = scripts[requests.length - 1] ?? said("…");
        return {
          async *[Symbol.asyncIterator]() {
            for (const chunk of script) yield chunk;
          },
        };
      }) as never,
    );
    const body = await response.text();
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()) as Event);
    return { requests, events, body };
  } finally {
    for (const spy of quiet) spy.mockRestore();
  }
}

const kinds = (events: Event[]) => events.map((event) => event.type);
const resultsOf = (events: Event[]) =>
  events
    .filter((event) => event.type === "TOOL_CALL_RESULT")
    .map(
      (event) => JSON.parse(String(event.content)) as Record<string, unknown>,
    );

/** Nothing a person should ever read in a Korean transcript. */
const ENGLISH_ERROR =
  /There is no tool|Error:|JSON Parse|not found|Unknown tool|Unexpected/i;

describe("a tool the model made up", () => {
  test("is answered inside the run, in Korean, and the model is asked again", async () => {
    const { requests, events, body } = await runFor([
      calls("c1", "computer_fly", '{"to":"부산"}'),
      said("그런 도구는 없어서 페이지를 읽겠다."),
    ]);

    // One run, two requests: the model read the fact and answered, and nothing went to a surface.
    expect(requests).toHaveLength(2);
    expect(kinds(events)).toEqual([
      "RUN_STARTED",
      // Never streamed while it arrived: a surface must not see an open call it has no handler for.
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(resultsOf(events)).toEqual([
      {
        ok: false,
        code: "laf:tool_unknown",
        reason: toolResultText("laf:tool_unknown"),
      },
    ]);
    // The second request carries the call and its fact, which is what the model recovers from.
    const tail = requests[1]?.messages.slice(-2) ?? [];
    expect(tail[0]?.tool_calls?.[0]?.function.name).toBe("computer_fly");
    expect(tail[1]?.role).toBe("tool");
    expect(String(tail[1]?.content)).toContain("laf:tool_unknown");
    expect(body).not.toMatch(ENGLISH_ERROR);
  });

  test("after two recoveries the run ends with the fact, not with silence", async () => {
    const fly = () => calls("c", "computer_fly", "{}");
    const { requests, events, body } = await runFor([
      fly(),
      fly(),
      fly(),
      fly(),
    ]);

    // Answered twice and asked again twice; the third time the run is over. Never a fourth request.
    expect(requests).toHaveLength(3);
    expect(resultsOf(events).map((result) => result.code)).toEqual([
      "laf:tool_unknown",
      "laf:tool_unknown",
      "laf:tool_unknown",
    ]);
    expect(kinds(events)).not.toContain("RUN_FINISHED");
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      message: "laf:tool_unknown",
    });
    expect(body).not.toMatch(ENGLISH_ERROR);
  });

  test("a run handed no tools at all answers a call the same way, so the model can still speak", async () => {
    // A routine's last turn is offered nothing; a model that calls a tool there out of habit is told
    // there is no such tool, and says what it found instead.
    const { requests, events } = await runFor(
      [calls("c1", "computer_read", "{}"), said("찾은 것은 이렇다.")],
      { tools: [] },
    );
    expect(requests).toHaveLength(2);
    expect(resultsOf(events).map((result) => result.code)).toEqual([
      "laf:tool_unknown",
    ]);
    expect(kinds(events).at(-1)).toBe("RUN_FINISHED");
  });
});

describe("arguments that are not a JSON object", () => {
  test("broken JSON is answered with the fact, and the corrected call goes through", async () => {
    // The audit's exact fragment.
    const { requests, events, body } = await runFor([
      calls("c1", "computer_navigate", '{"url": "https://a" oops'),
      calls("c2", "computer_navigate", '{"url":"https://a"}'),
    ]);

    expect(requests).toHaveLength(2);
    expect(resultsOf(events)).toEqual([
      {
        ok: false,
        code: "laf:tool_arguments_invalid",
        reason: toolResultText("laf:tool_arguments_invalid"),
      },
    ]);
    // The corrected call is forwarded: it opens, it closes, and it has no result of its own.
    const starts = events.filter((event) => event.type === "TOOL_CALL_START");
    expect(starts.map((event) => event.toolCallId)).toEqual(["c1", "c2"]);
    expect(
      events.filter((event) => event.type === "TOOL_CALL_END"),
    ).toHaveLength(2);
    expect(kinds(events).at(-1)).toBe("RUN_FINISHED");
    expect(body).not.toMatch(ENGLISH_ERROR);
  });

  test("the recovery request carries arguments an endpoint can read", async () => {
    // An endpoint that turns the call into its own model's shape parses these; the broken string
    // sent back as it was is a 400 on the very request meant to recover.
    const { requests } = await runFor([
      calls("c1", "computer_navigate", '{"url": "https://a" oops'),
      said("다시 한다."),
    ]);
    const sent = requests[1]?.messages
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.function.arguments);
    expect(sent).toEqual(["{}"]);
  });

  test("an array or a string is refused the same way; an empty string is no arguments", async () => {
    const list = await runFor([
      calls("c1", "computer_navigate", '["https://a"]'),
      said("다시."),
    ]);
    expect(resultsOf(list.events).map((result) => result.code)).toEqual([
      "laf:tool_arguments_invalid",
    ]);

    // Providers send `""` for a call with no arguments, and that is `{}`, not a mistake.
    const none = await runFor([calls("c1", "computer_read", "")]);
    expect(resultsOf(none.events)).toEqual([]);
    expect(kinds(none.events)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);
  });

  test("the bound is shared: a made-up name and broken arguments count together", async () => {
    const { requests, events } = await runFor([
      calls("c1", "computer_fly", "{}"),
      calls("c2", "computer_navigate", "{oops"),
      calls("c3", "computer_navigate", "{oops"),
      said("네."),
    ]);
    expect(requests).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      message: "laf:tool_arguments_invalid",
    });
  });
});
