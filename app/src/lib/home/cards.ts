import type { FeedPage } from "@shared/feed";
import type { GoalView } from "@shared/goals";
import { type GoalsAnswer, measureLine } from "@/lib/goals/queries";
import { activeLocale } from "@/lib/i18n";
import { kindLabel, type MadePage } from "@/lib/made/queries";

/**
 * 홈'S FIRST CARDS: 소식, 목표, 만든 것 — WHAT EACH SAYS, OR THAT IT SAYS NOTHING (2026-10-10, record
 * §1 and §2, piece 3-4).
 *
 * Under 오늘 the panel holds three things a person otherwise goes to a page for, each as the one
 * fact that page would have opened on: the newest thing the Bot found, the goal being worked on,
 * the last thing it made. A card is a name, one figure at its right, and ONE line. Its name is the
 * way to its page; its line is the way to the thing it names, where that has a place of its own
 * (`thing` — the idea is from #151, the other pull request written for this piece).
 *
 * A CARD WITH NOTHING TO SAY IS NOT DRAWN. The list these stand beside was taken out of the old
 * column for being too many words (2026-10-04), and three boxes saying "아직 없어요" on a first
 * day are that again. So each of these answers null until there is one fact to show, and a first
 * day's 홈 is 오늘 alone — which already offers the first things to hand over.
 *
 * NOTHING HERE MAY TAKE 오늘 WITH IT. The cards read three more answers than the panel did, inside
 * the same seam, and a card is a convenience where 오늘 is not: an answer that is not the shape
 * this expects is "nothing to say", never a throw. That is why these look before they read.
 *
 * WHAT A CARD DRAWS IS FACTS. The words around them — the card's name, "새 글 3개" for whoever
 * cannot see a mark — are the component's, through `t()`.
 */

export type HomeCardView = {
  /** The one line: the post's title, the goal's, the made thing's. The Bot's or the person's words. */
  line: string;
  /** A second, quieter line where there is a number being watched: "지금 720 · 목표 800점". */
  note: string | null;
  /** When the thing the line is about was made, for the card's right end. Null where a count stands there. */
  at: string | null;
  /** How many: unseen posts, goals in progress. Null where a time stands at the right instead. */
  count: number | null;
  /**
   * The thing the line names, where there is somewhere of its own to open it: that goal on 목표,
   * the message a made thing was handed over in. Null where the page is all there is (소식), and
   * where the answer did not say which — the card is then the way to its page and nothing else.
   */
  thing: HomeCardThing | null;
};

export type HomeCardThing =
  | { kind: "goal"; id: string }
  | { kind: "made"; channelId: string; messageId: string };

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const listOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

/**
 * 소식: the newest post's title — and, while any are unseen, how many. Reading this marks nothing
 * seen: seen is what 소식's own page showed (`routes/_authed/_app/feed.tsx`).
 */
export function feedCard(
  page: FeedPage | undefined,
  unseen: number | undefined,
): HomeCardView | null {
  const [newest] = listOf(record(page)?.posts);
  const line = text(record(newest)?.title);
  if (!line) return null;
  const count =
    typeof unseen === "number" && Number.isFinite(unseen) && unseen > 0
      ? Math.floor(unseen)
      : null;
  return {
    at: count === null ? text(record(newest)?.createdAt) || null : null,
    count,
    line,
    note: null,
    // A post has no place of its own: 소식's page is where it is read.
    thing: null,
  };
}

/**
 * 목표: the first goal in progress, in the server's order, with how many there are — and its number
 * where it has one. A goal that is done or put away is on its page, not here.
 */
export function goalsCard(
  answer: GoalsAnswer | undefined,
): HomeCardView | null {
  const active = listOf(record(answer)?.goals).filter(
    (goal) => record(goal)?.status === "active",
  );
  const [first] = active;
  const line = text(record(first)?.title);
  if (!line) return null;
  const id = text(record(first)?.id);
  return {
    at: null,
    count: active.length,
    line,
    note: measureLine(first as GoalView),
    thing: id ? { id, kind: "goal" } : null,
  };
}

/**
 * 만든 것: the newest thing's title, and when. A thing the Bot gave no title is called by its kind
 * (표, 체크리스트), as its page calls it.
 */
export function madeCard(page: MadePage | undefined): HomeCardView | null {
  const [newest] = listOf(record(page)?.items);
  const item = record(newest);
  if (!item) return null;
  const line = text(item.title) || kindLabel(text(item.tool));
  if (!line) return null;
  const channelId = text(item.channelId);
  const messageId = text(item.messageId);
  return {
    at: text(item.at) || null,
    count: null,
    line,
    note: null,
    // Both or neither: a conversation with no message to go to is the conversation's foot.
    thing:
      channelId && messageId ? { channelId, kind: "made", messageId } : null,
  };
}

/**
 * When, as short as it can be said at a card's right end: the minute if it was today, the date if
 * it was not. Nothing for a time that is not one.
 */
export function cardWhen(iso: string | null, now: Date): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const isToday =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return isToday
    ? at.toLocaleTimeString(activeLocale, {
        hour: "numeric",
        minute: "2-digit",
      })
    : at.toLocaleDateString(activeLocale, { month: "short", day: "numeric" });
}
