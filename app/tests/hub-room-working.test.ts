import { describe, expect, test } from "bun:test";
import {
  asksLafi,
  nextWorkingChange,
  ROOM_WORKING_ASKER_MS,
  ROOM_WORKING_SHOWN_MS,
  type RoomLine,
  roomConversationOf,
  workingInRoom,
} from "../src/lib/hub/room-working";

/**
 * A team room's "○○의 라피가 알아보는 중": a person's "@라피" with no answer from their 라피 after it,
 * for two minutes on everybody's screen (a failed turn posts nothing, so ten would hang), and for
 * longer on the asker's own while their VM's room run is still going.
 */

const T0 = Date.parse("2026-10-17T07:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

const ask: RoomLine = { seq: 3, by: "m:m_b", mentions: ["lafi"], at: at(0) };
const chat: RoomLine = { seq: 4, by: "m:m_a", mentions: [], at: at(5_000) };

describe("whose 라피 is working in a room", () => {
  test("a person asking their 라피, unanswered, is shown", () => {
    expect(workingInRoom([ask, chat], T0 + 30_000)).toEqual([
      { member: "m_b", seq: 3 },
    ]);
  });

  test("their 라피's answer after the question ends it", () => {
    const answer: RoomLine = {
      seq: 5,
      by: "bot:m_b",
      mentions: [],
      at: at(40_000),
    };
    expect(workingInRoom([ask, chat, answer], T0 + 45_000)).toEqual([]);
  });

  test("another member's 라피 answering does not end it", () => {
    const other: RoomLine = {
      seq: 5,
      by: "bot:m_a",
      mentions: [],
      at: at(40_000),
    };
    expect(workingInRoom([ask, other], T0 + 45_000)).toEqual([
      { member: "m_b", seq: 3 },
    ]);
  });

  test("a message without the mention is not a question to a 라피", () => {
    expect(workingInRoom([chat], T0 + 6_000)).toEqual([]);
  });

  test("on everybody else's screen it goes two minutes after the question", () => {
    expect(
      workingInRoom([ask], T0 + ROOM_WORKING_SHOWN_MS, { me: "m_a" }),
    ).toHaveLength(1);
    expect(
      workingInRoom([ask], T0 + ROOM_WORKING_SHOWN_MS + 1, { me: "m_a" }),
    ).toEqual([]);
  });

  test("on the asker's screen it stays while their room run is going, up to ten minutes", () => {
    const later = T0 + ROOM_WORKING_SHOWN_MS + 60_000;
    expect(
      workingInRoom([ask], later, { me: "m_b", myRoomRun: true }),
    ).toHaveLength(1);
    expect(
      workingInRoom([ask], later, { me: "m_b", myRoomRun: false }),
    ).toEqual([]);
    expect(
      workingInRoom([ask], T0 + ROOM_WORKING_ASKER_MS + 1, {
        me: "m_b",
        myRoomRun: true,
      }),
    ).toEqual([]);
  });

  test("a second question after an answered one is shown, once per member", () => {
    const answer: RoomLine = {
      seq: 5,
      by: "bot:m_b",
      mentions: [],
      at: at(30_000),
    };
    const again: RoomLine = {
      seq: 6,
      by: "m:m_b",
      mentions: ["lafi"],
      at: at(50_000),
    };
    const third: RoomLine = {
      seq: 7,
      by: "m:m_b",
      mentions: ["lafi"],
      at: at(55_000),
    };
    expect(workingInRoom([third, ask, answer, again], T0 + 60_000)).toEqual([
      { member: "m_b", seq: 6 },
    ]);
  });

  test("the line next changes when the shown question's window runs out", () => {
    const shown = workingInRoom([ask], T0 + 10_000);
    expect(nextWorkingChange([ask], shown)).toBe(
      T0 + ROOM_WORKING_SHOWN_MS + 1,
    );
    expect(nextWorkingChange([ask], [])).toBeNull();
  });
});

describe("asking from the box", () => {
  test("@라피 asks the writer's own 라피", () => {
    expect(asksLafi("@라피 이번 주 일정 알려줘")).toBe(true);
    expect(asksLafi("라피한테 물어볼게요")).toBe(false);
  });

  test("the asker's conversation for the room is the one named by the room", () => {
    const channels = [
      { id: "channel_main" },
      { id: "room_r_1_agent_9" },
      { id: "room_r_12_agent_9" },
    ];
    expect(roomConversationOf("r_1", channels)?.id).toBe("room_r_1_agent_9");
    expect(roomConversationOf("r_2", channels)).toBeUndefined();
  });
});
