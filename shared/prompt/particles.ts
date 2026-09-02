/**
 * 조사는 앞 글자의 받침이 정한다.
 *
 * 봇의 이름과 직함은 사람이 지은 값이라 프롬프트를 쓸 때는 알 수 없다. 고르지 않고 한쪽으로
 * 굳히면 절반은 틀린 한국어가 되고, 실제로 그랬다 — 돌고 있는 서버가 모델에게 보낸 첫 줄이
 * "너는 비서, 영수증·경비 보고 담당다"였다(와이어에서 읽음). 봇의 첫 문장이 어색한 한국어인
 * 것은 이 제품이 팔려는 것과 정확히 반대다.
 *
 * 자기 파일에 사는 이유: 모드 프롬프트도 쓰고 조립 함수도 쓰는데, 둘이 서로를 import하면
 * 순환이 된다.
 */

/**
 * 마지막 글자에 받침이 있는가.
 *
 * 한글이 아닌 마지막 글자(영어 이름, 숫자)는 받침이 있는 쪽으로 친다. "Expense Manager이다"는
 * 어색하지 않지만 "Expense Manager다"는 어색하다.
 */
function hasFinalConsonant(word: string): boolean {
  const last = word.trim().at(-1) ?? "";
  const code = last.codePointAt(0) ?? 0;
  const isHangulSyllable = code >= 0xac00 && code <= 0xd7a3;
  if (!isHangulSyllable) return true;
  return (code - 0xac00) % 28 !== 0;
}

/** "…이다" 또는 "…다". */
export function copula(word: string): string {
  return hasFinalConsonant(word) ? "이다" : "다";
}

/** "…으로" 또는 "…로". ㄹ 받침은 "로"를 쓴다. */
export function asRole(word: string): string {
  const last = word.trim().at(-1) ?? "";
  const code = last.codePointAt(0) ?? 0;
  const isHangulSyllable = code >= 0xac00 && code <= 0xd7a3;
  const rieul = isHangulSyllable && (code - 0xac00) % 28 === 8;
  return hasFinalConsonant(word) && !rieul ? "으로" : "로";
}
