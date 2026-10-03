/**
 * ONE SET OF WORDS FOR HOW A TASK STANDS (UX review 0.5.4, item 2).
 *
 * The card, the banner, 오늘 and the drawer read `task-state.ts`, and it reads its reasons out of a
 * table by code — `t(variable)`, which the i18n coverage test cannot see — so this walks the table.
 */
import { describe, expect, test } from "bun:test";
import { SITE_REFUSED } from "@shared/task-ending";
import { OUTCOME_LABELS } from "@/lib/computer/outcome-labels";
import {
  canRetry,
  failureReason,
  NO_RETRY,
  REASONS,
  type TaskState,
  taskStateDetail,
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
      "내 차례",
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

  /*
   * NOR FOR A REFUSAL NO SECOND ASKING CHANGES — and only for one. The floor under every rule
   * refuses the app's own address whoever asks; the card offered 다시 해 보기 under it, a button that
   * could only fail again. `laf:navigation_refused` is not such a code: the floor says it for an
   * address inside the deployment, and also for a name that would not resolve just then and for
   * an address the Bot wrote wrongly, and asking again can get past those (review of this change).
   * Nor is a rule that refused: the person can change the rule.
   */
  test("nor for the app's own address; what a second asking can change is still offered", () => {
    expect(canRetry({ kind: "failed", code: "laf:own_address_refused" })).toBe(
      false,
    );
    for (const code of [
      "laf:navigation_refused",
      "laf:url_invalid",
      "laf:policy_denied",
      "laf:no_rule_allows",
      "laf:computer_unreachable",
    ]) {
      expect([code, canRetry({ kind: "failed", code })]).toEqual([code, true]);
    }
    expect([...NO_RETRY].sort()).toEqual([
      "laf:own_address_refused",
      "laf:person_declined",
    ]);
    // Every code named there is one the card has words for: no retry and no reason would be a
    // card that says only 못 끝냄.
    for (const code of NO_RETRY) {
      expect([code, failureReason(code) !== undefined]).toEqual([code, true]);
      expect(
        ko[(REASONS[code] ?? OUTCOME_LABELS[code]) as string],
      ).toBeTruthy();
    }
  });

  test("the line under the title: why it did not finish, or whose turn it is, and nothing else", () => {
    expect(taskStateDetail({ kind: "failed", code: SITE_REFUSED })).toBe(
      "The site turned the Bot away",
    );
    expect(
      taskStateDetail({ kind: "failed", code: "laf:own_address_refused" }),
    ).toBe("This app's own address was not opened");
    // The facts do not say why: nothing is made up, and the card says what the Bot said last.
    expect(taskStateDetail({ kind: "failed", code: null })).toBeUndefined();
    const waiting = taskStateDetail({ kind: "yourTurn" });
    expect(waiting).toBe(
      "It is waiting for your answer. The question is just above.",
    );
    expect(ko[waiting as string]).toBe(
      "답을 기다려요. 묻는 카드는 바로 위에 있어요.",
    );
    for (const kind of ["running", "done", "stopped"] as const) {
      expect([kind, taskStateDetail({ kind })]).toEqual([kind, undefined]);
    }
  });
});
