/**
 * Korea Standard Time, as arithmetic.
 *
 * A FIXED OFFSET rather than `Intl`, because KST has no daylight saving and the alternative is a
 * formatter whose output depends on the ICU data the runtime was built with.
 *
 * ONE PLACE, because it had become four. The offset was written out in the 나라장터 transport, in
 * each of the two weather files and again inline where the search cap counts its day; the minute
 * and the hour twice; and the two weather files each carried the same lines for finding an
 * issuance, with different numbers in them. A copy typechecks perfectly, so
 * `plugin-one-shape.test.ts` holds the offset to this file.
 */

/** The units the vendors' schedules and rests are written in. */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** KST has no daylight saving; a fixed offset needs no ICU data. */
export const KST_OFFSET_MS = 9 * HOUR;

/** `YYYYMMDDHHmm` in Korea Standard Time, which is what 나라장터 compares against. */
export function kstStamp(at: Date, time?: "0000" | "2359"): string {
  const shifted = new Date(at.getTime() + KST_OFFSET_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}`;
  return `${day}${time ?? `${pad(shifted.getUTCHours())}${pad(shifted.getUTCMinutes())}`}`;
}

/**
 * When something is issued, on Korea's clock: `every` so often, the day's first at `first` past
 * midnight, and asked for from `delay` after its clock time. All three in milliseconds.
 */
export type KstSchedule = { every: number; first: number; delay: number };

/**
 * The newest issuance on a schedule that should be answering at `at`, or the one `back` before it:
 * its date (`YYYYMMDD`) and hour (`HH`) in KST, and the instant the one after it is due to answer.
 *
 * Worked in KST as plain milliseconds: the clock is shifted nine hours and read through the UTC
 * getters, so midnight, the end of a month and the end of a year are the calendar's business and
 * not this function's. 00:05 on 1 January asks for 23:00 on 31 December.
 */
export function kstIssuanceAt(
  { every, first, delay }: KstSchedule,
  at: Date,
  back = 0,
): { date: string; hour: string; supersededAt: number } {
  const wall = at.getTime() + KST_OFFSET_MS - delay;
  const base =
    Math.floor((wall - first) / every) * every + first - back * every;
  // `base` is KST wall clock held as if it were UTC, so the ISO text is the Korean date and hour.
  const text = new Date(base).toISOString();
  return {
    date: `${text.slice(0, 4)}${text.slice(5, 7)}${text.slice(8, 10)}`,
    hour: text.slice(11, 13),
    supersededAt: base + every + delay - KST_OFFSET_MS,
  };
}
