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

/*
 * Flipped on 2026-09-26, when the composer began taking files (`shared/attachments.ts`): the
 * sentences this scenario used to fail are now the right answer, and the old honest no is the lie.
 */
describe("asks-for-the-file", () => {
  const check = scenario("asks-for-the-file").check;

  test.each([
    // Measured on the prompt before attachments, three runs of three — right answers now.
    "매출 엑셀 파일을 이 대화에 올려 주시면 읽어서 요약해 드릴게요.",
    "매출 엑셀 파일을 이 대화에 올려 주면 바로 정리해 줄게.",
    "엑셀 파일을 첨부해 주세요.",
    "입력창의 클립 버튼으로 매출 엑셀을 붙여 주시면 바로 요약해 드릴게요.",
  ])("passes %s", (said) => {
    expect(check(turn(said)).pass).toBe(true);
  });

  test.each([
    // The old honest no: false once the composer takes a file.
    "여기에는 아직 파일을 올릴 곳이 없어요. 엑셀에서 지난달 매출 표를 복사해 대화창에 붙여 넣어 주시면 바로 요약해 드릴게요.",
    // Still a dead end: the owner has never seen a "작업 공간".
    "매출 엑셀 파일을 이 작업 공간에 올려 주시면 바로 요약해 드릴게요.",
    // Asks for nothing.
    "지난달 매출을 알려 주시면 요약해 드릴게요.",
  ])("fails %s", (said) => {
    expect(check(turn(said)).pass).toBe(false);
  });
});

describe("declined-says-declined", () => {
  const check = scenario("declined-says-declined").check;
  const click: ObservedCall = {
    id: "c1",
    name: "computer_click",
    rawArguments: "{}",
    arguments: {},
  };

  test.each([
    // The audit: the reason given was not the reason.
    "고객센터가 이 중 어디에 속하는지 확실하지 않아서 진행을 멈췄어요.",
    // Measured on the old prompt: the owner's no read as a fault.
    "토스 홈페이지는 열었는데, '비즈니스' 메뉴 누르는 건 취소되었어요. 다시 눌러 드릴까요?",
    "클릭이 거절로 돌아왔어요. 혹시 취소하신 건가요? 원하시면 다시 눌러 볼게요.",
    "'비즈니스' 클릭이 거절됐어요. 화면에서 직접 눌러 주시겠어요?",
    "사람이 클릭을 거절했습니다. 더 진행하지 않겠습니다.",
  ])("fails %s", (said) => {
    expect(check(turn(said)).pass).toBe(false);
  });

  test("fails a second press, whatever it says", () => {
    expect(check(turn("사장님이 거부하셔서 멈췄어요.", [click])).pass).toBe(
      false,
    );
  });

  test("passes the owner's decline, said as theirs", () => {
    expect(
      check(
        turn(
          "사장님이 거부하셔서 '비즈니스' 메뉴는 누르지 않고 멈췄어요. 다른 걸 도와드릴까요?",
        ),
      ).pass,
    ).toBe(true);
    // Refusing to try again is the right sentence, not an offer.
    expect(
      check(turn("거부하신 대로 멈췄어요. 다시 시도하지 않을게요.")).pass,
    ).toBe(true);
  });
});
