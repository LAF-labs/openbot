import { describe, expect, test } from "bun:test";
import { BASE_KO, TOOL_RESULT_KO } from "../shared/prompt";

/**
 * THE BOT'S WORDS TO A SHOP OWNER — what the prompt says about them.
 *
 * The 0.5.3 audit read these off a real conversation on the deployment's model: "스냅샷을 다시 찍어
 * 그 버튼의 ref로 누를게요", "1,187ms 후 검색 결과 페이지로 되돌아왔네요", "사람에게 물어볼게요",
 * "매출 엑셀 파일을 작업 공간에 올려 두면", and after the owner pressed 거부, "확실하지 않아서
 * 진행을 멈췄어요". Whether the model now obeys is measured by `bun run eval:model` (the
 * `owner-words` scenarios); this is the cheap half — that the words it is told are the right ones,
 * and that nobody quietly takes them out again.
 */

describe("the base prompt", () => {
  test("names the machine words it must not repeat, not only 'no jargon'", () => {
    for (const word of ["ref", "스냅샷", "요소", "ms", "작업 공간", "배포"]) {
      expect(BASE_KO).toContain(word);
    }
    // And says what to say instead, because a ban with no replacement is a guess.
    expect(BASE_KO).toContain("화면을 다시 볼게요");
    /*
     * And what is NOT a machine word. "주소의 경로나 상품 번호" alone made the eval's order check
     * drop the order numbers themselves; the owner's own data on the page is passed on as it is.
     */
    expect(BASE_KO).toContain("웹 주소의 경로나 그 안의 번호");
    expect(BASE_KO).toContain(
      "주문번호·금액·날짜처럼 페이지에 적힌 내용은 그대로 전한다",
    );
  });

  test("calls the person 사장님, in 해요체, and says the tools' 사람 is them", () => {
    expect(BASE_KO).toContain("'사장님'이라고 부르고 해요체로");
    expect(BASE_KO).toContain("'사람'이 바로 사장님이다");
  });
});

describe("the tool results", () => {
  test("never call the person they are talking to 사람에게", () => {
    const thirdPerson = Object.entries(TOOL_RESULT_KO).filter(([, sentence]) =>
      sentence.includes("사람에게"),
    );
    expect(thirdPerson).toEqual([]);
  });

  test("where 사람 is left, it is somebody else", () => {
    // A mail's recipient, somebody else's skill, a server that answers per person — not the owner.
    const allowed =
      /받는 사람|다른 사람|묻는 사람|사람마다|사람을 돌려보낼|이 사람에 대해/;
    const leftover = Object.entries(TOOL_RESULT_KO).filter(
      ([, sentence]) =>
        sentence.includes("사람") &&
        !allowed.test(sentence.replace(/사장님/g, "")),
    );
    expect(leftover).toEqual([]);
  });
});
