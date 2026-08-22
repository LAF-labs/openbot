import { describe, expect, test } from "bun:test";
import { normalizeStoredMessages } from "../src/lib/channels/thread-history";

describe("stored history, in the agent's shape", () => {
  test("a runtime-shaped tool call becomes an AG-UI one", () => {
    const [message] = normalizeStoredMessages([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: "c1",
            name: "ask_coworker",
            args: '{"coworker":"리스크 분석가"}',
          },
        ],
      },
    ]);
    expect(message?.toolCalls).toEqual([
      {
        id: "c1",
        type: "function",
        function: {
          name: "ask_coworker",
          arguments: '{"coworker":"리스크 분석가"}',
        },
      },
    ]);
  });

  test("an AG-UI tool call is left as it is, and object args are serialised", () => {
    const [kept, objectArgs] = normalizeStoredMessages([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "x", arguments: "{}" },
          },
        ],
      },
      {
        id: "a2",
        role: "assistant",
        toolCalls: [{ id: "c2", name: "y", args: { n: 1 } }],
      },
    ]);
    expect(kept?.toolCalls?.[0]).toEqual({
      id: "c1",
      type: "function",
      function: { name: "x", arguments: "{}" },
    });
    expect(objectArgs?.toolCalls?.[0]?.function.arguments).toBe('{"n":1}');
  });

  test("messages without an id, and non-arrays, are dropped rather than sent", () => {
    expect(normalizeStoredMessages("nope")).toEqual([]);
    expect(normalizeStoredMessages([{ role: "user", content: "x" }])).toEqual(
      [],
    );
  });
});
