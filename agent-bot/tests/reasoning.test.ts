import { describe, expect, spyOn, test } from "bun:test";
import {
  carriedReasoning,
  mergeReasoningDetails,
  type ReasoningDetail,
  reasoningDetailsOf,
} from "../src/reasoning";
import { toProviderMessages } from "../src/transcript";

/**
 * The reasoning behind a tool call, handed back with it (`src/reasoning.ts`).
 *
 * Xiaomi asks that a MiMo tool-call turn keep its reasoning in every later request; OpenRouter's
 * documented field for it is `reasoning_details`, passed back unmodified. Measured 2026-09-25: MiMo
 * streams a thought as one `reasoning.text` fragment per few words, all index 0.
 */

type Chunk = {
  choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string }>;
};
type Event = Record<string, unknown> & { type: string };
type Request = {
  messages: Array<Record<string, unknown> & { role: string }>;
};

const fragment = (text: string) => ({
  type: "reasoning.text",
  text,
  format: "unknown",
  index: 0,
});

/** A thought in fragments, then a call — the way MiMo streams a tool-call turn through OpenRouter. */
const thinksThenCalls = (id: string, name: string, raw: string): Chunk[] => [
  {
    choices: [{ delta: { reasoning_details: [fragment("The owner wants")] } }],
  },
  {
    choices: [{ delta: { reasoning_details: [fragment(" the stock page.")] } }],
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id, function: { name, arguments: raw } }],
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];

const thinksThenSays = (text: string): Chunk[] => [
  { choices: [{ delta: { reasoning_details: [fragment("Answer.")] } }] },
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
];

const TOOLS = [
  {
    name: "computer_navigate",
    description: "열기",
    parameters: { type: "object", properties: { url: { type: "string" } } },
  },
];

async function runFor(scripts: Chunk[][], messages: unknown[]) {
  process.env.OPENAI_API_KEY ??= "test-key";
  const { runAgent } = await import("../src/index");
  const requests: Request[] = [];
  const quiet = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
  ];
  try {
    const response = await runAgent(
      {
        threadId: "t1",
        runId: "r1",
        messages,
        tools: TOOLS,
        context: [],
        forwardedProps: {},
        state: {},
      } as never,
      (async (request: Request) => {
        requests.push(structuredClone(request));
        const script = scripts[requests.length - 1] ?? [];
        return {
          async *[Symbol.asyncIterator]() {
            for (const chunk of script) yield chunk;
          },
        };
      }) as never,
    );
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()) as Event);
    return { requests, events };
  } finally {
    for (const spy of quiet) spy.mockRestore();
  }
}

describe("merging the stream", () => {
  test("consecutive text fragments become one block, as OpenRouter's SDK merges them", () => {
    const merged: ReasoningDetail[] = [];
    mergeReasoningDetails(merged, [fragment("The owner"), fragment(" wants")]);
    mergeReasoningDetails(merged, [
      { ...fragment(" stock."), signature: "sig" },
    ]);
    expect(merged).toEqual([
      {
        type: "reasoning.text",
        text: "The owner wants stock.",
        format: "unknown",
        index: 0,
        signature: "sig",
      },
    ]);
  });

  test("an encrypted block is kept as it came, and splits the text around it", () => {
    const merged: ReasoningDetail[] = [];
    mergeReasoningDetails(merged, [
      fragment("a"),
      { type: "reasoning.encrypted", data: "opaque" },
      fragment("b"),
    ]);
    expect(merged.map((detail) => detail.type)).toEqual([
      "reasoning.text",
      "reasoning.encrypted",
      "reasoning.text",
    ]);
  });

  test("anything that is not a list of typed objects is nothing", () => {
    const merged: ReasoningDetail[] = [];
    mergeReasoningDetails(merged, "thinking");
    mergeReasoningDetails(merged, [null, 3, { text: "no type" }]);
    expect(merged).toEqual([]);
  });
});

