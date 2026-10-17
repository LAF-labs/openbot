/**
 * What a key does in a document's block — the rules, apart from any screen, so they can be held by
 * a test (`app/tests/doc-block-keys.test.ts`).
 *
 * THE SHAPE IS NOTION'S, WRITTEN BY US. Enter makes a new block from what is after the caret; an
 * Enter in an empty list item ends the list; Backspace at the very start joins the block to the one
 * above (an empty one simply goes); a list, a check, a quote or a heading first turns back into a
 * paragraph; arrows leave the block only from its first or last line; `/` in an empty block opens
 * the kind menu. Shift+Enter is a line break inside the block, and inside a code block Enter is one
 * too — code has lines.
 *
 * A KEY THE INPUT METHOD OWNS IS NEVER OURS. While Korean is being assembled, Enter finishes the
 * syllable and Backspace takes a jamo off it; acting on either would split or merge around a
 * syllable still being written (`lib/ime.ts`). `composing` is checked first, before anything else.
 */
import type { DocBlockKind } from "@/lib/hub/docs";

export type BlockKeyInput = {
  key: string;
  shift: boolean;
  /** Ctrl or ⌘. */
  mod: boolean;
  alt: boolean;
  /** The input method is assembling a syllable, or this key started one. */
  composing: boolean;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  kind: DocBlockKind;
};

export type BlockKeyAction =
  /** Not ours: the textarea does what it does. */
  | { type: "none" }
  /** A new block below with `tail`; this one keeps `head`. */
  | { type: "split"; head: string; tail: string }
  /** This block, empty, goes; the caret goes to the end of the one above. */
  | { type: "remove" }
  /** This block's text is appended to the one above, and this block goes. */
  | { type: "merge-up" }
  /** A list, check, quote or heading becomes a paragraph, text kept. */
  | { type: "to-paragraph" }
  | { type: "focus-prev" }
  | { type: "focus-next" }
  /** Writing stops: the block shows its markdown again. */
  | { type: "leave" };

const NONE: BlockKeyAction = { type: "none" };

/** Kinds that fall back to a paragraph on Backspace at their start, as Notion's do. */
const FALLS_BACK: ReadonlySet<DocBlockKind> = new Set([
  "heading1",
  "heading2",
  "heading3",
  "list",
  "check",
  "quote",
]);

/** Kinds whose Enter on an empty block ends the run of them instead of making another. */
const ENDS_ON_EMPTY: ReadonlySet<DocBlockKind> = new Set([
  "list",
  "check",
  "quote",
]);

export function blockKeyAction(input: BlockKeyInput): BlockKeyAction {
  if (input.composing) return NONE;
  const { key, value, selectionStart, selectionEnd, kind } = input;
  const collapsed = selectionStart === selectionEnd;

  if (key === "Escape") return { type: "leave" };

  if (key === "Enter") {
    if (input.alt) return NONE;
    if (kind === "code") {
      // Code has lines: ⌘/Ctrl+Enter leaves it for a new block, plain Enter is a line.
      return input.mod
        ? { type: "split", head: value, tail: "" }
        : NONE;
    }
    if (input.shift) return NONE;
    if (value === "" && ENDS_ON_EMPTY.has(kind)) return { type: "to-paragraph" };
    return {
      type: "split",
      head: value.slice(0, selectionStart),
      tail: value.slice(selectionEnd),
    };
  }

  if (key === "Backspace") {
    if (!collapsed || selectionStart !== 0 || input.mod || input.alt) {
      return NONE;
    }
    if (FALLS_BACK.has(kind)) return { type: "to-paragraph" };
    return value === "" ? { type: "remove" } : { type: "merge-up" };
  }

  if (key === "ArrowUp" && collapsed && !input.shift) {
    // Only from the first line: an arrow inside a block with several lines moves inside it.
    return value.lastIndexOf("\n", selectionStart - 1) === -1
      ? { type: "focus-prev" }
      : NONE;
  }

  if (key === "ArrowDown" && collapsed && !input.shift) {
    return value.indexOf("\n", selectionStart) === -1
      ? { type: "focus-next" }
      : NONE;
  }

  return NONE;
}

/**
 * A markdown start typed into an empty paragraph turns it into that kind: `# ` a heading, `- ` a
 * list item, `[] ` a check, `> ` a quote, ` ``` ` code, `---` a divider. Only a paragraph, and only
 * at its very start, so a `- ` in the middle of a sentence is a dash.
 */
export function kindFromMarkdownStart(
  value: string,
): { kind: DocBlockKind; rest: string } | null {
  const starts: [string, DocBlockKind][] = [
    ["### ", "heading3"],
    ["## ", "heading2"],
    ["# ", "heading1"],
    ["- ", "list"],
    ["* ", "list"],
    ["[] ", "check"],
    ["[ ] ", "check"],
    ["> ", "quote"],
    ["```", "code"],
  ];
  for (const [start, kind] of starts) {
    if (value.startsWith(start)) return { kind, rest: value.slice(start.length) };
  }
  if (value === "---") return { kind: "divider", rest: "" };
  return null;
}

/** The kinds the `/` menu offers, in its order. A file or a task link comes from 라피, not here. */
export const MENU_KINDS: readonly DocBlockKind[] = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "list",
  "check",
  "quote",
  "code",
  "divider",
  "table",
];

/** The menu's choices for what was typed after `/`: `/제목`, `/h2`, `/표`. */
export function menuMatches(
  query: string,
  labelOf: (kind: DocBlockKind) => string,
): DocBlockKind[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [...MENU_KINDS];
  return MENU_KINDS.filter(
    (kind) =>
      labelOf(kind).toLowerCase().includes(wanted) ||
      kind.toLowerCase().includes(wanted) ||
      ALIASES[kind]?.some((alias) => alias.startsWith(wanted)),
  );
}

const ALIASES: Partial<Record<DocBlockKind, string[]>> = {
  heading1: ["h1"],
  heading2: ["h2"],
  heading3: ["h3"],
  list: ["ul", "bullet"],
  check: ["todo", "checkbox"],
  divider: ["hr", "line"],
};

/** The `/query` an empty-at-start block holds while the menu is open, or null when it is not one. */
export function slashQuery(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const query = value.slice(1);
  // A space ends it, the way a person writing "/ 표시" means the slash.
  return /\s/.test(query) || query.length > 20 ? null : query;
}
