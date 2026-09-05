import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { answerBridgeCall } from "../src/deferral";

/**
 * The bridge, as the wire and the provider see it.
 *
 * A Bot's schema used to carry every tool of every service the person had connected — thirty-six
 * or so, most of them paid for on every turn and used on none. Now the connected-service tools sit
 * behind three bridge tools, and these pin what that changes and what it must NOT change:
 *
 * - the model is offered the core tools and the bridge, never a connected service's own tool;
 * - a lookup is answered inside the run and put on the wire, so the transcript says the Bot looked;
 * - `tool_call` reaches the surface AS THE REAL CALL, in the real name, under the same id — the
 *   surface cannot tell it from a direct call, which is what keeps the boundary path identical;
 * - a run that only ever looks is made to act after a bounded number of rounds.
 *
 * Driven through `runAgent` with a scripted provider, because the buffering, the rewriting and the
 * in-run loop all live in the loop that reads the provider's stream.
 */

type Chunk = {
  choices?: Array<{
    delta?: Record<string, unknown>;
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

type Request = {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools?: Array<{ function: { name: string; description: string } }>;
};

type Event = Record<string, unknown> & { type: string };

function completion(chunks: Chunk[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
}

/** A turn of prose, then the end. */
const said = (text: string): Chunk[] => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
];

/**
 * A turn of tool calls, each streamed the way a provider streams one: the id and name first, then
 * the arguments in two fragments.
 */
const calls = (
  list: Array<{ id: string; name: string; args: object }>,
  prose = "",
): Chunk[] => {
  const chunks: Chunk[] = prose
    ? [{ choices: [{ delta: { content: prose } }] }]
    : [];
  list.forEach((call, index) => {
    const raw = JSON.stringify(call.args);
    const half = Math.ceil(raw.length / 2);
    chunks.push({
      choices: [
        {
          delta: {
            tool_calls: [{ index, id: call.id, function: { name: call.name } }],
          },
        },
      ],
    });
    chunks.push({
      choices: [
        {
          delta: {
            tool_calls: [
              { index, function: { arguments: raw.slice(0, half) } },
            ],
          },
        },
      ],
    });
    chunks.push({
      choices: [
        {
          delta: {
            tool_calls: [{ index, function: { arguments: raw.slice(half) } }],
          },
        },
      ],
    });
  });
  chunks.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  return chunks;
};

const withUsage = (chunks: Chunk[], prompt: number): Chunk[] => [
  ...chunks,
  {
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: 10,
      total_tokens: prompt + 10,
    },
  },
];

const tool = (name: string, description: string, properties = {}) => ({
  name,
  description,
  parameters: { type: "object", properties, required: [] },
});

/* The shape a chat Bot with Gmail and Sheets connected is actually handed. */
const NAVIGATE = tool("computer_navigate", "네 컴퓨터에서 웹 페이지를 연다.", {
  url: { type: "string" },
});
const HELP = tool(
  "computer_request_help",
  "네가 할 수 없는 일을 사람에게 부탁해서 컴퓨터를 직접 잡게 한다.",
);
const REMEMBER = tool(
  "remember",
  "이 사람에 대해 오래 참인 사실 하나를 적어 둔다.",
);
const GMAIL_SEND = tool(
  "mcp__gmail__send_message",
  "메일을 실제로 보낸다. 보낸 메일은 되돌릴 수 없으므로 사람이 승인해야 나간다. (gmail)",
  {
    to: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
  },
);
const GMAIL_SEARCH = tool(
  "mcp__gmail__search_messages",
  "지메일에서 메일을 찾는다. (gmail)",
  { query: { type: "string" } },
);
const SHEETS_APPEND = tool(
  "mcp__google-sheets__append_sheet_row",
  "시트 끝에 행 하나를 덧붙인다. (google-sheets)",
  { spreadsheetId: { type: "string" }, values: { type: "array" } },
);
const CORE = [NAVIGATE, HELP, REMEMBER];
const CONNECTED = [GMAIL_SEND, GMAIL_SEARCH, SHEETS_APPEND];

const namesOf = (request: Request | undefined) =>
  (request?.tools ?? []).map((entry) => entry.function.name);

/** One run against scripted turns; what the provider was asked, and what went on the wire. */
async function runFor(
  tools: unknown[],
  scripts: Chunk[][],
  forwardedProps: Record<string, unknown> = {},
) {
  process.env.OPENAI_API_KEY ??= "test-key";
  const { runAgent } = await import("../src/index");
  const requests: Request[] = [];
  const response = await runAgent(
    {
      threadId: "t1",
      runId: "r1",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "kim@shop.kr에 정산서 보냈다고 메일 보내줘",
        },
      ],
      tools,
      context: [],
      forwardedProps,
      state: {},
    } as never,
    (async (request: Request) => {
      requests.push(request);
      return completion(scripts[requests.length - 1] ?? said("…"));
    }) as never,
  );
  const body = await response.text();
  const events = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as Event);
  return { requests, events };
}

