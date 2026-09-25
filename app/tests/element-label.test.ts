import { describe, expect, test } from "bun:test";
import { readableLabel, readableName } from "@shared/element-label";
import { MONEY_WORD_RULE } from "@shared/policy-rules";
import {
  actionNounPhrase,
  describeSubject,
  whyAskedPhrase,
} from "../src/lib/approvals";

/**
 * THE MONEY CARD QUOTES A BUTTON AS A PERSON READS IT (UX review 0.5.4, candidate 5).
 *
 * Measured 2026-09-25: toss.im's download button reached the card as "앱 다 운 로 드 앱 다 운 로 드"
 * — one element per letter for an animation, said twice for sighted and screen readers — and the
 * card printed it raw. The labels below are real ones, from that walk and from the sites a shop
 * owner's Bot is sent to; the ones that must come back untouched matter as much as the ones fixed.
 */

describe("a control's name, made readable", () => {
  test("toss.im's letter-spaced, doubled download button reads as one word", () => {
    expect(readableName("앱 다 운 로 드 앱 다 운 로 드")).toBe("앱다운로드");
  });

  test("a name said twice is said once", () => {
    expect(readableName("장바구니 담기 장바구니 담기")).toBe("장바구니 담기");
    expect(readableName("쿠팡 쿠팡")).toBe("쿠팡");
    expect(readableName("로그인로그인")).toBe("로그인");
    expect(readableName("Toss 앱 다운로드  Toss 앱 다운로드")).toBe(
      "Toss 앱 다운로드",
    );
  });

  test("letter-spaced English keeps its word gaps", () => {
    expect(readableName("B u y  n o w")).toBe("Buy now");
  });

  test("ordinary names come back as they were", () => {
    for (const name of [
      "결제하기",
      "바로구매",
      "주문하기 (총 12,300원)",
      "이 글 저장",
      "A or B",
      "출금 승인",
      "2020",
      "하하",
    ]) {
      expect(readableName(name)).toBe(name);
    }
  });

  test("space and invisible characters are tidied", () => {
    expect(readableName("  결제​하기  ")).toBe("결제하기");
    expect(readableName("장바구니\n   담기")).toBe("장바구니 담기");
  });

  test("a card quotes at most 24 characters and says it cut", () => {
    const long =
      "지금 가입하고 첫 달 무료로 이용하기 - 쿠팡 와우 멤버십 혜택 보기";
    const quoted = readableLabel(long);
    expect([...quoted].length).toBeLessThanOrEqual(24);
    expect(quoted.endsWith("…")).toBe(true);
    expect(readableLabel("결제하기")).toBe("결제하기");
  });
});

describe("the card's sentence uses the readable name", () => {
  const spaced = {
    kind: "browser" as const,
    intent: "activate" as const,
    host: "toss.im",
    element: { role: "link", name: "앱 다 운 로 드 앱 다 운 로 드" },
    reason: "policy_ask" as const,
  };

  test("the question and the line it folds into", () => {
    const asked = describeSubject(spaced);
    expect(asked).toContain("앱다운로드");
    expect(asked).not.toContain("다 운");
    expect(actionNounPhrase(spaced).params.name).toBe("앱다운로드");
  });

  test("the money word is found in a letter-spaced label", () => {
    const why = whyAskedPhrase(MONEY_WORD_RULE, {
      ...spaced,
      element: { role: "button", name: "결 제 하 기" },
    });
    // The reason names the word it found, rather than the general sentence it falls back to.
    expect(why?.params.word).toBe("결제");
  });
});
