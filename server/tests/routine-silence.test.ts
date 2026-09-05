import { describe, expect, test } from "bun:test";
import { CHAT_KO } from "../../shared/prompt/mode/chat.ko";
import { ROUTINE_KO } from "../../shared/prompt/mode/routine.ko";
import { isSilentAnswer, SILENT_MARKERS } from "../src/routines/deliver";

/**
 * A routine that has nothing to say, and how the server tells that apart from a report.
 *
 * The marker is a contract between two files: the routine prompt asks for it, and the delivery
 * honours it. A prompt that asks for a word the matcher does not know — or a matcher that treats a
 * word inside a sentence as the marker — is a morning briefing that either never goes quiet or
 * goes quiet on the day it had something to say.
 */
describe("what a silent routine answers", () => {
  test("the routine prompt asks for the marker the matcher looks for", () => {
    expect(ROUTINE_KO).toContain("[SILENT]");
    expect(SILENT_MARKERS).toContain("[SILENT]");
  });

  test("a conversation is never told to go silent", () => {
    // A person at the screen who asked a question is owed an answer, however short.
    expect(CHAT_KO).not.toContain("[SILENT]");
  });

  test("the whole answer being the marker is silence", () => {
    expect(isSilentAnswer("[SILENT]")).toBe(true);
    expect(isSilentAnswer("  [SILENT]\n")).toBe(true);
    expect(isSilentAnswer("SILENT")).toBe(true);
    expect(isSilentAnswer("silent")).toBe(true);
    expect(isSilentAnswer("조용히")).toBe(true);
    expect(isSilentAnswer("[조용히]")).toBe(true);
  });

  test("a marker a model dressed up is still the marker", () => {
    expect(isSilentAnswer("**[SILENT]**")).toBe(true);
    expect(isSilentAnswer("`[SILENT]`")).toBe(true);
    expect(isSilentAnswer("[SILENT].")).toBe(true);
    expect(isSilentAnswer("조용히.")).toBe(true);
  });

  test("the marker on the first or the last line is silence", () => {
    expect(isSilentAnswer("[SILENT]\n\n새 주문은 없었다.")).toBe(true);
    expect(
      isSilentAnswer("주문 페이지를 확인했다. 새 주문 없음.\n\n[SILENT]"),
    ).toBe(true);
  });

  test("a marker inside a sentence is a report", () => {
    expect(isSilentAnswer("오늘은 [SILENT] 규칙을 쓰지 않았다.")).toBe(false);
    expect(isSilentAnswer("[SILENT] 새 주문 없음")).toBe(false);
    expect(isSilentAnswer("새 주문 2건: 김민수, 박지영")).toBe(false);
    expect(isSilentAnswer("조용히 처리했다.")).toBe(false);
  });

  test("nothing at all is not silence", () => {
    // An empty answer is a run that said nothing, which the service already declines to deliver
    // and which must not be recorded as a Bot that chose to keep quiet.
    expect(isSilentAnswer("")).toBe(false);
    expect(isSilentAnswer("   \n  ")).toBe(false);
  });
});