const kinds = (events: Event[]) => events.map((event) => event.type);

describe("what the model is offered", () => {
  test("the core tools and the bridge, never a connected service's own tool", async () => {
    const { requests } = await runFor([...CORE, ...CONNECTED], [said("네.")]);
    expect(namesOf(requests[0])).toEqual([
      "computer_navigate",
      "computer_request_help",
      "remember",
      "tool_search",
      "tool_describe",
      "tool_call",
    ]);
  });

  test("tool_search says which services are connected this run", async () => {
    const { requests } = await runFor([...CORE, ...CONNECTED], [said("네.")]);
    const search = requests[0]?.tools?.find(
      (entry) => entry.function.name === "tool_search",
    );
    expect(search?.function.description).toContain("지메일");
    expect(search?.function.description).toContain("구글 시트");
  });

  test("everything as it came when there is nothing to defer", async () => {
    const { requests } = await runFor(CORE, [said("네.")]);
    expect(namesOf(requests[0])).toEqual([
      "computer_navigate",
      "computer_request_help",
      "remember",
    ]);
  });

  /** The measurement arm of the eval. Production never sends it. */
  test("everything as it came when the run switches deferral off", async () => {
    const { requests } = await runFor([...CORE, ...CONNECTED], [said("네.")], {
      toolDeferral: "off",
    });
    expect(namesOf(requests[0])).toEqual([
      ...CORE.map((entry) => entry.name),
      ...CONNECTED.map((entry) => entry.name),
    ]);
  });
});

