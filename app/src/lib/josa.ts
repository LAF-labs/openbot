/**
 * THE PARTICLE THAT AGREES WITH THE NAME IN FRONT OF IT.
 *
 * Korean picks between 을/를, 은/는, 이/가 and 와/과 by whether the preceding syllable ends in a
 * consonant. A dictionary entry cannot: the name is substituted in at render time, so the entry has
 * to be written for a word it has not seen. Every one of them was written the way a form letter
 * writes it — `'김비서'을(를) 삭제할까요?` — which is a sentence no person would say out loud, in
 * front of somebody about to delete something permanently.
 *
 * The particle is computed here and passed in as its own parameter, so the Korean entry reads
 * `'{name}'{josa} 삭제할까요?` and the English one simply has no `{josa}` in it and ignores the extra
 * parameter. That keeps this out of `t()` itself: `t` is a lookup and a substitution, and it has no
 * business knowing Korean grammar.
 *
 * PURE, AND NOT LOCALE-AWARE ON PURPOSE. The caller does not choose whether to append it — the
 * dictionary does, by whether its entry has a `{josa}` slot. So this can be tested without a browser,
 * a locale, or a rendered page.
 *
 * The particle goes OUTSIDE the quotes: `'김비서'를`, not `'김비서를'`. What is quoted is the name.
 */

/** The four pairs the surface actually says. Written the way they are read: 받침 form first. */
const PAIRS = {
  "은/는": ["은", "는"],
  "을/를": ["을", "를"],
  "이/가": ["이", "가"],
  "와/과": ["과", "와"],
} as const;

export type JosaPair = keyof typeof PAIRS;

/**
 * Whether a digit's Korean reading ends in a consonant: 영 일 이 삼 사 오 육 칠 팔 구.
 *
 * Worth the seven bytes because Bots and routines get named "3번 창고" and "7월 정산" constantly, and
 * "3을" versus "3를" is the difference between a sentence and a form field.
 */
const DIGIT_HAS_FINAL = [
  true, // 0 영
  true, // 1 일
  false, // 2 이
  true, // 3 삼
  false, // 4 사
  false, // 5 오
  true, // 6 육
  true, // 7 칠
  true, // 8 팔
  false, // 9 구
] as const;

/**
 * A Latin word ending in a vowel sound takes the vowel form.
 *
 * `y` is in here because it is read as ㅣ at the end of a word — Amy는, not Amy은. This is a rule of
 * thumb and it is meant to be: the alternative for a roster that can hold "Slack" and "Amy" is the
 * bracketed form, which is wrong for both of them rather than right for one.
 */
const LATIN_VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
/** Syllables per initial-consonant block; the remainder is the final consonant, 0 meaning none. */
const HANGUL_FINALS = 28;

/**
 * Does the last syllable of `word` end in a consonant?
 *
 * Unknown endings — punctuation, an emoji, a Chinese character — answer `true`, the 받침 form. One of
 * the two has to be the answer, and 을/은/이 after an unreadable token is the one that does not
 * change how the rest of the sentence is read.
 */
export function hasFinalConsonant(word: string): boolean {
  const last = [...word.trim()].at(-1);
  if (!last) return true;

  const code = last.codePointAt(0) ?? 0;
  if (code >= HANGUL_FIRST && code <= HANGUL_LAST) {
    return (code - HANGUL_FIRST) % HANGUL_FINALS !== 0;
  }
  if (last >= "0" && last <= "9") {
    return DIGIT_HAS_FINAL[Number(last)];
  }
  const lower = last.toLowerCase();
  if (lower >= "a" && lower <= "z") {
    return !LATIN_VOWELS.has(lower);
  }
  return true;
}

/**
 * The particle for `word`. Empty for an empty word, so a name that has not loaded yet reads as a
 * gap rather than as a stray 을.
 */
export function josa(word: string, pair: JosaPair): string {
  if (!word.trim()) return "";
  const [withFinal, withoutFinal] = PAIRS[pair];
  return hasFinalConsonant(word) ? withFinal : withoutFinal;
}
