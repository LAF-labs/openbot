import { MADE_SHELVES, MARKDOWN_TABLE, type MadeShelf } from "@shared/made";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { own } from "@/lib/own";
import { requestOrRefusal } from "@/lib/refusals";

/**
 * 만든 것 on the wire, and the words the page says (muse-shape plan §3.5, phase 6).
 *
 * The server answers facts read out of the conversation (`server/src/agents/made.ts`): which card,
 * the title the Bot gave it, when, and where to jump to. What a shelf and a kind are CALLED is this
 * module's, through `t()` — the tables below are walked by `app/tests/made.test.ts`, because
 * `t(variable)` is invisible to the dictionary's own coverage test.
 */

export type MadeItem = {
  tool: string;
  shelf: MadeShelf;
  title: string | null;
  at: string;
  channelId: string;
  messageId: string;
  /** What the card was called with: on the newest thing only, where it is a card (`made.ts`). */
  args?: Record<string, unknown>;
};

export type MadePage = { items: MadeItem[]; next: string | null };

export const madeKeys = {
  all: ["agents", "made"] as const,
  of: (botId: string, shelf: MadeShelf | null) =>
    ["agents", "made", botId, shelf ?? "all"] as const,
};

/** The filters above the list, in order: everything, then each shelf. */
export const SHELF_LABELS: Readonly<Record<MadeShelf | "all", string>> = {
  all: "All",
  table: "Tables and charts",
  checklist: "Checklists",
  text: "Writing",
  file: "Files",
};

export const SHELF_ORDER: readonly (MadeShelf | "all")[] = [
  "all",
  ...MADE_SHELVES,
];

/**
 * The filters the page draws, in order. 파일 only once there is a file to show under it (or while it
 * is the filter being looked at): most people's Bot makes a table long before it hands over a file,
 * and a filter that opens on "아직 여기엔 없어요" is a promise of something this Bot has not done.
 */
export function shelvesDrawn(hasFile: boolean): readonly (MadeShelf | "all")[] {
  return SHELF_ORDER.filter((shelf) => shelf !== "file" || hasFile);
}

/**
 * What one made thing is, in a word, by its tool. The gallery's own names where a card has one
 * (`components/gallery/*.tsx` titles them the same), and "표" for a table written in an answer.
 */
export const KIND_LABELS: Readonly<Record<string, string>> = {
  [MARKDOWN_TABLE]: "Table",
  showRecord: "Record",
  showMetrics: "Headline figures",
  showBarChart: "Bar chart",
  showPieChart: "Donut chart",
  showLineChart: "Line chart",
  showAreaChart: "Area chart",
  showProgress: "Progress against target",
  showActivityReport: "Activity report",
  showChecklist: "Checklist",
  showNotice: "Notice",
  showFile: "File",
};

/**
 * THE + BUTTON'S STARTS (plan §3.5): each puts a sentence in the conversation's box, unsent, for the
 * person to finish — what the table is of, what the notice says. The last is the bare stem.
 */
export const MADE_STARTERS: readonly { label: string; draft: string }[] = [
  { label: "Table", draft: "Make this into a table: " },
  { label: "Checklist", draft: "Make a checklist for this: " },
  { label: "Notice", draft: "Write a notice for this: " },
  { label: "Introduction", draft: "Write an introduction for this: " },
  { label: "Something else", draft: "Make this for me: " },
];

/** A made thing's kind, in the person's language. */
export function kindLabel(tool: string): string {
  const key = own(KIND_LABELS, tool);
  return key ? t(key) : "";
}

/**
 * The kind a shelf's own icon already says: the table icon is 표, the checklist's 체크리스트, the
 * page's 안내문, the downloaded file's 파일.
 *
 * A card drew "파일 · 10월 2일 오후 5:05" under a file's name, beside the file icon — the kind twice,
 * on eleven of eleven cards on the account this was measured on (2026-10-04). The word is drawn
 * only where it says more than the icon: 막대 차트, 기록, 주요 수치 on the table shelf.
 */
const SAID_BY_THE_ICON: Readonly<Record<MadeShelf, string>> = {
  table: MARKDOWN_TABLE,
  checklist: "showChecklist",
  text: "showNotice",
  file: "showFile",
};

/** The kind to draw beside a card's time, or null where the card's icon is that kind. */
export function kindBesideTime(item: Pick<MadeItem, "tool" | "shelf">) {
  return SAID_BY_THE_ICON[item.shelf] === item.tool
    ? null
    : kindLabel(item.tool) || null;
}

/*
 * No table of refusals: the page says its one sentence for any failure, and reads the code off
 * the error for "not here" (`routes/_authed/_app/made.tsx`).
 */
const madeRequest = async (path: string) =>
  (await requestOrRefusal(path, undefined)) as unknown as MadePage;

export function madeQueryOptions(botId: string, shelf: MadeShelf | null) {
  return infiniteQueryOptions({
    queryKey: madeKeys.of(botId, shelf),
    initialPageParam: null as string | null,
    // Of whatever arrived: an answer that is no page has no next one (`lib/feed/queries.ts` says why).
    getNextPageParam: (last: MadePage | null | undefined) => last?.next ?? null,
    // What the Bot makes arrives in the conversation; the page is read again whenever it is opened.
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      if (shelf) search.set("shelf", shelf);
      if (pageParam) search.set("cursor", pageParam);
      const query = search.toString();
      return madeRequest(
        `/api/agents/${encodeURIComponent(botId)}/made${query ? `?${query}` : ""}`,
      );
    },
  });
}
