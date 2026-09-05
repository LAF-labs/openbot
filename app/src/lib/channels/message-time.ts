import { activeLocale, t } from "@/lib/i18n";

/**
 * When a transcript earns a time separator, and what it says.
 *
 * Two rules, both about whether the reader has lost the thread of time: the calendar day changed,
 * or long enough passed that the next message is a new sitting rather than the same one. Grok's
 * transcript draws one line — "오늘 오후 1:45" — above a run, not a timestamp on every bubble, and
 * that is the difference between a conversation and a log file.
 */
const NEW_SITTING_MS = 60 * 60 * 1000;

const startOfDay = (at: Date) =>
  new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/** Whether `at` opens a new stretch of conversation, given the last message that carried a time. */
export function startsNewSitting(at: Date, previous: Date | null): boolean {
  if (previous === null) return true;
  if (startOfDay(at) !== startOfDay(previous)) return true;
  return at.getTime() - previous.getTime() >= NEW_SITTING_MS;
}

/**
 * The separator's words: which day, then the clock.
 *
 * The day half is relative for the two days a person thinks of by name and absolute after that,
 * because "Tuesday" stops being an answer once there has been more than one of them.
 *
 * Both halves come from `toLocale*` given `activeLocale` — the language the app is drawing in, not
 * the browser's. They were passed `undefined` and so read the browser's own setting: somebody who
 * chose 한국어 in Settings on an English-language machine got "오늘 3:45 PM", one separator in two
 * languages, and nothing in the app could tell them why.
 */
export function sittingLabel(at: Date, now: Date = new Date()): string {
  const time = at.toLocaleTimeString(activeLocale, {
    hour: "numeric",
    minute: "2-digit",
  });
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);

  if (days <= 0) return t("Today {time}", { time });
  if (days === 1) return t("Yesterday {time}", { time });
  if (days < 7) {
    return `${at.toLocaleDateString(activeLocale, { weekday: "long" })} ${time}`;
  }
  return `${at.toLocaleDateString(activeLocale, {
    month: "long",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  })} ${time}`;
}
