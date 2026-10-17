/**
 * WHERE A BLOCK SITS: a string, ordered character by character, so a block goes between two others
 * by taking a string between theirs and nothing else is rewritten.
 *
 * Fractional ranks rather than numbers with gaps: an insert or a move writes one row, where gaps
 * run out and renumber a stretch of the document every few inserts at the same place — and
 * renumbering is a write to every block it touches, each an event to every member's VM.
 *
 * A rank reads as a fraction in base 36: "i" is 0.5, "i8" a little more. Only `0-9a-z`, so byte
 * order, JavaScript's `<` and Postgres's `collate "C"` all agree; and never a trailing "0", so there
 * is always room below a rank (between "a" and "a0" there would be none).
 *
 * The price is length. Inserting again and again at one place adds a character every five inserts
 * or so; past `RANK_MAX_CHARS` the document is renumbered evenly (`evenRanks`) in the same write,
 * which is rare enough to cost nothing and keeps every rank short.
 */

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

/** Past this length a document's ranks are spread again. */
export const RANK_MAX_CHARS = 48;

const digit = (character: string | undefined): number =>
  character === undefined ? 0 : DIGITS.indexOf(character);

/** A rank strictly between `a` ("" is the start) and `b` (null is the end); requires a < b. */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let shared = 0;
    while ((a[shared] ?? "0") === b[shared]) shared += 1;
    if (shared > 0) {
      return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
    }
  }
  const low = digit(a[0]);
  const high = b === null ? BASE : digit(b[0]);
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)] as string;
  // Adjacent first digits. When `b` goes on, its first digit alone is above `a` and below `b`.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return (DIGITS[low] as string) + midpoint(a.slice(1), null);
}

const VALID = /^[0-9a-z]*[1-9a-z]$/;

export const isRank = (value: string): boolean => VALID.test(value);

/** A rank after `before` and before `after`; either may be null (the start, the end). */
export function rankBetween(
  before: string | null,
  after: string | null,
): string {
  if (before !== null && after !== null && !(before < after)) {
    throw new Error(`ranks out of order: ${before} !< ${after}`);
  }
  return midpoint(before ?? "", after);
}

/**
 * `count` ranks spread evenly, all as short as `count` allows: for 5,000 blocks, three or four
 * characters each.
 */
export function evenRanks(count: number): string[] {
  let width = 1;
  while (BASE ** width <= count * 2) width += 1;
  const span = BASE ** width;
  const ranks: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const value = Math.floor((index * span) / (count + 1));
    ranks.push(value.toString(BASE).padStart(width, "0").replace(/0+$/, ""));
  }
  return ranks;
}
