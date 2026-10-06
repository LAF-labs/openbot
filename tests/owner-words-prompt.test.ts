import { describe, expect, test } from "bun:test";
import { BASE_KO } from "../shared/prompt";
import { TOOL_RESULT_KO } from "../shared/prompt/tool-results.ko";
import {
  PAUSED_TOOL_DESCRIPTION,
  withheldToolsText,
} from "../shared/tools/paused";

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

/*
 * THE ONE DESCRIPTION OF A TOOL THAT IS THIS DEPLOYMENT'S AND NOT ITS VENDOR'S (2026-10-06,
 * `shared/tools/paused.ts`). A tool whose definition changed after consent is offered to a model
 * under its name with these words in place of the vendor's, so that nothing unreviewed is read —
 * and the Bot saying them is how a person learns the tool is paused. So they are held as the
 * tool results are: a model copies the words it is given.
 */
describe("the description a tool waiting for review is offered under", () => {
  test("says the three facts in the words the person's own screen uses, and none a Bot would copy wrongly", () => {
    // Pinned whole: these bytes stand in for every vendor's description, so a change is a decision.
    expect(PAUSED_TOOL_DESCRIPTION).toBe(
      "이 툴은 정의가 바뀌어서 검토를 기다리는 중이다. 검토가 끝나기 전에는 불러도 거절되니 부르지 마라. " +
        "이 툴이 멈춰 있다고 알리고, 관리 메뉴의 플러그인 화면에서 바뀐 정의를 검토해 달라고 말해라.",
    );
    // What it is, that a call is refused, and where it is reviewed: 관리 → 플러그인.
    expect(PAUSED_TOOL_DESCRIPTION).toContain("정의가 바뀌어서");
    expect(PAUSED_TOOL_DESCRIPTION).toContain("거절");
    expect(PAUSED_TOOL_DESCRIPTION).toContain("관리 메뉴의 플러그인");
    // The same vocabulary as the sentence a refused call is answered with.
    expect(TOOL_RESULT_KO["laf:tool_needs_review"]).toContain("정의가");
    expect(TOOL_RESULT_KO["laf:tool_needs_review"]).toContain("검토");

    // Nobody is named: not 사람에게, not 이 사람, not 사장님 — a student's Bot reads this too.
    expect(PAUSED_TOOL_DESCRIPTION).not.toContain("사람");
    expect(PAUSED_TOOL_DESCRIPTION).not.toContain("사장님");
    expect(PAUSED_TOOL_DESCRIPTION).not.toContain("가게");
    // None of the machine words the base prompt tells a Bot not to repeat.
    for (const word of ["ref", "스냅샷", "요소", "작업 공간", "배포"]) {
      expect([word, PAUSED_TOOL_DESCRIPTION.includes(word)]).toEqual([
        word,
        false,
      ]);
    }
    // And no slot for anybody else's text: no brace, no quote, nothing interpolated.
    expect(PAUSED_TOOL_DESCRIPTION).not.toMatch(/[{}$`"'<>]/);
  });

  /*
   * THE OTHER HALF (the review of that change). A tool that appeared after registration is offered
   * under no name at all, so there is no description to stand in — and nothing told the Bot it
   * existed. A lookup now ends on this line: how many wait, by service, and where a person reviews
   * them. The one slot is the bridge's own list of services and counts (`withheldLines`,
   * `shared/tools/bridge.ts`); a tool's name and a vendor's word have no way into it.
   */
  test("and the line a lookup says of the tools offered under no name: how many, that looking or connecting again will not bring them, and where they are reviewed", () => {
    const line = withheldToolsText("카카오(kakao-playmcp) 2개");
    // Pinned whole, around the one slot: a change to what a Bot is told to say is a decision.
    expect(line).toBe(
      "다만 검토를 기다리고 있어 어느 목록에도 없는 도구: 카카오(kakao-playmcp) 2개. 다시 찾아도, 다시 연결해도 나오지 않는다 — " +
        "이 가운데 하나가 필요한 일이면 그 서비스의 도구가 검토를 기다리는 중이라고 알리고, 관리 메뉴의 플러그인 화면에서 검토해 달라고 말한다.",
    );
    // The same screen, in the same words, as the description above names it.
    expect(line).toContain("관리 메뉴의 플러그인 화면에서");
    expect(PAUSED_TOOL_DESCRIPTION).toContain("관리 메뉴의 플러그인 화면에서");
    // Around the slot it is the same sentence whatever is counted, and it names nobody.
    const around = withheldToolsText("");
    expect(withheldToolsText("acme-desk 1개")).toBe(
      line.replace("카카오(kakao-playmcp) 2개", "acme-desk 1개"),
    );
    expect(around).not.toContain("사람");
    expect(around).not.toContain("사장님");
    expect(around).not.toContain("가게");
    for (const word of ["ref", "스냅샷", "요소", "작업 공간", "배포"]) {
      expect([word, around.includes(word)]).toEqual([word, false]);
    }
    expect(around).not.toMatch(/[{}$`"'<>]/);
  });
});
