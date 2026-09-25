/**
 * ONE SET OF WORDS FOR HOW A TASK STANDS (UX review 0.5.4, item 2).
 *
 * The card, the banner, 오늘 and the drawer read `task-state.ts`, and it reads its reasons out of a
 * table by code — `t(variable)`, which the i18n coverage test cannot see — so this walks the table.
 */
import { describe, expect, test } from "bun:test";
import { SITE_REFUSED } from "@shared/task-ending";
import {
  canRetry,
  failureReason,
  REASONS,
  type TaskState,
  taskStateLine,
  taskStateWord,
} from "@/lib/computer/task-state";
import { ko } from "@/lib/i18n-ko";

const STATES: TaskState[] = [
  { kind: "running" },
  { kind: "yourTurn" },
  { kind: "done" },
  { kind: "stopped" },
  { kind: "failed", code: null },
];

describe("how a task stands, in words", () => {
  test("five states, five different words, each in Korean", () => {
    const words = STATES.map(taskStateWord);
    expect(new Set(words).size).toBe(STATES.length);
    for (const word of words) expect(ko[word]).toBeTruthy();
    // The owner's own words, the ones the review settled on.
    expect(words.map((word) => ko[word])).toEqual([
      "하는 중",
      "사장님 차례",
      "끝남",
      "멈춤",
      "못 끝냄",
    ]);
  });

  test("every reason in the table has its Korean", () => {
    for (const key of Object.values(REASONS)) expect(ko[key]).toBeTruthy();
  });

  test("못 끝냄 says why when the facts do, and only the word when they do not", () => {
    expect(taskStateLine({ kind: "failed", code: SITE_REFUSED })).toBe(
      "Couldn't finish · The site turned the Bot away",
    );
    expect(
      taskStateLine({ kind: "failed", code: "laf:computer_unreachable" }),
    ).toBe("Couldn't finish · The Bot's computer could not be reached");
    expect(taskStateLine({ kind: "failed", code: "laf:no_such_code" })).toBe(
      "Couldn't finish",
    );
    expect(failureReason(null)).toBeUndefined();
    expect(taskStateLine({ kind: "stopped" })).toBe("Halted");
  });

  test("다시 해 보기 is offered for a failure, never for the owner's own no", () => {
    expect(canRetry({ kind: "failed", code: SITE_REFUSED })).toBe(true);
    expect(canRetry({ kind: "failed", code: null })).toBe(true);
    expect(canRetry({ kind: "failed", code: "laf:person_declined" })).toBe(
      false,
    );
    expect(canRetry({ kind: "stopped" })).toBe(false);
    expect(canRetry({ kind: "done" })).toBe(false);
  });
});
