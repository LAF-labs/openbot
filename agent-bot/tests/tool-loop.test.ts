import { describe, expect, spyOn, test } from "bun:test";

/**
 * A Bot that keeps calling tools and never answers, bounded far below the browser's hundred.
 *
 * MEASURED (audit A2, 2026-09-10, §5): a fake provider made to call `computer_read` every time, with
 * the client's loop appending a 6,000-character page after each call, ran thirty runs and would have
 * run to CopilotKit's `MAX_FOLLOW_UP_DEPTH = 100` — about two million tokens behind one spinner —
 * because nothing this side of the browser counted. The gateway's repeat counter never sees a read,
 * and this service had no turn bound at all.
 *
 * Two bounds now, both answered inside the run so the model hears why: the same call three times in
 * a row is `laf:tool_loop`, and a question that has cost `ASK_TOKEN_BUDGET` is `laf:tool_budget_spent`
 * followed by one request with no tools, so the Bot says what it found.
 *
 * Driven the way the surface drives it — run, execute whatever was forwarded, append the calls and
 * results the run put on the wire, run again — because both bounds read the conversation the
 * surface sends back, and a test that faked that conversation would be testing its own fake.
 */

type Chunk = {
  choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string }>;
};

type Event = Record<string, unknown> & { type: string };

type Request = {
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>;
  tools?: Array<{ function: { name: string } }>;
};

type Message = {
  id: string;
  role: string;
  content?: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

const said = (text: string): Chunk[] => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
];

const calls = (id: string, name: string, args: object): Chunk[] => [
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
            { index: 0, function: { arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];

const tool = (name: string, description = `${name} 설명`) => ({
  name,
  description,
  parameters: { type: "object", properties: {}, required: [] },
});

const TOOLS = [tool("computer_read"), tool("computer_navigate")];

/** A page of readable text at the computer's own limit, as the audit's fake returned. */
const PAGE = JSON.stringify({ ok: true, text: "재고 ".repeat(2_000) });

/** The thread as `@ag-ui/client` files a run's events: prose, calls under their message, results. */
function fileEvents(transcript: Message[], events: Event[]): void {
  for (const event of events) {
    if (event.type === "TEXT_MESSAGE_START") {
      transcript.push({
        id: String(event.messageId),
        role: "assistant",
        content: "",
      });
    } else if (event.type === "TEXT_MESSAGE_CONTENT") {
      const message = transcript.find((entry) => entry.id === event.messageId);
      if (message) message.content = `${message.content}${event.delta}`;
    } else if (event.type === "TOOL_CALL_START") {
      let parent = transcript.find(
        (entry) => entry.id === event.parentMessageId,
      );
      if (!parent) {
        parent = { id: String(event.parentMessageId), role: "assistant" };
        transcript.push(parent);
      }
      parent.toolCalls = [
        ...(parent.toolCalls ?? []),
        {
          id: String(event.toolCallId),
          type: "function",
          function: { name: String(event.toolCallName), arguments: "" },
        },
      ];
    } else if (event.type === "TOOL_CALL_ARGS") {
      const call = transcript
        .flatMap((entry) => entry.toolCalls ?? [])
        .find((entry) => entry.id === event.toolCallId);
      if (call) call.function.arguments += String(event.delta);
    } else if (event.type === "TOOL_CALL_RESULT") {
      transcript.push({
        id: String(event.messageId),
        role: "tool",
        toolCallId: String(event.toolCallId),
        content: String(event.content),
      });
    }
  }
}

/**
 * The surface's loop, for as long as the runs keep forwarding calls. Returns every request the
 * provider was sent, the last run's events, and how many runs it took.
 */
async function driveLoop(
  script: (ordinal: number, request: Request) => Chunk[],
  tools: unknown[] = TOOLS,
) {
  process.env.OPENAI_API_KEY ??= "test-key";
  const { runAgent } = await import("../src/index");
  const transcript: Message[] = [
    { id: "u1", role: "user", content: "부산 매장 재고 확인해줘" },
  ];
  const requests: Request[] = [];
  let events: Event[] = [];
  let runs = 0;
  const quiet = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
  try {
    // A hundred is where the browser would have stopped it; the bound has to be well inside.
    while (runs < 100) {
      runs += 1;
      const response = await runAgent(
        {
          threadId: "t1",
          runId: `r${runs}`,
          messages: structuredClone(transcript),
          tools,
          context: [],
          forwardedProps: {},
          state: {},
        } as never,
        (async (request: Request) => {
          requests.push(request);
          const chunks = script(requests.length - 1, request);
          return {
            async *[Symbol.asyncIterator]() {
              for (const chunk of chunks) yield chunk;
            },
          };
        }) as never,
      );
      events = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5).trim()) as Event);
      fileEvents(transcript, events);

      // What the surface executes: every call that ended without a result of its own.
      const answered = new Set(
        events
          .filter((event) => event.type === "TOOL_CALL_RESULT")
          .map((event) => event.toolCallId),
      );
      const forwarded = events.filter(
        (event) =>
          event.type === "TOOL_CALL_END" && !answered.has(event.toolCallId),
      );
      if (forwarded.length === 0) break;
      for (const call of forwarded) {
        transcript.push({
          id: `result_${call.toolCallId}`,
          role: "tool",
          toolCallId: String(call.toolCallId),
          content: PAGE,
        });
      }
    }
  } finally {
    for (const spy of quiet) spy.mockRestore();
  }
  return { runs, requests, events, transcript };
}

