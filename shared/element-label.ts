/**
 * A control's accessible name, as a person can read it.
 *
 * MEASURED 2026-09-25 (UX review 0.5.4, finding 5): the money card read "toss.im에서 ‘앱 다 운 로 드
 * 앱 다 운 로 드’를 누르려 합니다". toss.im draws that button's words one letter per element, for an
 * animation, and says them twice — once for sighted readers and once for screen readers — so the
 * accessibility tree joins them into a letter-spaced name, repeated. The card printed it raw, on
 * the one card where the owner must understand exactly what is being pressed.
 *
 * This is for what a person or the model READS. The name the boundary judges and the fingerprint is
 * taken over stay the raw one (`server/src/computer/gateway`): cleaning what is compared would let
 * two different controls hash the same.
 */

/** Characters that take up no room and say nothing, which pages use to break up words. */
const INVISIBLE = /[­​-‏⁠﻿]/g;

/**
 * How many one-letter words in a row read as letter-spacing rather than language.
 *
 * Three, because two happen in ordinary Korean and English — "이 글 저장", "A or B" — and a run of
 * three single letters in a button's name has only ever been an animation's spans.
 */
const SPACED_RUN = 3;

/** One grapheme's worth of text: a Hangul syllable, a letter, a digit. */
function isOneLetter(word: string): boolean {
  return [...word].length === 1 && /[\p{L}\p{N}]/u.test(word);
}

/** One stretch of words, with any run of letter-spaced ones joined back into a word. */
function joinSpacedLetters(words: string[]): string[] {
  const joined: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= SPACED_RUN) joined.push(run.join(""));
    else joined.push(...run);
    run = [];
  };
  for (const word of words) {
    if (isOneLetter(word)) {
      run.push(word);
      continue;
    }
    flush();
    joined.push(word);
  }
  flush();
  return joined;
}

/** The first half of a list that says the same thing twice, or the list itself. */
function onceOf<T>(items: T[], same: (a: T, b: T) => boolean): T[] {
  if (items.length < 2 || items.length % 2 !== 0) return items;
  const half = items.length / 2;
  for (let index = 0; index < half; index += 1) {
    const first = items[index];
    const second = items[index + half];
    if (first === undefined || second === undefined || !same(first, second)) {
      return items;
    }
  }
  return items.slice(0, half);
}

/** The text said once, when it is the same text twice with or without a space between. */
function sayOnce(text: string): string {
  const words = text.split(" ");
  const byWord = onceOf(words, (a, b) => a === b).join(" ");
  if (byWord !== text) return byWord;
  // Joined with no space at all only when each half is a word of its own: "2020" is a year and
  // "하하" is a laugh, and neither is a label said twice.
  const letters = [...text];
  const half = onceOf(letters, (a, b) => a === b);
  // And only when the half is a word rather than one letter over and over: "가가가가" is not a
  // label said twice, and halving it would hide what the page actually says.
  return new Set(half).size >= 2 && /\p{L}/u.test(half.join(""))
    ? half.join("")
    : text;
}

/**
 * The name, with letter-spacing closed up and a repeated half dropped. Never shortened.
 *
 * Two or more spaces are read as the gap between words, so "B u y  n o w" comes back "Buy now"
 * rather than "Buynow"; a single space between single letters is the letter-spacing itself. What
 * cannot be told apart is not guessed at: "앱 다 운 로 드" becomes "앱다운로드", because nothing
 * in the name says where its one real space was.
 */
export function readableName(name: string): string {
  const cleaned = name.replace(INVISIBLE, "");
  const stretches = cleaned
    .split(/\s{2,}/)
    .map((stretch) => stretch.trim())
    .filter(Boolean)
    .map((stretch) => joinSpacedLetters(stretch.split(/\s+/)).join(" "));
  // The repeat is looked for across the stretches as well as inside each: a label said twice is
  // often said twice with a wider gap between the two sayings than inside either.
  const once = onceOf(stretches, (a, b) => a === b).map(sayOnce);
  return sayOnce(once.join(" "));
}

/** How much of a name a card quotes, in characters as a person counts them. */
export const LABEL_CHARS = 24;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The name as a card quotes it: readable, and cut to {@link LABEL_CHARS} with an ellipsis that says
 * it was cut. Whole graphemes only, so a cut never leaves half a character.
 */
export function readableLabel(name: string, limit = LABEL_CHARS): string {
  const readable = readableName(name);
  const parts = [...graphemes.segment(readable)].map((part) => part.segment);
  if (parts.length <= limit) return readable;
  return `${parts
    .slice(0, limit - 1)
    .join("")
    .trimEnd()}…`;
}
