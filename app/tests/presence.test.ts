import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  PRESENCE_LABELS,
  type PresenceFacts,
  presenceOf,
  publishTurn,
  readTurn,
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
    expect(ko["Needs your OK"]).toBe("사장님 확인 필요");
    expect(ko["Busy working"]).toBe("일하는 중");
    expect(ko.Answering).toBe("답하는 중");
  });
});
