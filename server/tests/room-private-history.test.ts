import { describe, expect, test } from "bun:test";
import {
  HISTORY_MESSAGE_CHARS,
  HISTORY_MESSAGES,
  historyOf,
} from "../src/rooms/private-history";
import type { StoredMessage } from "../src/rooms/transcript";

/**
 * The bound is the feature. What a member remembers of the person is the last page of their
 * conversation, words only, each cut — so the cost of a room turn is a number somebody chose, not
 * the length of whatever was pasted last week.
 */

const said = (role: string, content: unknown, extra = {}): StoredMessage =>
  ({ id: `m-${Math.random()}`, role, content, ...extra }) as StoredMessage;

describe("what a member remembers", () => {
  test("only what was said, on both sides, in order", () => {
    const history = historyOf([
      said("system", "you are a helpful bot"),
      said("user", "다음 주 일정 정리해줘"),
      said("assistant", "", { toolCalls: [{ id: "c1" }] }),
      said("tool", "calendar: 3 events", { toolCallId: "c1" }),
      said("assistant", "다음 주에는 회의가 세 건 있어요."),
      said("user", [{ type: "text", text: "고마워" }, { type: "image" }]),
    ]);
    expect(history.map((m) => [m.role, m.content])).toEqual([
      ["user", "다음 주 일정 정리해줘"],
      ["assistant", "다음 주에는 회의가 세 건 있어요."],
      ["user", "고마워"],
    ]);
  });

  test("a novel is cut, and says so", () => {
    const novel = "가".repeat(HISTORY_MESSAGE_CHARS * 3);
    const [only] = historyOf([said("user", novel)]);
    expect(only?.content?.length).toBe(HISTORY_MESSAGE_CHARS);
    // `toMatch` rather than `.endsWith`: an AG-UI `Message`'s content is a union that includes
    // content-part arrays, so the string method is not on the type even where this path only ever
    // produces text.
    expect(only?.content).toMatch(/…$/);
  });

  test("only the last page of a long conversation", () => {
    const stored = Array.from({ length: HISTORY_MESSAGES * 3 }, (_, i) =>
      said(i % 2 === 0 ? "user" : "assistant", `line ${i}`),
    );
    const history = historyOf(stored);
    expect(history).toHaveLength(HISTORY_MESSAGES);
    expect(history[0]?.content).toBe(`line ${HISTORY_MESSAGES * 2}`);
    expect(history.at(-1)?.content).toBe(`line ${HISTORY_MESSAGES * 3 - 1}`);
  });

  test("ids are minted, not reused from the snapshot", () => {
    const [a, b] = historyOf([
      { id: "same", role: "user", content: "a" },
      { id: "same", role: "assistant", content: "b" },
    ]);
    expect(a?.id).not.toBe("same");
    expect(a?.id).not.toBe(b?.id);
  });
});
