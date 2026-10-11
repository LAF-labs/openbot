import { activeLocale } from "@/lib/i18n";

/**
 * When something was made, in a list: the date and the minute — 10월 6일 오후 5:05, October 6 at
 * 5:05 PM. Nothing for a time that is not one.
 *
 * ONE FORM, AND IT WAS WRITTEN TWICE: 만든 것 (`routes/…/made.tsx`) and a 소식 post
 * (`components/feed/feed-post-card.tsx`) each spelled the same `toLocaleString` call, so a change
 * to one was a change the other silently did not get. 홈's cards say less (`home/cards.ts`
 * `cardWhen`: the minute if today, the date if not), and a routine's row says the day by name
 * (`routines/queries.ts` `whenLabel`): those are different sentences, not copies of this one.
 */
export function dayAndMinute(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(activeLocale, {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
