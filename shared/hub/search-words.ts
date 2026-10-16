/**
 * How the hub reads a search: the words, and the forms of each that count as finding it. Here and
 * not in the hub alone, so the VM that shows a hit can mark the same words the hub matched.
 *
 * KOREAN IS SEARCHED BY SUBSTRING (`server/drizzle/0065_message_search.sql` says why): "대한민국"
 * is found inside "대한민국은" without any morphology. What a substring search cannot do is the
 * other direction — "정산은" typed by a person is not inside a document that only says "정산".
 * So a particle at the end of a word of three characters or more is taken off, and the word is
 * found when EITHER form is in the text. Both forms, because the end can be part of the word
 * itself ("고양이" is not "고양" + 이), and searching both only ever finds more.
 */

/** Longest first, so "에서" comes off whole rather than as "에" plus a stray "서". */
const PARTICLES = [
  "에서",
  "으로",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "의",
  "에",
  "로",
  "와",
  "과",
  "도",
  "만",
  "께",
] as const;

export const HUB_QUERY_MAX_CHARS = 200;
/** More words than this are not a search; each is another condition on the index. */
export const HUB_QUERY_MAX_WORDS = 8;

export type HubSearchWord = {
  /** As typed (NFC). */
  word: string;
  /** What finds it: the word, then the word without its particle when it has one. */
  forms: string[];
};

/** Characters as Postgres counts them (`char_length`): code points, not UTF-16 halves. */
export const charLength = (text: string): number => [...text].length;

export function wordForms(word: string): string[] {
  const chars = charLength(word);
  if (chars < 3) return [word];
  for (const particle of PARTICLES) {
    if (!word.endsWith(particle)) continue;
    const stem = word.slice(0, word.length - particle.length);
    // "에서" off "회의에서" leaves "회의"; off "에서" itself it would leave nothing.
    if (charLength(stem) >= 2) return [word, stem];
    return [word];
  }
  return [word];
}

/** The words of a query, or null when what was sent is not one (empty, too long, too many). */
export function searchWords(typed: unknown): HubSearchWord[] | null {
  if (typeof typed !== "string") return null;
  const query = typed.normalize("NFC").trim();
  if (query.length === 0 || charLength(query) > HUB_QUERY_MAX_CHARS) {
    return null;
  }
  const words = [...new Set(query.split(/\s+/u))];
  if (words.length > HUB_QUERY_MAX_WORDS) return null;
  return words.map((word) => ({ word, forms: wordForms(word) }));
}