const codesOf = (events: Event[]) =>
  events
    .filter((event) => event.type === "TOOL_CALL_RESULT")
    .map(
      (event) => (JSON.parse(String(event.content)) as { code?: string }).code,
    );

/** What every request weighed, counted the way the budget counts it. */
async function weights(requests: Request[]): Promise<number[]> {
  const { charsOf } = await import("../src/guards");
  return requests.map((request) => charsOf(request.messages as never));
}

const sum = (values: number[]) =>
  values.reduce((total, value) => total + value, 0);

describe("the same call over and over", () => {
  test("the third is answered with laf:tool_loop, and a fourth ends the run on it", async () => {
    // The audit's always-same-tool fake: `computer_read` with the same arguments, for ever.
    const { runs, requests, events } = await driveLoop((ordinal) =>
      calls(`c${ordinal}`, "computer_read", {}),
    );

    // Two runs forwarded it and the surface read the page twice. The third run answered the third
    // call itself, asked once more, got the same call and ended — four requests where there were a
    // hundred.
    expect(runs).toBe(3);
    expect(requests).toHaveLength(4);
    expect(codesOf(events)).toEqual(["laf:tool_loop", "laf:tool_loop"]);
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      message: "laf:tool_loop",
    });
    // About two pages' worth in all, where the audit's run was heading for two million.
    expect(sum(await weights(requests))).toBeLessThan(40_000);
  });

  test("the warning is enough for a model that listens", async () => {
    const { runs, requests, events } = await driveLoop((ordinal, request) => {
      const last = request.messages.at(-1);
      return String(last?.content).includes("laf:tool_loop")
        ? said("같은 페이지라 더 읽지 않고 답한다: 재고는 그대로다.")
        : calls(`c${ordinal}`, "computer_read", {});
    });
    expect(runs).toBe(3);
    expect(requests).toHaveLength(4);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });

  test("it is a loop only in a row: the same read after another step is a new look", async () => {
    // read, read, navigate, read, read — never three identical in a row, so nothing is refused.
    const plan = [
      ["computer_read", {}],
      ["computer_read", {}],
      ["computer_navigate", { url: "https://a" }],
      ["computer_read", {}],
      ["computer_read", {}],
    ] as const;
    const { runs, events } = await driveLoop((ordinal) => {
      const step = plan[ordinal];
      return step ? calls(`c${ordinal}`, step[0], step[1]) : said("다 봤다.");
    });
    expect(runs).toBe(6);
    expect(codesOf(events)).toEqual([]);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });

  test("key order does not make it a different call", async () => {
    const orders = [
      { url: "https://a", tab: 1 },
      { tab: 1, url: "https://a" },
      { url: "https://a", tab: 1 },
    ];
    const { events } = await driveLoop((ordinal) =>
      ordinal < 3
        ? calls(`c${ordinal}`, "computer_navigate", orders[ordinal] as object)
        : said("그만."),
    );
    expect(codesOf(events)).toEqual(["laf:tool_loop"]);
  });

  test("the bridge is not a way around it: the same call through tool_call is the same loop", async () => {
    const tools = [
      tool("computer_read"),
      tool("mcp__gmail__search_messages", "메일을 찾는다. (gmail)"),
    ];
    const search = {
      name: "mcp__gmail__search_messages",
      args: { query: "정산" },
    };
    const { runs, events } = await driveLoop(
      (ordinal) =>
        ordinal < 3 ? calls(`c${ordinal}`, "tool_call", search) : said("없다."),
      tools,
    );
    // Forwarded twice under Gmail's own name; the third is answered under the bridge's.
    expect(runs).toBe(3);
    expect(codesOf(events)).toEqual(["laf:tool_loop"]);
    const refused = events.find((event) => event.type === "TOOL_CALL_START");
    expect(refused?.toolCallName).toBe("tool_call");
  });
});

