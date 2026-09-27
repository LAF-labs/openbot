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

  /*
   * The 호칭 left the static layer on 2026-09-27: 학생 and 직장인 use this too, and what differs per
   * person cannot stand in a layer that is byte-identical across deployments. The context layer's
   * "호칭:" line says it (`shared/prompt/shop.ko.ts` `aboutText`); this line points there.
   */
  test("calls the person by the context layer's 호칭, in 해요체, and says the tools' 이 사람 and 사장님 are them", () => {
    expect(BASE_KO).toContain("'호칭:' 줄대로 부르고 해요체로");
    expect(BASE_KO).toContain(
      "'이 사람'·'사람'·'사장님'은 모두 지금 말하는 상대를 가리키는 말",
    );
    expect(BASE_KO).not.toContain("'사장님'이라고 부르고");
  });

  /*
   * THE WORD SWEEP (muse-shape plan §5.4, phase 4). Models copy words: a student whose Bot is told
   * "사장님이 거부하셔서라고 말해라" hears 사장님이 거부하셔서. The one sentence left naming 사장님 is
   * the one saying that the word, where it survives in a tool's description, means this person.
   */
  test("never calls the person 사장님 except to say what the word means", () => {
    const naming = BASE_KO.split("\n").filter((line) =>
      line.includes("사장님"),
    );
    expect(naming).toHaveLength(1);
    expect(naming[0]).toContain("'호칭:' 줄대로");
  });

  test("says what the composer takes, and that the Bot may ask for it", () => {
    // The rule that forbade asking is gone with the dead end it guarded (0.5.3 audit item 7).
    expect(BASE_KO).not.toContain("파일을 올려 달라고 하거나");
    expect(BASE_KO).toContain("사진(영수증·메뉴판 같은 것), 엑셀·CSV, PDF");
    expect(BASE_KO).toContain("한 번에 5개, 파일 하나에 10MB까지");
    expect(BASE_KO).toContain("파일을 붙여 달라고 하거나");
  });
});

describe("the tool results", () => {
  test("never call the person they are talking to 사람에게", () => {
    const thirdPerson = Object.entries(TOOL_RESULT_KO).filter(([, sentence]) =>
      sentence.includes("사람에게"),
    );
    expect(thirdPerson).toEqual([]);
  });

  test("where 사람 is left, it is this person or somebody else", () => {
    // A mail's recipient, somebody else's skill, a server that answers per person — or "이 사람",
    // the one word left for the person being talked to, where a fact needs a subject.
    const allowed = /받는 사람|다른 사람|묻는 사람|사람마다|사람을 돌려보낼/;
    const leftover = Object.entries(TOOL_RESULT_KO).filter(([, sentence]) => {
      const rest = sentence.replace(/이 사람/g, "");
      return rest.includes("사람") && !allowed.test(rest);
    });
    expect(leftover).toEqual([]);
  });

  test("never say 사장님: a student reads them too", () => {
    const owner = Object.entries(TOOL_RESULT_KO).filter(([, sentence]) =>
      sentence.includes("사장님"),
    );
    expect(owner).toEqual([]);
  });

  test("a decline is said as the person's own decline, with nobody named, and not offered again", () => {
    const declined = TOOL_RESULT_KO["laf:person_declined"] ?? "";
    expect(declined).toContain("이 사람이 승인 카드에서 이 행동을 거부했다");
    // What the Bot is told to say carries no noun to copy: "거부하셔서", not "이 사람이 거부하셔서".
    expect(declined).toContain("멈춘 까닭은 거부하셔서라고");
    expect(declined).toContain("다시 하거나");
    const recently = TOOL_RESULT_KO["laf:declined_recently"] ?? "";
    expect(recently).toContain("거부하셔서 막혔다고");
    expect(recently).not.toContain("이 사람이 거부하셔서");
  });
});
