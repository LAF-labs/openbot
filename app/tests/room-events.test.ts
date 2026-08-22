import { describe, expect, test } from "bun:test";
import {
  applyRoomFrame,
  EMPTY_ROOM,
  mergeApprovals,
  mergeStored,
  type RoomState,
  turnLost,
  withoutApproval,
} from "../src/lib/channels/room-events";
import {
  ROOM_FRAME_KINDS,
  type RoomFrame,
} from "../src/lib/channels/room-frames";

/**
 * The rules a room's screen follows as frames arrive. Every one exists because the socket drops,
 * replays, and carries turns that are already over.
 */

const ROOM = "channel_a";
const base = { channelId: ROOM, turnId: "t1", epoch: 3 } as const;
const turn: RoomFrame = {
  ...base,
  kind: "room.turn",
  members: [{ id: "risk", name: "리스크 분석가" }],
};
const open: RoomFrame = {
  ...base,
  kind: "room.open",
  messageId: "call_1",
  authorId: "risk",
  authorName: "리스크 분석가",
};
const delta = (text: string): RoomFrame => ({
  ...base,
  kind: "room.delta",
  messageId: "call_1",
  text,
});

function after(frames: RoomFrame[], from: RoomState = EMPTY_ROOM): RoomState {
  return frames.reduce(
    (state, frame) => applyRoomFrame(state, frame, ROOM),
    from,
  );
}

