import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  isTurnTold,
  leaveWord,
  PRESENCE_LABELS,
  type PresenceFacts,
  presenceOf,
  publishTurn,
  readLastWord,
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

  /*
   * Both put the Bot's face in its asking expression until 2026-10-09. The Bot has no face now, so
   * the word is what says what is wanted, and the tone is what says it is the person's turn.
   */
  test("both are amber, and each says in its own word what it wants", () => {
    const said = [{ approvals: 2 }, { isHelpWanted: true }].map((facts) => {
      const presence = presenceOf({ ...QUIET, ...facts });
      expect(presence.tone).toBe("attention");
      expect(presence).not.toHaveProperty("face");
      return presence.label;
    });
    expect(said).toEqual(["Needs your OK", "Needs your help"]);
  });
});

describe("then the work, most visible first", () => {
  test("the browser open is working, whatever the turn says", () => {
    expect(kind({ isBrowsing: true })).toBe("working");
    expect(kind({ isBrowsing: true, turn: "answering" })).toBe("working");
    expect(presenceOf({ ...QUIET, isBrowsing: true })).toMatchObject({
      tone: "active",
      label: "Busy working",
    });
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
    });
    expect(presenceOf(QUIET)).toMatchObject({
      kind: "idle",
      tone: "quiet",
    });
  });

  test("a turn going with no conversation on screen is working — not ready", () => {
    expect(presenceOf({ ...QUIET, isTurnOffScreen: true })).toMatchObject({
      kind: "working",
      label: "Busy working",
      tone: "active",
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
      lastWord: null,
      ...facts,
    });

  test("with no conversation ever on this screen, the server's list says it is going", () => {
    expect(off({ isListed: true })).toBe(true);
    expect(off({ isListed: false })).toBe(false);
  });

  test("a conversation on screen is the only word on its own turn", () => {
    // The list is a poll: it still names the run for a moment after the conversation saw it end.
    expect(off({ isTold: true, isListed: true })).toBe(false);
    expect(off({ isTold: true, lastWord: { at: 2_000, going: true } })).toBe(
      false,
    );
  });

  test("a list read before the conversation left cannot say its turn has ended", () => {
    const leftGoing = { at: 2_000, going: true };
    // The list in hand was read at 1,000 and does not name the turn.
    expect(off({ lastWord: leftGoing, listedAt: 1_000 })).toBe(true);
    // Read again after leaving, and it still does not: the turn is over.
    expect(off({ lastWord: leftGoing, listedAt: 2_500 })).toBe(false);
    // A list never read at all is older than any leaving.
    expect(off({ lastWord: leftGoing, listedAt: 0 })).toBe(true);
  });

  /*
   * Codex, second round: the conversation saw the turn end; the list in hand, read while it ran,
   * still names it. On screen that list was ignored. Leaving kept no word of an ended turn, so the
   * next screen read the old list and said the Bot was working — until the poll, thirty seconds on.
   */
  test("nor can it bring back a turn the conversation saw end", () => {
    const leftIdle = { at: 2_000, going: false };
    expect(off({ lastWord: leftIdle, isListed: true, listedAt: 1_000 })).toBe(
      false,
    );
    // A list read after the leaving does name a turn: something started since. It is believed.
    expect(off({ lastWord: leftIdle, isListed: true, listedAt: 2_500 })).toBe(
      true,
    );
  });

  test("the last word is kept either way, and coming back forgets it", () => {
    startTelling("bot-c");
    expect(isTurnTold("bot-c")).toBe(true);
    stopTelling("bot-c");
    leaveWord("bot-c", 5_000, true);
    expect(isTurnTold("bot-c")).toBe(false);
    expect(readLastWord("bot-c")).toEqual({ at: 5_000, going: true });
    startTelling("bot-c");
    expect(readLastWord("bot-c")).toBeNull();
    stopTelling("bot-c");
    leaveWord("bot-c", 6_000, false);
    expect(readLastWord("bot-c")).toEqual({ at: 6_000, going: false });
    // The same object until the next leaving: a snapshot React can compare.
    expect(readLastWord("bot-c")).toBe(readLastWord("bot-c"));
    expect(isTurnTold(undefined)).toBe(false);
    expect(readLastWord(undefined)).toBeNull();
  });

  test("two conversations of one Bot: it is told until the last one leaves, and only that one's word is kept", () => {
    startTelling("bot-d");
    startTelling("bot-d");
    stopTelling("bot-d");
    leaveWord("bot-d", 7_000, true);
    expect(isTurnTold("bot-d")).toBe(true);
    expect(readLastWord("bot-d")).toBeNull();
    stopTelling("bot-d");
    leaveWord("bot-d", 8_000, true);
    expect(isTurnTold("bot-d")).toBe(false);
    expect(readLastWord("bot-d")).toEqual({ at: 8_000, going: true });
  });

  test("no longer telling is not leaving: it keeps no word by itself", () => {
    startTelling("bot-e");
    stopTelling("bot-e");
    expect(isTurnTold("bot-e")).toBe(false);
    expect(readLastWord("bot-e")).toBeNull();
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