describe("a question that keeps costing", () => {
  test("is told its budget is spent, offered no tools, and answers — far below a hundred runs", async () => {
    const { ASK_TOKEN_BUDGET } = await import("../src/guards");
    // A model that reads a different page every time, and speaks only when it has no tools.
    const { runs, requests, events, transcript } = await driveLoop(
      (ordinal, request) =>
        request.tools
          ? calls(`c${ordinal}`, "computer_read", { page: ordinal })
          : said("지금까지 읽은 것으로 답한다."),
    );

    expect(runs).toBeGreaterThan(10);
    expect(runs).toBeLessThan(40);
    expect(codesOf(events)).toEqual(["laf:tool_budget_spent"]);
    // The last request is the one with no tools, and it was answered in words.
    expect(requests.at(-1)?.tools).toBeUndefined();
    expect(requests.at(-2)?.tools).toBeDefined();
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    expect(transcript.at(-1)?.content).toBe("지금까지 읽은 것으로 답한다.");
    // What it cost, as the budget counts it: at least the budget — nothing else stopped it — and at
    // most the budget plus the request that crossed it and the two made once it was spent.
    const sent = await weights(requests);
    expect(sum(sent)).toBeGreaterThanOrEqual(ASK_TOKEN_BUDGET);
    expect(sum(sent)).toBeLessThanOrEqual(
      ASK_TOKEN_BUDGET + 3 * Math.max(...sent),
    );
  });

  test("a model that asks for a tool when it was offered none ends the run on the fact", async () => {
    const { runs, events } = await driveLoop((ordinal) =>
      calls(`c${ordinal}`, "computer_read", { page: ordinal }),
    );
    expect(runs).toBeLessThan(40);
    expect(codesOf(events)).toEqual([
      "laf:tool_budget_spent",
      "laf:tool_budget_spent",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      message: "laf:tool_budget_spent",
    });
  });

  test("the person speaking again starts a new question with its own budget", async () => {
    const { spentSinceLastAsk } = await import("../src/guards");
    const call = {
      id: "a1",
      role: "assistant",
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: { name: "computer_read", arguments: "{}" },
        },
      ],
    };
    const page = { id: "t1", role: "tool", toolCallId: "c1", content: PAGE };
    const before = [
      { id: "u1", role: "user", content: "읽어줘" },
      call,
      page,
    ] as never[];
    expect(spentSinceLastAsk(before)).toBeGreaterThan(0);
    expect(
      spentSinceLastAsk([
        ...before,
        { id: "u2", role: "user", content: "다른 것" },
      ] as never[]),
    ).toBe(0);
  });
});
