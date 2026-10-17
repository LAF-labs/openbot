import { describe, expect, test } from "bun:test";
import { liveTurnFailureCode } from "../src/lib/channels/turn-failure";
import {
  allowedLine,
  BOARD_TASK_REFUSALS,
  boardTaskIdOf,
  topicPlace,
  waitingLine,
} from "../src/lib/hub/board-task";
import { ko } from "../src/lib/i18n-ko";

/**
 * A company board task's conversation, stopped for its person's yes: which conversations are one,
 * where the stop was in plain words, and the lines before and after "이 일감에서는 해도 돼". The
 * server decides everything (`server/src/hub/task-asks.ts`); this only says it.
 */

describe("a board task's conversation", () => {
  test("is the one named task:<id>, and no other", () => {
    expect(boardTaskIdOf("task:t_42")).toBe("t_42");
    expect(boardTaskIdOf("task:")).toBeNull();
    expect(boardTaskIdOf("ch_1:main")).toBeNull();
  });

  test("says where it stopped, and only the place", () => {
    expect(topicPlace("browser/activate@shop.example.test")).toBe(
      "shop.example.test",
    );
    expect(topicPlace("tool/call_tool@notion/create_page")).toBe(
      "notion/create_page",
    );
    expect(topicPlace("file/write_file")).toBeNull();
    expect(waitingLine({ topic: "browser/activate@shop.example.test" })).toBe(
      "This task stopped for your OK on shop.example.test.",
    );
    expect(waitingLine({ topic: "file/write_file" })).toBe(
      "This task stopped for your OK.",
    );
  });

  test("after the press, says what became of the board", () => {
    expect(allowedLine("queued")).toContain("goes back to the board");
    expect(allowedLine("not_blocked")).toContain("already moved");
    expect(allowedLine("unreachable")).toContain("could not be reached");
  });

  // Read through a variable, so the coverage walk cannot see them: walked here.
  test.each(Object.entries(BOARD_TASK_REFUSALS))(
    "%s has its Korean",
    (_code, english) => {
      expect(ko[english]).toBeString();
    },
  );
});

describe("the company's day, spent", () => {
  test("reads as its own failure, not the trial's", () => {
    expect(liveTurnFailureCode("laf:budget_reached")).toBe(
      "laf:turn_company_budget_reached",
    );
    expect(liveTurnFailureCode("laf:daily_budget_reached")).toBe(
      "laf:turn_daily_budget_reached",
    );
  });
});
