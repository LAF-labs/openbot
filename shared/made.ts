/**
 * 만든 것 — WHAT COUNTS AS SOMETHING THE BOT MADE, AND WHICH SHELF IT GOES ON (muse-shape plan §3.5,
 * phase 6, 2026-09-27).
 *
 * v1 has no table of its own. The things are already in the conversation: a gallery card is a tool
 * call stored on the Bot's message (`laf_thread_messages`), with the title the Bot gave it as an
 * argument, and a table the Bot wrote is a markdown table in its answer. The server reads both out
 * of the transcript (`server/src/agents/made.ts`) and answers facts; the surface names the shelves.
 *
 * WHY A MARKDOWN TABLE COUNTS, when the plan named only the cards: asked "메뉴 5개 가격을 표로
 * 정리해 줘" on the local stack (2026-09-27, DeepSeek V4.1 Flash), the Bot drew the checklist as a
 * `showChecklist` card and wrote the price table in its answer as markdown — there is no table card
 * in the gallery, and `showRecord` is one thing's fields. A 만든 것 that read only the cards would
 * have missed the most common 표 anybody asks for.
 *
 * IN `shared/` because both sides read it: the server filters by shelf, the surface draws the
 * shelves and a card's kind from the same table.
 */

/** The shelves the page filters by, in the order they are drawn. 파일 comes with phase 8. */
export const MADE_SHELVES = ["table", "checklist", "text"] as const;

export type MadeShelf = (typeof MADE_SHELVES)[number];

/**
 * The name a markdown table in an answer is filed under. Not a tool: nothing is called by it, and
 * it cannot collide with a gallery name (those are `show…`).
 */
export const MARKDOWN_TABLE = "markdownTable";

/** Every gallery card a Bot can make, by the shelf it goes on. `askApproval`/`askChoice` are questions, not things. */
export const MADE_CARD_SHELF: Readonly<Record<string, MadeShelf>> = {
  showRecord: "table",
  showMetrics: "table",
  showBarChart: "table",
  showPieChart: "table",
  showLineChart: "table",
  showAreaChart: "table",
  showProgress: "table",
  showActivityReport: "table",
  showChecklist: "checklist",
  showNotice: "text",
};

/**
 * The gallery's other cards, which are not things the Bot made: two are questions to the person,
 * a quotation is somebody else's words, and a connection card is 연결's own switches.
 * `app/tests/made.test.ts` holds every gallery card to one list or the other, so a card added later
 * is filed on purpose.
 */
export const NOT_MADE: readonly string[] = [
  "askApproval",
  "askChoice",
  "showQuote",
  // 연결's switches, put in the conversation: a way to connect, not a thing the Bot made.
  "showConnection",
];

export const isMadeShelf = (value: unknown): value is MadeShelf =>
  typeof value === "string" &&
  (MADE_SHELVES as readonly string[]).includes(value);

/** The shelf of a made thing, by its tool name (or {@link MARKDOWN_TABLE}). */
export function shelfOf(tool: string): MadeShelf | null {
  if (tool === MARKDOWN_TABLE) return "table";
  return MADE_CARD_SHELF[tool] ?? null;
}

/** The card names a shelf holds: what the server asks the transcript for. */
export function cardsOn(shelf: MadeShelf | null): string[] {
  return Object.entries(MADE_CARD_SHELF)
    .filter(([, on]) => shelf === null || on === shelf)
    .map(([name]) => name);
}

/** How long a title the list shows. The card itself has the rest. */
export const MADE_TITLE_MAX = 80;

/**
 * A markdown table's separator row: `|---|:---:|`, with or without the outer pipes. The same test
 * in the database (`MADE_TABLE_PATTERN`, POSIX) and here, where the title is read.
 */
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/** The same test as a Postgres regular expression, over the whole answer. */
export const MADE_TABLE_PATTERN =
  "(^|\\n)[ \\t]*\\|?[ \\t]*:?-{3,}:?[ \\t]*(\\|[ \\t]*:?-{3,}:?[ \\t]*)+\\|?[ \\t]*(\\n|$)";

const clip = (text: string) =>
  text.length > MADE_TITLE_MAX
    ? `${text.slice(0, MADE_TITLE_MAX - 1).trimEnd()}…`
    : text;

/** A line with its markdown dressing taken off: `## 메뉴 가격표`, `**메뉴 가격표**` → 메뉴 가격표. */
function plainLine(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/[:：]\s*$/, "")
    .trim();
}

/**
 * The titles of the markdown tables in one answer, first to last.
 *
 * A table is named by what the Bot wrote over it — a heading, or a bold line, within the two lines
 * above its header — and otherwise by its header's cells ("메뉴 · 가격"). Never the model's opinion
 * of the table, and never the answer's first sentence, which is about something else as often as not.
 */
export function markdownTableTitles(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const titles: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (!SEPARATOR.test(lines[index] ?? "")) continue;
    const header = lines[index - 1] ?? "";
    if (!header.includes("|")) continue;
    let named: string | null = null;
    for (let back = index - 2; back >= Math.max(0, index - 4); back -= 1) {
      const above = (lines[back] ?? "").trim();
      if (!above) continue;
      if (/^#{1,6}\s/.test(above) || /^(\*\*|__).+(\*\*|__):?$/.test(above)) {
        named = plainLine(above);
      }
      break;
    }
    const cells = header
      .split("|")
      .map((cell) => plainLine(cell))
      .filter(Boolean);
    const title = named || cells.join(" · ");
    if (title) titles.push(clip(title));
  }
  return titles;
}

/** A card's title as the Bot passed it, clipped; null when it passed none. */
export function cardTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? clip(trimmed) : null;
}
