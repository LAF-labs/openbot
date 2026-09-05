import { describe, expect, test } from "bun:test";
import { hasFinalConsonant, josa } from "../src/lib/josa";

/**
 * The particle, and the sentence it was hiding inside.
 *
 * MEASURED, ON THE DELETE DIALOG: `'김비서'을(를) 삭제할까요?` — a bracketed particle in a modal that
 * asks somebody to destroy a Bot and everything it remembers. The form-letter spelling is what a
 * dictionary can produce without seeing the name; this is the test that says the name is now looked
 * at.
 */

describe("을/를", () => {
  test("a name ending in a 받침 takes 을", () => {
    // 서 is 0xC11C; (0xC11C - 0xAC00) % 28 === 0, so 김비서 has NO final consonant. 박주문 does.
    expect(josa("박주문", "을/를")).toBe("을");
    expect(josa("아침 주문 점검", "을/를")).toBe("을");
  });

  test("a name ending in a vowel takes 를", () => {
    expect(josa("김비서", "을/를")).toBe("를");
    expect(josa("최홍보", "을/를")).toBe("를");
  });

  test("the trailing space of a typed name does not decide it", () => {
    // A name field gives back what was typed, and " " has no final consonant of its own.
    expect(josa("박주문 ", "을/를")).toBe("을");
  });
});

describe("a Latin name", () => {
  test("ends in a vowel sound or it does not", () => {
    expect(josa("Amy", "을/를")).toBe("를");
    expect(josa("Sora", "을/를")).toBe("를");
    expect(josa("Slack", "을/를")).toBe("을");
    expect(josa("Gmail", "을/를")).toBe("을");
  });

  test("case is not a fact about pronunciation", () => {
    expect(josa("SLACK", "을/를")).toBe("을");
    expect(josa("AMY", "을/를")).toBe("를");
  });
});

describe("a name that ends in a digit", () => {
  test("takes the particle its Korean reading takes", () => {
    // 3번 창고 → 삼, which ends in ㅁ; 2번 창고 → 이, which does not.
    expect(josa("창고 3", "을/를")).toBe("을");
    expect(josa("창고 2", "을/를")).toBe("를");
    expect(josa("창고 5", "을/를")).toBe("를");
  });
});

describe("the other three pairs", () => {
  test("은/는, 이/가 and 와/과 agree with the same syllable", () => {
    expect(josa("박주문", "은/는")).toBe("은");
    expect(josa("김비서", "은/는")).toBe("는");
    expect(josa("박주문", "이/가")).toBe("이");
    expect(josa("김비서", "이/가")).toBe("가");
    // 와/과 is the one pair written vowel-form-second in speech and consonant-form-first here.
    expect(josa("박주문", "와/과")).toBe("과");
    expect(josa("김비서", "와/과")).toBe("와");
  });
});

describe("what it does with nothing", () => {
  test("an empty name gets no particle at all", () => {
    // A profile that has not loaded renders an empty name; a stray 을 hanging off nothing is worse
    // than the gap.
    expect(josa("", "을/를")).toBe("");
    expect(josa("   ", "을/를")).toBe("");
  });

  test("an unreadable ending answers rather than throwing", () => {
    // Emoji, punctuation, a Chinese character: one of the two forms has to come back.
    expect(hasFinalConsonant("정산 ✅")).toBe(true);
    expect(josa("정산 ✅", "을/를")).toBe("을");
  });
});
