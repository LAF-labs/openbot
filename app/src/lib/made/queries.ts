import { MADE_SHELVES, MARKDOWN_TABLE, type MadeShelf } from "@shared/made";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { RequestRefusedError } from "@/lib/refusals";

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
};

export type MadePage = { items: MadeItem[]; next: string | null };

export const madeKeys = {
  all: ["agents", "made"] as const,
  of: (botId: string, shelf: MadeShelf | null) =>
    ["agents", "made", botId, shelf ?? "all"] as const,
};

/** The refusals a door answers with, as the codes it sends. */
export const MADE_REFUSALS: Readonly<Record<string, string>> = {
  "laf:made_unavailable": "What your Bot made could not be read.",
  "laf:made_shelf_unknown": "What your Bot made could not be read.",
  "laf:made_cursor_invalid": "What your Bot made could not be read.",
  "laf:agent_not_found": "That Bot is not yours to see.",
};

/** The filters above the list, in order: everything, then each shelf. */
export const SHELF_LABELS: Readonly<Record<MadeShelf | "all", string>> = {
  all: "All",
  table: "Tables and charts",
  checklist: "Checklists",
  text: "Writing",
};

export const SHELF_ORDER: readonly (MadeShelf | "all")[] = [
  "all",
  ...MADE_SHELVES,
];

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
  const key = KIND_LABELS[tool];
  return key ? t(key) : "";
}

async function madeRequest(path: string): Promise<MadePage> {
  const response = await fetch(path, { credentials: "include" });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : "";
    const known = MADE_REFUSALS[code];
    throw new RequestRefusedError(
      known ? t(known) : t("What your Bot made could not be read."),
      response.status,
      code || null,
    );
  }
  return body as unknown as MadePage;
}

export function madeQueryOptions(botId: string, shelf: MadeShelf | null) {
  return infiniteQueryOptions({
    queryKey: madeKeys.of(botId, shelf),
    initialPageParam: null as string | null,
    getNextPageParam: (last: MadePage) => last.next,
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
