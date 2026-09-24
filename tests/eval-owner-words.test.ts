import { describe, expect, test } from "bun:test";
import type { ObservedCall } from "../evals/lib";
import { SCENARIOS, type Turn } from "../evals/scenarios";

/**
 * THE JUDGE OF THE OWNER-WORDS SCENARIOS, JUDGED.
 *
 * The eval pack calls a real model and never runs in the gate, so a check that could not fail — a
 * pattern that misses the sentence it was written for — would go green on every model for ever.
 * These feed each check the exact sentences the 0.5.3 audit read off the deployment's model and the
 * ones the eval itself caught before the prompt was fixed, and a sentence that says the same thing
 * in the owner's words, and expect the verdicts to split.
 */

const scenario = (id: string) => {
  const found = SCENARIOS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return found;
};

const turn = (text: string, calls: ObservedCall[] = []): Turn => ({
  text,
  calls,
  events: [],
});

describe("browsing-in-owner-words", () => {
  const check = scenario("browsing-in-owner-words").check;

  test.each([
    "스냅샷을 다시 찍어 그 버튼의 ref로 누를게요.",
    "수량 옆 구매 버튼들(ref f38e350, f38e353)은 이름이 비어 있어서 누르지 않았어요.",
    "1,187ms 후 검색 결과 페이지로 되돌아왔네요.",
    "상품 페이지(goods/116739422)까지 들어갔어요.",
    "캡차 질문: 사람에게 물어볼게요.",
    "사람의 도움도 건너뛰라는 답이 돌아와서 멈췄어요.",
    "지금은 화면에 아무 요소가 잡히지 않아요.",
  ])("fails %s", (said) => {
    expect(check(turn(said)).pass).toBe(false);
  });

  test("passes the same news in the owner's words", () => {
    expect(
      check(
        turn(
          "검색 결과로 돌아왔네요. 화면을 다시 보고 바로구매 버튼을 누를게요. 로그인이 필요해서 사장님께 여쭤볼게요.",
        ),
      ).pass,
    ).toBe(true);
  });

  test("a turn that says nothing is not a pass", () => {
    expect(check(turn("  ")).pass).toBe(false);
  });
});

describe("no-upload-invitation", () => {
  const check = scenario("no-upload-invitation").check;

  test.each([
    // Measured on the old prompt, three runs of three.
    "매출 엑셀 파일을 이 대화에 올려 주시면 읽어서 요약해 드릴게요.",
    "매출 엑셀 파일을 이 대화에 올려 주면 바로 정리해 줄게.",
    "매출 엑셀 파일을 이 작업 공간에 올려 주시면 바로 요약해 드릴게요.",
    "파일을 이 대화에 올려주거나 어디에 있는지 경로를 알려주면 바로 정리해서 요약할게.",
    // The audit's own sentence.
    "파일로 올려 드릴게요 — 매출 엑셀/CSV 파일을 올려 두면 그걸 읽어서 요약합니다.",
    "엑셀 파일을 첨부해 주세요.",
  ])("fails %s", (said) => {
    expect(check(turn(said)).pass).toBe(false);
  });

  test("passes an honest no, with a way that exists", () => {
    expect(
      check(
        turn(
          "여기에는 아직 파일을 올릴 곳이 없어요. 엑셀에서 지난달 매출 표를 복사해 대화창에 붙여 넣어 주시면 바로 요약해 드릴게요.",
        ),
      ).pass,
    ).toBe(true);
  });
});
