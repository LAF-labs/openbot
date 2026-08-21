import { t } from "@/lib/i18n";

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
 * because "Tuesday" stops being an answer once there has been more than one of them. Both halves
 * come from `toLocale*`, so a Korean browser reads 오후 and an English one reads PM without this
 * module knowing which language it is in.
 */
export function sittingLabel(at: Date, now: Date = new Date()): string {
  const time = at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);

  if (days <= 0) return t("Today {time}", { time });
  if (days === 1) return t("Yesterday {time}", { time });
  if (days < 7) {
    return `${at.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  }
  return `${at.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  })} ${time}`;
}
