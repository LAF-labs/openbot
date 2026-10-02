/**
 * TEXT THAT CAN BE STORED AND SENT: no half of a character, and no NUL.
 *
 * JavaScript counts a string in UTF-16 units, and every emoji is two of them. `slice` at a fixed
 * length can leave the first half standing alone, and a vendor's JSON may carry one as it is. Half
 * a character is not a character, and two things this product depends on refuse it outright —
 * measured 2026-10-02:
 *
 *   - Postgres will not put it in a `jsonb` column: `select '{"m":"\ud83d"}'::jsonb` answers
 *     "Unicode low surrogate must follow a high surrogate". A conversation's messages are `jsonb`,
 *     written a turn at a time, so one such string and none of the turn's rows are kept.
 *   - The Bots' own model answers a request holding one with HTTP 400, "unexpected end of hex
 *     escape" (meta/muse-spark-1.3-contributor through OpenRouter; another model on the same key
 *     took it). The string is in the conversation by then, so every request after it is refused too.
 *
 * A NUL is the other character Postgres refuses in `jsonb` ("\u0000 cannot be converted to text"),
 * and a file that is not text read as text is full of them.
 *
 * Found by reading what upstream OpenBot had fixed since this fork left it (#525, #539, #578):
 * upstream's concern was a model reading a broken character; here it is a turn that fails and is
 * then lost. So besides cutting between characters, the two doors — what is written to `jsonb`
 * (`server/src/db/schema/json.ts`) and what is sent to a model — make text sound whatever it came
 * from.
 */

const NUL = "\u0000";
/** What stands where something was not a character: the mark Unicode gives for exactly that. */
const NOT_A_CHARACTER = "�";

/** `text` with each half-character and each NUL replaced; the same string when it had neither. */
export function soundText(text: string): string {
  const whole = text.isWellFormed() ? text : text.toWellFormed();
  return whole.includes(NUL) ? whole.replaceAll(NUL, NOT_A_CHARACTER) : whole;
}

/**
 * A JSON value with every string in it sound, keys included — the value itself when nothing in it
 * needed mending, which is nearly always, so the walk costs a look and no copy.
 *
 * Plain objects and arrays only: anything else — a `Date` — is left for whoever serialises it.
 */
export function soundValue(value: unknown): unknown {
  if (typeof value === "string") return soundText(value);
  if (Array.isArray(value)) {
    let mended = false;
    const items = value.map((item) => {
      const kept = soundValue(item);
      if (kept !== item) mended = true;
      return kept;
    });
    return mended ? items : value;
  }
  if (!isPlainObject(value)) return value;
  let mended = false;
  const entries = Object.entries(value).map(([key, item]) => {
    const name = soundText(key);
    const kept = soundValue(item);
    if (name !== key || kept !== item) mended = true;
    return [name, kept] as const;
  });
  return mended ? Object.fromEntries(entries) : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const isHighHalf = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowHalf = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * The first `limit` units of `text`, one fewer when the cut would fall inside a character.
 *
 * The orphan is dropped rather than completed, so the result never exceeds the limit it was asked
 * for. Text that fits, and a cut that lands between characters, come back as `slice` gives them.
 * (Upstream OpenBot's `cutAtCodeUnits`, #525.)
 */
export function cutAtCodeUnits(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  return cut.length < text.length && isHighHalf(cut.charCodeAt(cut.length - 1))
    ? cut.slice(0, -1)
    : cut;
}

/**
 * `text` from `start` up to `end`, on characters at both edges: a part read out of a longer text
 * by position, where the reader's next part begins at this one's end.
 *
 * An end inside a character stops before it, as {@link cutAtCodeUnits} does. A start inside one
 * steps back to take it whole — which is the character the part before left out — so that parts
 * read one after another by their arithmetic hold every character once.
 */
export function sliceOnCharacters(
  text: string,
  start: number,
  end: number,
): string {
  const from =
    start > 0 &&
    start < text.length &&
    isLowHalf(text.charCodeAt(start)) &&
    isHighHalf(text.charCodeAt(start - 1))
      ? start - 1
      : start;
  const until =
    end > from &&
    end < text.length &&
    isHighHalf(text.charCodeAt(end - 1)) &&
    isLowHalf(text.charCodeAt(end))
      ? end - 1
      : end;
  return text.slice(from, until);
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * As much of the start of `text` as fits in `limit` code points, in whole characters AS A PERSON
 * SEES THEM: a flag is two code points, a family five or seven, a face with a skin tone two.
 *
 * For a line somebody reads — a roster's preview, a notification, a name. A cut by code points
 * leaves every string well formed and still ends a line on half a flag (`🇰` of 🇰🇷), or turns a
 * family into its first member. Counted in code points all the same, because that is what the
 * limits were set in and one "character" can be made as long as anybody likes with combining marks.
 * (Upstream OpenBot #455.)
 */
export function cutOnGraphemes(text: string, limit: number): string {
  let kept = "";
  let points = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    const size = Array.from(segment).length;
    if (points + size > limit) break;
    kept += segment;
    points += size;
  }
  return kept;
}
