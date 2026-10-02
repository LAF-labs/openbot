import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  isTurnTold,
  PRESENCE_LABELS,
  type PresenceFacts,
  presenceOf,
  publishTurn,
  readLeftGoingAt,
  readTurn,
  startTelling,
  stopTelling,
  turnOffScreen,
  turnPhaseOf,
} from "../src/lib/agents/presence";
import { ko } from "../src/lib/i18n-ko";

/**
 * The header's pill: one word for what the Bot is doing, decided from facts the app already has.
 * What matters is the ORDER — a Bot waiting on an approval is also mid-turn with its browser open,
 * and "일하는 중" over a card that cannot move until somebody presses it is the lie the pill is for.
 */

const QUIET: PresenceFacts = {
  turn: "idle",
  isBrowsing: false,
  approvals: 0,
  isHelpWanted: false,
  isRoutineRunning: false,
  isTurnOffScreen: false,
};

const kind = (facts: Partial<PresenceFacts>) =>
  presenceOf({ ...QUIET, ...facts }).kind;

describe("the pill says the person's turn before anything else", () => {
  test("an approval waiting beats the browser, the turn and a help request", () => {
    expect(
      kind({
        approvals: 1,
        isBrowsing: true,
        turn: "working",
        isHelpWanted: true,
        isRoutineRunning: true,
      }),
    ).toBe("approval");
  });

  test("a help request beats the work it interrupted", () => {
    expect(kind({ isHelpWanted: true, isBrowsing: true })).toBe("help");
    expect(kind({ isHelpWanted: true, turn: "answering" })).toBe("help");
  });

  test("both are amber and both put the face in its asking expression", () => {
    for (const facts of [{ approvals: 2 }, { isHelpWanted: true }]) {
      const presence = presenceOf({ ...QUIET, ...facts });
      expect(presence.tone).toBe("attention");
      expect(presence.face).toBe("blocked");
    }
  });
});

describe("then the work, most visible first", () => {
  test("the browser open is working, whatever the turn says", () => {
    expect(kind({ isBrowsing: true })).toBe("working");
    expect(kind({ isBrowsing: true, turn: "answering" })).toBe("working");
    expect(presenceOf({ ...QUIET, isBrowsing: true }).face).toBe("searching");
  });

  test("a tool call in flight is working too", () => {
    expect(kind({ turn: "working" })).toBe("working");
  });

  test("a routine nobody in this window started is said before the turn's own phases", () => {
    expect(kind({ isRoutineRunning: true })).toBe("routine");
    expect(kind({ isRoutineRunning: true, turn: "answering" })).toBe("routine");
  });

  test("answering, thinking, and ready — each in the Bot's colour except the last", () => {
    expect(presenceOf({ ...QUIET, turn: "answering" })).toMatchObject({
      kind: "answering",
      tone: "active",
    });
    expect(presenceOf({ ...QUIET, turn: "thinking" })).toMatchObject({
      kind: "thinking",
      tone: "active",
      face: "thinking",
    });
    expect(presenceOf(QUIET)).toMatchObject({
      kind: "idle",
      tone: "quiet",
      face: "idle",
    });
  });

  test("a turn going with no conversation on screen is working — not ready", () => {
    expect(presenceOf({ ...QUIET, isTurnOffScreen: true })).toMatchObject({
      kind: "working",
      label: "Busy working",
      tone: "active",
      face: "working",
    });
  });

  test("and it is still the last thing asked: a question, help and a routine are said first", () => {
    expect(kind({ isTurnOffScreen: true, approvals: 1 })).toBe("approval");
    expect(kind({ isTurnOffScreen: true, isHelpWanted: true })).toBe("help");
    expect(kind({ isTurnOffScreen: true, isRoutineRunning: true })).toBe(
      "routine",
    );
  });
});

/**
 * Measured 2026-10-02 on the running app: a turn was started, 소식 was opened, and for the rest of
 * the turn the pill and the tray read "쉬는 중" beside a conversation row reading "처리 중…". The
 * phase was only ever told by a mounted conversation; the turn is the server's and goes on.
 */
