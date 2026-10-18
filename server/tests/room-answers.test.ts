import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import {
  asksOwnLafi,
  isFresh,
  lafiWorking,
  ROOM_ANSWER_WINDOW_MS,
  roomAuthor,
} from "../../shared/hub/room-answers";
import { answerOf, parseMessageRef } from "../src/hub/room-answers";

/**
 * The rules a room's question is answered by, and the ones every member's screen reads the room
 * by while it is being answered (`shared/hub/room-answers.ts`, `server/src/hub/room-answers.ts`).
 */

const NOW = Date.parse("2026-10-16T09:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("what a room.mention names", () => {
  test("is a room and a message number", () => {
    expect(parseMessageRef("r_1a2b:17")).toEqual({ roomId: "r_1a2b", seq: 17 });
  });

  test.each([
    [null],
    [""],
    ["r_1a2b"],
    ["r_1a2b:"],
    ["r_1a2b:0"],
    ["r_1a2b:-3"],
    ["r_1a2b:2.5"],
    ["../etc:4"],
    [":4"],
  ])("%p names nothing", (ref) => {
    expect(parseMessageRef(ref)).toBeNull();
  });
});

describe("who wrote a room's message", () => {
  test("a person, or that person's 라피", () => {
    expect(roomAuthor("m:m_kim")).toEqual({ member: "m_kim", isLafi: false });
    expect(roomAuthor("bot:m_kim")).toEqual({ member: "m_kim", isLafi: true });
    expect(roomAuthor("job:j_1")).toBeNull();
    expect(roomAuthor("m:")).toBeNull();
  });

  test("only the person's own words with a 라피 mention ask their 라피", () => {
    const asking = { seq: 1, by: "m:m_kim", mentions: ["lafi"], at: ago(0) };
    expect(asksOwnLafi(asking, "m_kim")).toBe(true);
    expect(asksOwnLafi(asking, "m_park")).toBe(false);
    expect(asksOwnLafi({ ...asking, mentions: ["m_kim"] }, "m_kim")).toBe(
      false,
    );
    expect(asksOwnLafi({ ...asking, by: "bot:m_kim" }, "m_kim")).toBe(false);
  });

  test("a question is fresh for the window and not after it", () => {
    const at = (ms: number) => ({
      seq: 1,
      by: "m:m_kim",
      mentions: ["lafi"],
      at: ago(ms),
    });
    expect(isFresh(at(ROOM_ANSWER_WINDOW_MS - 1), NOW)).toBe(true);
    expect(isFresh(at(ROOM_ANSWER_WINDOW_MS + 1), NOW)).toBe(false);
    expect(isFresh({ ...at(0), at: null }, NOW)).toBe(false);
  });
});

describe("whose 라피 is working, read off the room", () => {
  test("a person asked and their 라피 has not answered after it", () => {
    expect(
      lafiWorking(
        [
          { seq: 3, by: "m:m_park", mentions: ["lafi"], at: ago(1_000) },
          { seq: 1, by: "m:m_kim", mentions: ["lafi"], at: ago(5_000) },
          { seq: 2, by: "bot:m_kim", mentions: [], at: ago(4_000) },
          { seq: 4, by: "m:m_lee", mentions: ["m_park"], at: ago(500) },
        ],
        NOW,
      ),
    ).toEqual([{ member: "m_park", seq: 3 }]);
  });

  test("an answer from before the question does not end it, and asking twice is one line", () => {
    expect(
      lafiWorking(
        [
          { seq: 1, by: "bot:m_kim", mentions: [], at: ago(9_000) },
          { seq: 2, by: "m:m_kim", mentions: ["lafi"], at: ago(5_000) },
          { seq: 3, by: "m:m_kim", mentions: ["lafi"], at: ago(4_000) },
        ],
        NOW,
      ),
    ).toEqual([{ member: "m_kim", seq: 2 }]);
  });

  test("two quick questions: the first one's answer leaves the second shown until its own", () => {
    const asked = [
      { seq: 1, by: "m:m_kim", mentions: ["lafi"], at: ago(9_000) },
      { seq: 2, by: "m:m_kim", mentions: ["lafi"], at: ago(8_000) },
      {
        seq: 3,
        by: "bot:m_kim",
        mentions: [],
        runId: "room:r_1:1",
        at: ago(5_000),
      },
    ];
    expect(lafiWorking(asked, NOW)).toEqual([{ member: "m_kim", seq: 2 }]);
    expect(
      lafiWorking(
        [
          ...asked,
          {
            seq: 4,
            by: "bot:m_kim",
            mentions: [],
            runId: "room:r_1:2",
            at: ago(1_000),
          },
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  test("the first question got no answer and the second did: nothing is being worked on", () => {
    expect(
      lafiWorking(
        [
          { seq: 1, by: "m:m_kim", mentions: ["lafi"], at: ago(90_000) },
          { seq: 2, by: "m:m_kim", mentions: ["lafi"], at: ago(30_000) },
          {
            seq: 3,
            by: "bot:m_kim",
            mentions: [],
            runId: "room:r_1:2",
            at: ago(1_000),
          },
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  test("the first question answered late leaves the second shown", () => {
    expect(
      lafiWorking(
        [
          { seq: 1, by: "m:m_kim", mentions: ["lafi"], at: ago(11 * 60_000) },
          { seq: 2, by: "m:m_kim", mentions: ["lafi"], at: ago(3 * 60_000) },
          {
            seq: 3,
            by: "bot:m_kim",
            mentions: [],
            runId: "room:r_1:1",
            at: ago(30_000),
          },
        ],
        NOW,
      ),
    ).toEqual([{ member: "m_kim", seq: 2 }]);
  });

  test("a question past the window is no longer shown as worked on", () => {
    expect(
      lafiWorking(
        [
          {
            seq: 1,
            by: "m:m_kim",
            mentions: ["lafi"],
            at: ago(ROOM_ANSWER_WINDOW_MS + 1),
          },
        ],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("what a room's turn posts", () => {
  const asked: Message = { id: "room:r_1:4", role: "user", content: "@라피" };
  const said = (content: string): Message => ({
    id: crypto.randomUUID(),
    role: "assistant",
    content,
  });

  test("the last words after the question, not a delegated run's", () => {
    const messages = [
      said("지난번 답"),
      asked,
      said("찾아볼게요."),
      {
        ...said("브라우저에서 본 것"),
        lafDelegated: "call-1",
      } as unknown as Message,
      said("오늘은 16일이에요."),
    ];
    expect(answerOf(messages, "room:r_1:4", "r_1")).toEqual({
      text: "오늘은 16일이에요.",
      postedItself: false,
    });
    // Nothing said after it: nothing to post, not the last turn's words.
    expect(answerOf([said("지난번 답"), asked], "room:r_1:4", "r_1")).toEqual({
      text: "",
      postedItself: false,
    });
  });

  test("a post the Bot made to this room itself, and not one to another room", () => {
    const posting = (room: string): Message =>
      ({
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-2",
            type: "function",
            function: {
              name: "mcp__hub__write",
              arguments: JSON.stringify({ kind: "post", room, text: "16일" }),
            },
          },
        ],
      }) as Message;
    expect(
      answerOf([asked, posting("r_1"), said("올렸어요.")], "room:r_1:4", "r_1")
        .postedItself,
    ).toBe(true);
    expect(
      answerOf([asked, posting("r_2"), said("올렸어요.")], "room:r_1:4", "r_1")
        .postedItself,
    ).toBe(false);
  });
});
