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

type Chunk = { choices: Array<{ delta: Record<string, unknown> }> };

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