describe("a turn whose conversation is off this screen", () => {
  const off = (facts: Partial<Parameters<typeof turnOffScreen>[0]>) =>
    turnOffScreen({
      isTold: false,
      isListed: false,
      listedAt: 1_000,
      leftGoingAt: null,
      ...facts,
    });

  test("the server's list says it is going", () => {
    expect(off({ isListed: true })).toBe(true);
    expect(off({ isListed: false })).toBe(false);
  });

  test("a conversation on screen is the only word on its own turn", () => {
    // The list is a poll: it still names the run for a moment after the conversation saw it end.
    expect(off({ isTold: true, isListed: true })).toBe(false);
    expect(off({ isTold: true, leftGoingAt: 2_000 })).toBe(false);
  });

  test("a list read before the conversation left cannot say its turn has ended", () => {
    // Left at 2,000 with the turn going; the list in hand was read at 1,000 and does not name it.
    expect(off({ leftGoingAt: 2_000, listedAt: 1_000 })).toBe(true);
    // Read again after leaving, and it still does not: the turn is over.
    expect(off({ leftGoingAt: 2_000, listedAt: 2_500 })).toBe(false);
    // A list never read at all is older than any leaving.
    expect(off({ leftGoingAt: 2_000, listedAt: 0 })).toBe(true);
  });

  test("leaving with the turn going is kept, and coming back forgets it", () => {
    startTelling("bot-c");
    expect(isTurnTold("bot-c")).toBe(true);
    stopTelling("bot-c", 5_000);
    expect(isTurnTold("bot-c")).toBe(false);
    expect(readLeftGoingAt("bot-c")).toBe(5_000);
    startTelling("bot-c");
    expect(readLeftGoingAt("bot-c")).toBeNull();
    // Leaving with nothing going leaves nothing behind.
    stopTelling("bot-c", null);
    expect(readLeftGoingAt("bot-c")).toBeNull();
    expect(isTurnTold(undefined)).toBe(false);
  });

  test("two conversations of one Bot: it is told until the last one leaves", () => {
    startTelling("bot-d");
    startTelling("bot-d");
    stopTelling("bot-d", 7_000);
    expect(isTurnTold("bot-d")).toBe(true);
    expect(readLeftGoingAt("bot-d")).toBeNull();
    stopTelling("bot-d", 8_000);
    expect(isTurnTold("bot-d")).toBe(false);
    expect(readLeftGoingAt("bot-d")).toBe(8_000);
    startTelling("bot-d");
    stopTelling("bot-d", null);
  });
});

describe("where a turn is, read from the thread it is writing", () => {
  const user: Message = { id: "u", role: "user", content: "날씨 알려줘" };
  const calling: Message = {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "c1",
        type: "function",
        function: { name: "computer_navigate", arguments: "{}" },
      },
    ],
  };
  const result: Message = {
    id: "t1",
    role: "tool",
    toolCallId: "c1",
    content: "{}",
  };
  const words: Message = {
    id: "a2",
    role: "assistant",
    content: "오늘 서울은 맑아요.",
  };

  test("a turn that is not running is idle, whatever the thread ends with", () => {
    expect(turnPhaseOf([user, calling], false)).toBe("idle");
  });

  test("nothing after the person's message yet is thinking", () => {
    expect(turnPhaseOf([user], true)).toBe("thinking");
    expect(turnPhaseOf([], true)).toBe("thinking");
    expect(
      turnPhaseOf([user, { id: "a0", role: "assistant", content: "" }], true),
    ).toBe("thinking");
  });

  test("a tool call, or a tool's result, is working", () => {
    expect(turnPhaseOf([user, calling], true)).toBe("working");
    expect(turnPhaseOf([user, calling, result], true)).toBe("working");
  });

  test("words last is answering", () => {
    expect(turnPhaseOf([user, calling, result, words], true)).toBe("answering");
  });
});

describe("the turn is told by the conversation and taken back when it goes", () => {
  test("a phase is held per Bot, and idle forgets it", () => {
    publishTurn("bot-a", "answering");
    publishTurn("bot-b", "thinking");
    expect(readTurn("bot-a")).toBe("answering");
    expect(readTurn("bot-b")).toBe("thinking");
    publishTurn("bot-a", "idle");
    expect(readTurn("bot-a")).toBe("idle");
    publishTurn("bot-b", "idle");
    expect(readTurn(undefined)).toBe("idle");
  });
});

describe("the pill speaks Korean", () => {
  test("every label is in the Korean table — they are read through t(variable)", () => {
    // `i18n-coverage.test.ts` sees only literal `t("…")`; this table is read by variable.
    const missing = Object.values(PRESENCE_LABELS).filter(
      (label) => !(label in ko),
    );
    expect(missing).toEqual([]);
    expect(ko["Needs your OK"]).toBe("확인 필요");
    expect(ko["Busy working"]).toBe("일하는 중");
    expect(ko.Answering).toBe("답하는 중");
  });
});
