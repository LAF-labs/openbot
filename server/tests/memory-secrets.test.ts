import { describe, expect, test } from "bun:test";
import { looksLikeASecret } from "../src/agents/memory-store";

/**
 * A memory is not a place for a password, and the prompt saying so is not a boundary.
 *
 * `remember` writes a row that is prepended to EVERY turn this Bot ever takes again — every later
 * conversation, every room, every routine reads it. A password that got in there is not one leak,
 * it is a leak on a loop, and it is also a row on a screen a person can list. The tool description
 * says not to; this is what happens when the model does it anyway.
 *
 * The other half of the rule is the tool that exists so it never has to:
 * `computer_request_secret` puts the value straight into the page and the Bot never sees it.
 */

describe("what a Bot may not write down", () => {
  test("refuses a password it was handed", () => {
    expect(looksLikeASecret("사장님 비밀번호는 hunter2! 다")).toBe(true);
    expect(looksLikeASecret("네이버 비번 shop1234")).toBe(true);
    expect(looksLikeASecret("The wifi password is Sunflower99")).toBe(true);
    expect(looksLikeASecret("pwd: aB3!kk91")).toBe(true);
  });

  test("refuses a card, an account or a resident number by its shape alone", () => {
    // No label needed: twelve digits in a row is one of three things and none of them belongs here.
    expect(looksLikeASecret("4111 1111 1111 1111")).toBe(true);
    expect(looksLikeASecret("국민은행 123-456-789012 로 입금")).toBe(true);
    expect(looksLikeASecret("카드번호 5555-4444-3333-2222")).toBe(true);
  });

  test("refuses a one-time code that was read out to it", () => {
    expect(looksLikeASecret("인증번호는 918273 이야")).toBe(true);
    expect(looksLikeASecret("cvc 481")).toBe(true);
  });

  /**
   * THE FALSE POSITIVES THAT WOULD MAKE THIS USELESS.
   *
   * A shop owner talks about cards and passwords constantly — how they take payment, what they
   * will not do over the phone, which supplier insists on a bank transfer. Those are exactly the
   * facts a Bot is for. A filter that ate them would be turned off within a week, so it refuses a
   * SHAPE (a label with a value, or a long run of digits) rather than a subject.
   */
  test("lets an ordinary fact about payment through", () => {
    expect(looksLikeASecret("우리 가게는 카드 결제만 받는다.")).toBe(false);
    expect(looksLikeASecret("비밀번호는 절대 물어보지 않는다.")).toBe(false);
    expect(
      looksLikeASecret("사장님은 전화로 카드번호를 불러 주지 않으신다."),
    ).toBe(false);
    expect(looksLikeASecret("한일상사는 계좌 이체만 받는다.")).toBe(false);
    expect(looksLikeASecret("일요일은 쉰다.")).toBe(false);
    expect(looksLikeASecret("영업시간은 09:00부터 21:00까지다.")).toBe(false);
    expect(looksLikeASecret("사업자등록번호를 물어보면 알려 드린다.")).toBe(
      false,
    );
  });

  test("an empty fact is not a secret, it is nothing", () => {
    expect(looksLikeASecret("   ")).toBe(false);
    expect(looksLikeASecret("")).toBe(false);
  });

  /*
   * A rule about passwords is not a password, and the counter is what keeps it out.
   *
   * "비밀번호는 8자리 이상" has a secret word and a digit, and is refused only if the digit sits in
   * an ASCII run of three or more — which it does not, because the counter after it is Korean.
   * This is the seam the shape rule turns on, so it is pinned rather than left to luck.
   */
  test("a rule about passwords is not a password", () => {
    expect(
      looksLikeASecret("비밀번호는 8자리 이상으로 정하라고 안내한다."),
    ).toBe(false);
    expect(looksLikeASecret("비밀번호를 3개월마다 바꾼다.")).toBe(false);
  });
});
