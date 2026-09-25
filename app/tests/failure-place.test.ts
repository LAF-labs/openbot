import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  failurePlaces,
  toVisibleChatItems,
  withBrowsingTasks,
} from "../src/components/channels/chat-messages";

/**
 * A STORED FAILURE IS DRAWN UNDER THE LAST THING ITS TURN DREW.
 *
 * Measured in the 0.5.4 QA: after a reload the red line sat between the Bot's "찾아볼게요" and the
 * browsing card that sentence's own message carried, because the server keys a failure to a message
 * and the transcript drew it under that message's first row. The live line, drawn at the end, sat
 * under the card — so the same failure moved on reload.
 */

const call = (id: string, name: string) => ({
  id,
  type: "function" as const,
  function: { name, arguments: "{}" },
});

const THREAD: Message[] = [
  { id: "u1", role: "user", content: "빵집 리뷰 찾아줘" },
  {
    id: "a1",
    role: "assistant",
    content: "찾아볼게요",
    toolCalls: [call("c1", "computer_navigate"), call("c2", "computer_read")],
  },
  { id: "t1", role: "tool", toolCallId: "c1", content: "{}" },
  { id: "t2", role: "tool", toolCallId: "c2", content: "{}" },
  { id: "u2", role: "user", content: "고마워" },
  { id: "a2", role: "assistant", content: "천만에요" },
];

const items = withBrowsingTasks(toVisibleChatItems(THREAD));

describe("where a failure is drawn", () => {
  test("keyed to the sentence, it goes under the card that sentence's message carried", () => {
    expect(items.map((item) => item.kind)).toEqual([
      "text",
      "text",
      "browse",
      "text",
      "text",
    ]);
    expect(Object.fromEntries(failurePlaces(THREAD, items, ["a1"]))).toEqual({
      c1: ["a1"],
    });
  });

  test("keyed to the question, it goes under everything the turn drew, and no further", () => {
    expect(Object.fromEntries(failurePlaces(THREAD, items, ["u1"]))).toEqual({
      c1: ["u1"],
    });
  });

  test("a question the turn drew nothing for keeps its line under the question", () => {
    const asked: Message[] = [
      { id: "u9", role: "user", content: "오늘 매출?" },
      { id: "u10", role: "user", content: "여보세요?" },
    ];
    const rows = withBrowsingTasks(toVisibleChatItems(asked));
    expect(Object.fromEntries(failurePlaces(asked, rows, ["u9"]))).toEqual({
      u9: ["u9"],
    });
  });

  test("a message that drew no row of its own still finds its turn's last row", () => {
    const quiet: Message[] = [
      { id: "u1", role: "user", content: "찾아줘" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [call("c1", "computer_navigate")],
      },
      { id: "t1", role: "tool", toolCallId: "c1", content: "{}" },
    ];
    const rows = withBrowsingTasks(toVisibleChatItems(quiet));
    expect(Object.fromEntries(failurePlaces(quiet, rows, ["a1"]))).toEqual({
      c1: ["a1"],
    });
  });

  test("a key nothing in the thread knows is not drawn", () => {
    expect(failurePlaces(THREAD, items, ["gone"]).size).toBe(0);
  });
});