describe("a member typing", () => {
  test("opens a provisional message with its author, then carries the whole text each time", () => {
    const state = after([turn, open, delta("안녕"), delta("안녕하세요")]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe("안녕하세요");
    expect(state.messages[0]?.streaming).toBe(true);
    expect(state.speakers.call_1).toBe("risk");
    expect(state.turnId).toBe("t1");
  });

  test("a delta whose open frame was lost still appears", () => {
    const state = after([turn, delta("안녕하세요")]);
    expect(state.messages[0]?.content).toBe("안녕하세요");
  });

  test("the same text twice changes nothing, so nothing re-renders", () => {
    const once = after([turn, open, delta("안녕")]);
    expect(applyRoomFrame(once, delta("안녕"), ROOM)).toBe(once);
  });
});

describe("a message landing", () => {
  test("the settled copy replaces the provisional bubble IN PLACE, keeping its author", () => {
    /*
     * The first version removed the provisional bubble here and waited for catch-up to bring the
     * stored copy. Measured: every reply blinked off the screen at stream end and came back a
     * second or two later. Now the frame names the bubble it replaces and carries the stored id.
     */
    const state = after([
      turn,
      open,
      delta("안녕하"),
      {
        ...base,
        kind: "room.end",
        messageId: "call_1",
        posted: true,
        storedId: "stored_1",
        at: "2026-08-22T00:00:01.000Z",
        text: "안녕하세요",
      },
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.id).toBe("stored_1");
    expect(state.messages[0]?.content).toBe("안녕하세요");
    expect(state.messages[0]?.streaming).toBeUndefined();
    expect(state.speakers.call_1).toBeUndefined();
    expect(state.speakers.stored_1).toBe("risk");
    expect(state.times.stored_1).toBe("2026-08-22T00:00:01.000Z");
  });

  test("settling keeps its position between neighbours rather than jumping to the end", () => {
    const before = after([turn, open, delta("첫")]);
    const withLater = {
      ...before,
      messages: [
        ...before.messages,
        { id: "u9", role: "user" as const, content: "뒤에 온 질문" },
      ],
    };
    const state = applyRoomFrame(
      withLater,
      {
        ...base,
        kind: "room.end",
        messageId: "call_1",
        posted: true,
        storedId: "s1",
        text: "첫 번째",
      },
      ROOM,
    );
    expect(state.messages.map((m) => m.id)).toEqual(["s1", "u9"]);
  });

  test("catch-up arriving first is not a duplicate: the provisional one is dropped, the stored one kept once", () => {
    const typing = after([turn, open, delta("안녕")]);
    const caughtUp = mergeStored(
      typing,
      [{ id: "s1", role: "assistant", content: "안녕하세요" }],
      {
        speakers: { s1: "risk" },
        times: {},
      },
    );
    const state = applyRoomFrame(
      caughtUp,
      {
        ...base,
        kind: "room.end",
        messageId: "call_1",
        posted: true,
        storedId: "s1",
        text: "안녕하세요",
      },
      ROOM,
    );
    expect(state.messages.filter((m) => m.id === "s1")).toHaveLength(1);
    expect(state.messages.some((m) => m.id === "call_1")).toBe(false);
  });

  test("a refused message comes off too, rather than leaving words that are not in the room", () => {
    const state = after([
      turn,
      open,
      delta("네 번째 메시지"),
      { ...base, kind: "room.end", messageId: "call_1", posted: false },
    ]);
    expect(state.messages).toHaveLength(0);
  });

  test("whatever is still provisional when the turn ends was never posted", () => {
    const state = after([
      turn,
      open,
      delta("끊긴 문장"),
      { ...base, kind: "room.done", reason: "superseded" },
    ]);
    expect(state.messages).toHaveLength(0);
    expect(state.turnId).toBeNull();
  });
});

describe("turns that are not this one", () => {
  test("a frame from an older turn is ignored: its member is answering a superseded question", () => {
    const current = after([turn]);
    const stale = applyRoomFrame(
      current,
      { ...open, epoch: 2, turnId: "t0" },
      ROOM,
    );
    expect(stale).toBe(current);
  });

  test("a frame from a newer turn is adopted, because we missed its start", () => {
    const current = after([turn]);
    const next = applyRoomFrame(
      current,
      { ...open, epoch: 4, turnId: "t2" },
      ROOM,
    );
    expect(next.turnId).toBe("t2");
    expect(next.messages).toHaveLength(1);
  });

  test("a frame for another room returns the very same state object", () => {
    const current = after([turn]);
    expect(
      applyRoomFrame(current, { ...open, channelId: "channel_b" }, ROOM),
    ).toBe(current);
  });
});

describe("catching up from the server", () => {
  test("stored messages come in, what is still being typed survives, known ones keep identity", () => {
    const typing = after([turn, open, delta("입력 중")]);
    const stored = [{ id: "u1", role: "user" as const, content: "질문" }];
    const merged = mergeStored(typing, stored, {
      speakers: {},
      times: { u1: "2026-08-22T00:00:00.000Z" },
    });
    expect(merged.messages.map((m) => m.id)).toEqual(["u1", "call_1"]);
    expect(merged.times.u1).toBeDefined();

    const again = mergeStored(merged, stored, { speakers: {}, times: {} });
    expect(again.messages[0]).toBe(merged.messages[0]);
  });
});

describe("the two halves of the contract", () => {
  test("the client's frame kinds are the server's, by value", async () => {
    const server = await import("../../server/src/rooms/frames");
    expect([...ROOM_FRAME_KINDS]).toEqual([...server.ROOM_FRAME_KINDS]);
  });
});

describe("a member waiting on an answer", () => {
  const approval: RoomFrame = {
    ...base,
    kind: "room.approval",
    memberId: "risk",
    memberName: "리스크 분석가",
    approvalId: "ap_1",
    question: "Send the report to the client?",
    rule: "send_email",
  };
  const done: RoomFrame = { ...base, kind: "room.done", reason: "ended" };

  test("is raised to the room once, however often the frame arrives", () => {
    const state = after([turn, approval, approval]);
    expect(state.approvals.map((a) => a.approvalId)).toEqual(["ap_1"]);
    expect(state.approvals[0]?.memberName).toBe("리스크 분석가");
  });

  test("outlives the turn, and comes down when answered", () => {
    // The server holds a question for ten minutes; the person answers on their own time.
    const state = after([turn, approval, done]);
    expect(state.turnId).toBeNull();
    expect(state.approvals).toHaveLength(1);
    expect(withoutApproval(state, "ap_1").approvals).toEqual([]);
    expect(withoutApproval(state, "nobody")).toBe(state);
  });

  test("is not typing: a question from a superseded turn still stands", () => {
    const state = after([{ ...approval, epoch: 1 }], {
      ...EMPTY_ROOM,
      epoch: 3,
      turnId: "t2",
    });
    expect(state.approvals).toHaveLength(1);
  });

  test("comes down for every tab when it is answered", () => {
    const state = after([turn, approval, { ...approval, answered: true }]);
    expect(state.approvals).toEqual([]);
  });

  test("survives catch-up", () => {
    const state = mergeStored(after([turn, approval]), [], {
      speakers: {},
      times: {},
    });
    expect(state.approvals).toHaveLength(1);
  });
});

describe("catching up on questions", () => {
  const question = {
    approvalId: "ap_1",
    memberId: "risk",
    memberName: "리스크 분석가",
    question: "Open wttr.in?",
    rule: "true",
  };
  const asked: RoomFrame = { ...base, kind: "room.approval", ...question };

  test("a question raised while the room was closed still appears", () => {
    // No frame ever reached this tab: the member stopped at the boundary before it was opened.
    expect(mergeApprovals(EMPTY_ROOM, [question]).approvals).toEqual([
      question,
    ]);
  });

  test("a question already on screen is not duplicated", () => {
    expect(mergeApprovals(after([turn, asked]), [question]).approvals).toEqual([
      question,
    ]);
  });

  test("a question the server no longer lists comes down", () => {
    // Expired, or answered in another tab. Nothing is waiting for it any more.
    expect(mergeApprovals(after([turn, asked]), []).approvals).toEqual([]);
  });

  test("an unchanged set returns the same object, so nothing re-renders", () => {
    const before = after([turn, asked]);
    expect(mergeApprovals(before, [question])).toBe(before);
    expect(mergeApprovals(EMPTY_ROOM, [])).toBe(EMPTY_ROOM);
  });

  test("messages and the turn are untouched", () => {
    const withMessage = after([turn, open, delta("반가워요")]);
    const state = mergeApprovals(withMessage, [question]);
    expect(state.messages).toEqual(withMessage.messages);
    expect(state.turnId).toBe(withMessage.turnId);
  });
});

describe("a connection that went away", () => {
  /*
   * Frames are not replayed. A socket that drops during a turn takes the turn's end with it, and a
   * room that believes a turn is still running keeps its composer disabled with nothing the person
   * can do about it.
   */
  test("the turn is let go, with whatever was half-typed", () => {
    const mid = after([turn, open, delta("생각 중")]);
    expect(mid.turnId).not.toBeNull();
    expect(mid.messages).toHaveLength(1);

    const recovered = turnLost(mid);
    expect(recovered.turnId).toBeNull();
    expect(recovered.messages).toEqual([]);
  });

  test("a settled message survives it", () => {
    const settled = after([
      turn,
      open,
      delta("반가워요"),
      {
        ...base,
        kind: "room.end",
        messageId: "call_1",
        posted: true,
        storedId: "m1",
        at: "2026-08-22T13:00:00.000Z",
        text: "반가워요",
      },
    ]);
    const recovered = turnLost(settled);
    expect(recovered.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  test("a turn that really is still running says so with its next frame", () => {
    const recovered = turnLost(after([turn, open]));
    const resumed = applyRoomFrame(recovered, delta("이어서"), ROOM);
    expect(resumed.turnId).toBe("t1");
    expect(resumed.messages).toHaveLength(1);
  });

  test("an idle room is returned unchanged, so nothing re-renders", () => {
    expect(turnLost(EMPTY_ROOM)).toBe(EMPTY_ROOM);
  });
});

describe("interrupting a room mid-reply", () => {
  test("a half-typed message goes with the turn it belonged to", () => {
    /*
     * The person said something else. The fragment on screen belongs to a turn that is now
     * superseded, and its own end frame will be dropped as stale — so it would have sat there until
     * the NEXT turn happened to finish.
     */
    const mid = after([turn, open, delta("생각하고 있는")]);
    expect(mid.messages).toHaveLength(1);

    const next = applyRoomFrame(
      mid,
      { ...base, kind: "room.turn", turnId: "t2", epoch: 4, members: [] },
      ROOM,
    );
    expect(next.messages).toEqual([]);
    expect(next.turnId).toBe("t2");
    expect(next.epoch).toBe(4);
  });

  test("messages that had settled are kept", () => {
    const settled = after([
      turn,
      open,
      delta("반가워요"),
      {
        ...base,
        kind: "room.end",
        messageId: "call_1",
        posted: true,
        storedId: "m1",
        at: "2026-08-22T13:00:00.000Z",
        text: "반가워요",
      },
    ]);
    const next = applyRoomFrame(
      settled,
      { ...base, kind: "room.turn", turnId: "t2", epoch: 4, members: [] },
      ROOM,
    );
    expect(next.messages.map((m) => m.id)).toEqual(["m1"]);
  });
});