describe("a lookup", () => {
  test("is answered inside the run, on the wire, and the model is asked again with it", async () => {
    const { requests, events } = await runFor(
      [...CORE, ...CONNECTED],
      [
        calls([
          { id: "c1", name: "tool_search", args: { query: "메일 보내기" } },
        ]),
        said("찾았다."),
      ],
    );

    // One run, two requests: the lookup did not cost a round trip through the surface.
    expect(requests).toHaveLength(2);
    expect(kinds(events)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    // The lookup is on the wire under its own name, with its own arguments — nothing hidden.
    const start = events.find((event) => event.type === "TOOL_CALL_START");
    expect(start?.toolCallName).toBe("tool_search");
    expect(start?.toolCallId).toBe("c1");
    const result = events.find((event) => event.type === "TOOL_CALL_RESULT");
    expect(result?.toolCallId).toBe("c1");
    expect(String(result?.content)).toContain("mcp__gmail__send_message");

    // The second request carries the lookup and its answer, right after the conversation.
    const tail = requests[1]?.messages.slice(-2) ?? [];
    expect(tail[0]?.role).toBe("assistant");
    expect(
      (tail[0] as { tool_calls?: Array<{ function: { name: string } }> })
        .tool_calls?.[0]?.function.name,
    ).toBe("tool_search");
    expect(tail[1]?.role).toBe("tool");
    expect(String(tail[1]?.content)).toContain("mcp__gmail__send_message");
  });

  test("keeps the prose the model said before looking", async () => {
    const { requests } = await runFor(
      [...CORE, ...CONNECTED],
      [
        calls(
          [{ id: "c1", name: "tool_search", args: { query: "메일" } }],
          "잠깐 찾아볼게요.",
        ),
        said("찾았다."),
      ],
    );
    const assistant = requests[1]?.messages.at(-2);
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toBe("잠깐 찾아볼게요.");
  });

  test("tool_describe hands back the whole schema", async () => {
    const { events } = await runFor(
      [...CORE, ...CONNECTED],
      [
        calls([
          {
            id: "c1",
            name: "tool_describe",
            args: { name: "mcp__gmail__send_message" },
          },
        ]),
        said("알겠다."),
      ],
    );
    const result = events.find((event) => event.type === "TOOL_CALL_RESULT");
    const described = JSON.parse(String(result?.content)) as {
      name: string;
      parameters: { properties: Record<string, unknown> };
    };
    expect(described.name).toBe("mcp__gmail__send_message");
    expect(Object.keys(described.parameters.properties)).toEqual([
      "to",
      "subject",
      "body",
    ]);
  });

  test("each round's cost leaves as its own usage event", async () => {
    const { events } = await runFor(
      [...CORE, ...CONNECTED],
      [
        withUsage(
          calls([{ id: "c1", name: "tool_search", args: { query: "메일" } }]),
          1_200,
        ),
        withUsage(said("찾았다."), 1_500),
      ],
    );
    const usage = events.filter(
      (event) => event.type === "CUSTOM" && event.name === "laf.model.usage",
    );
    expect(
      usage.map(
        (event) => (event.value as { promptTokens: number }).promptTokens,
      ),
    ).toEqual([1_200, 1_500]);
  });
});

describe("tool_call", () => {
  test("reaches the wire as the real call, in the real name, under the same id", async () => {
    const args = {
      to: "kim@shop.kr",
      subject: "9월 정산서",
      body: "정산 내역을 보냈습니다.",
    };
    const { requests, events } = await runFor(
      [...CORE, ...CONNECTED],
      [
        calls([
          {
            id: "c7",
            name: "tool_call",
            args: { name: "mcp__gmail__send_message", args },
          },
        ]),
      ],
    );

    // A real call ends the run, as it always did: the surface executes it and starts the next one.
    expect(requests).toHaveLength(1);
    expect(kinds(events)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);
    const start = events.find((event) => event.type === "TOOL_CALL_START");
    expect(start?.toolCallName).toBe("mcp__gmail__send_message");
    expect(start?.toolCallId).toBe("c7");
    const fragment = events.find((event) => event.type === "TOOL_CALL_ARGS");
    expect(JSON.parse(String(fragment?.delta))).toEqual(args);
    // Nothing about the bridge itself is on the wire.
    expect(JSON.stringify(events)).not.toContain("tool_call");
  });

  test("a name nothing is connected under is answered, not forwarded", async () => {
    const { requests, events } = await runFor(
      [...CORE, ...CONNECTED],
      [
        calls([
          {
            id: "c1",
            name: "tool_call",
            args: { name: "mcp__slack__post", args: {} },
          },
        ]),
        said("그런 도구는 없다."),
      ],
    );
    expect(requests).toHaveLength(2);
    const result = events.find((event) => event.type === "TOOL_CALL_RESULT");
    expect(String(result?.content)).toContain("없다");
    expect(
      events.some(
        (event) =>
          event.type === "TOOL_CALL_START" &&
          event.toolCallName === "mcp__slack__post",
      ),
    ).toBe(false);
  });

  test("a bare name resolves when it is unique and is refused when it is not", () => {
    const unique = answerBridgeCall(
      "tool_call",
      JSON.stringify({ name: "send_message", args: { to: "a@b.c" } }),
      CONNECTED,
    );
    expect(unique).toEqual({
      kind: "forward",
      name: "mcp__gmail__send_message",
      args: { to: "a@b.c" },
    });

    const twice = [
      ...CONNECTED,
      tool("mcp__kakao-alimtalk__send_message", "알림톡을 보낸다."),
    ];
    const ambiguous = answerBridgeCall(
      "tool_call",
      JSON.stringify({ name: "send_message", args: {} }),
      twice,
    );
    expect(ambiguous.kind).toBe("answer");
  });

  test("beside a real call, the run ends and the lookup still gets its answer", async () => {
    const { requests, events } = await runFor(
      [...CORE, ...CONNECTED],
      [
        calls([
          { id: "c1", name: "computer_navigate", args: { url: "https://a" } },
          {
            id: "c2",
            name: "tool_describe",
            args: { name: "mcp__gmail__send_message" },
          },
        ]),
      ],
    );
    expect(requests).toHaveLength(1);
    expect(kinds(events)).toContain("TOOL_CALL_RESULT");
    const starts = events
      .filter((event) => event.type === "TOOL_CALL_START")
      .map((event) => event.toolCallName);
    expect(starts).toEqual(["computer_navigate", "tool_describe"]);
  });
});

describe("what the bridge leaves alone", () => {
  test("a connected service's tool called by its real name goes through as it came", async () => {
    const { events } = await runFor(
      [...CORE, ...CONNECTED],
      [
        calls([
          {
            id: "c1",
            name: "mcp__gmail__send_message",
            args: { to: "kim@shop.kr", subject: "안녕", body: "…" },
          },
        ]),
      ],
    );
    expect(kinds(events)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);
  });

  test("a run that only ever looks is made to act after four rounds", async () => {
    const lookup = () =>
      calls([{ id: "c", name: "tool_search", args: { query: "없는 것" } }]);
    const { requests } = await runFor(
      [...CORE, ...CONNECTED],
      [lookup(), lookup(), lookup(), lookup(), said("찾지 못했다.")],
    );
    expect(requests).toHaveLength(5);
    for (const request of requests.slice(0, 4)) {
      expect(namesOf(request)).toContain("tool_search");
    }
    // The last round: core tools only, so the model can only speak or act.
    expect(namesOf(requests[4])).toEqual([
      "computer_navigate",
      "computer_request_help",
      "remember",
    ]);
  });
});