describe("handing it back", () => {
  const carried = carriedReasoning("xiaomi/mimo-v2.6-pro", [
    { type: "reasoning.text", text: "Open the page.", format: "unknown" },
  ]);
  const turn = (encryptedValue: string | null | undefined) => [
    { id: "u1", role: "user", content: "재고" },
    {
      id: "a1",
      role: "assistant",
      ...(encryptedValue ? { encryptedValue } : {}),
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: { name: "computer_navigate", arguments: "{}" },
        },
      ],
    },
    { id: "t1", role: "tool", toolCallId: "c1", content: "{}" },
  ];

  test("a tool-call turn goes back with reasoning_details, to the model that wrote them", () => {
    const [, assistant] = toProviderMessages(
      turn(carried) as never,
      "xiaomi/mimo-v2.6-pro",
    );
    expect(
      (assistant as { reasoning_details?: unknown }).reasoning_details,
    ).toEqual([
      { type: "reasoning.text", text: "Open the page.", format: "unknown" },
    ]);
  });

  test("another model gets none, and so does a value this service did not write", () => {
    for (const [value, model] of [
      [carried, "z-ai/glm-5.3"],
      ["not json", "xiaomi/mimo-v2.6-pro"],
      [
        JSON.stringify({ model: "xiaomi/mimo-v2.6-pro", reasoning_details: 1 }),
        "xiaomi/mimo-v2.6-pro",
      ],
      [undefined, "xiaomi/mimo-v2.6-pro"],
    ] as const) {
      const [, assistant] = toProviderMessages(turn(value) as never, model);
      expect(assistant).not.toHaveProperty("reasoning_details");
    }
  });

  test("a text answer never carries it, whatever the message holds", () => {
    const [message] = toProviderMessages(
      [
        { id: "a", role: "assistant", content: "네", encryptedValue: carried },
      ] as never,
      "xiaomi/mimo-v2.6-pro",
    );
    expect(message).not.toHaveProperty("reasoning_details");
  });

  test("nothing to carry is nothing on the message", () => {
    expect(carriedReasoning("m", [])).toBeNull();
    expect(reasoningDetailsOf(carriedReasoning("m", []), "m")).toBeNull();
  });
});

describe("the run", () => {
  test("a tool-call turn puts its reasoning on its message, once, merged", async () => {
    const { events } = await runFor(
      [thinksThenCalls("c1", "computer_navigate", '{"url":"https://a.test"}')],
      [{ id: "u1", role: "user", content: "재고 페이지 열어줘" }],
    );
    const attached = events.filter(
      (event) => event.type === "REASONING_ENCRYPTED_VALUE",
    );
    expect(attached).toHaveLength(1);
    const start = events.find((event) => event.type === "TOOL_CALL_START");
    expect(attached[0]?.subtype).toBe("message");
    // The message the call opened under — which is the message the client files it on.
    expect(attached[0]?.entityId).toBe(start?.parentMessageId);
    expect(
      reasoningDetailsOf(
        attached[0]?.encryptedValue,
        process.env.BOT_MODEL?.trim() ?? "",
      ),
    ).toEqual([
      {
        type: "reasoning.text",
        text: "The owner wants the stock page.",
        format: "unknown",
        index: 0,
      },
    ]);
    // Before the run ends, so the client applies it inside the run that made the message.
    expect(events.findIndex((event) => event === attached[0])).toBeLessThan(
      events.findIndex((event) => event.type === "RUN_FINISHED"),
    );
  });

  test("a text answer attaches nothing", async () => {
    const { events } = await runFor(
      [thinksThenSays("네, 알겠습니다.")],
      [{ id: "u1", role: "user", content: "안녕" }],
    );
    expect(events.map((event) => event.type)).not.toContain(
      "REASONING_ENCRYPTED_VALUE",
    );
  });

  test("the next run hands the carried reasoning back, and the prefix before it is unchanged", async () => {
    const first = await runFor(
      [thinksThenCalls("c1", "computer_navigate", '{"url":"https://a.test"}')],
      [{ id: "u1", role: "user", content: "재고 페이지 열어줘" }],
    );
    const attached = first.events.find(
      (event) => event.type === "REASONING_ENCRYPTED_VALUE",
    );
    // What the client holds after applying the run, and sends back with the page's result.
    const next = await runFor(
      [thinksThenSays("재고는 12개입니다.")],
      [
        { id: "u1", role: "user", content: "재고 페이지 열어줘" },
        {
          id: attached?.entityId,
          role: "assistant",
          encryptedValue: attached?.encryptedValue,
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "computer_navigate",
                arguments: '{"url":"https://a.test"}',
              },
            },
          ],
        },
        { id: "t1", role: "tool", toolCallId: "c1", content: "재고 12" },
      ],
    );
    const sent = next.requests[0]?.messages ?? [];
    expect(sent[0]).toEqual(first.requests[0]?.messages[0] as never);
    expect(sent[1]?.reasoning_details).toEqual([
      {
        type: "reasoning.text",
        text: "The owner wants the stock page.",
        format: "unknown",
        index: 0,
      },
    ]);
  });
});
