import { createHash, randomBytes } from "node:crypto";
import {
  HUB_DOC_BLOCK_KINDS,
  HUB_DOC_BLOCK_MAX_CHARS,
  type HubDocBlockAttrs,
  type HubDocBlockKind,
} from "../../../shared/hub/protocol";
import { charLength } from "../../../shared/hub/search-words";

/** A block id: `b_` and lower-case letters and digits, short because 라피 reads every one. */
export const BLOCK_ID = /^b_[a-z0-9]{10,40}$/;
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A fresh block id: 12 random base-36 characters, unique within a document by its primary key. */
export function newBlockId(): string {
  const bytes = randomBytes(12);
  let id = "b_";
  for (const byte of bytes) id += ALPHABET[byte % 36];
  return id;
}

export type BlockContent = {
  kind: HubDocBlockKind;
  text: string;
  attrs: HubDocBlockAttrs;
};

const KINDS = new Set<string>(HUB_DOC_BLOCK_KINDS);
/** Kinds whose text is one line: a newline in them would read back as a second block. */
const ONE_LINE = new Set<HubDocBlockKind>([
  "heading1",
  "heading2",
  "heading3",
  "list",
  "check",
  "file",
  "task-link",
]);
const ATTRS_OF: Record<HubDocBlockKind, readonly (keyof HubDocBlockAttrs)[]> = {
  paragraph: [],
  heading1: [],
  heading2: [],
  heading3: [],
  list: ["ordered", "indent"],
  check: ["checked", "indent"],
  quote: [],
  code: ["lang"],
  divider: [],
  table: ["rows"],
  file: ["fileId"],
  "task-link": ["taskId"],
};
const LANG = /^[A-Za-z0-9_+.#-]{1,32}$/;
const REF_ID = /^[A-Za-z0-9_-]{1,80}$/;
const TABLE_MAX_ROWS = 200;
const TABLE_MAX_COLUMNS = 20;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export type ContentInvalid = { invalid: string };

/**
 * A block as it is kept: the kind known, the text NFC with `\n` line ends and no control characters,
 * the attributes only those the kind takes, each of its shape, with defaults left out. One shape per
 * meaning, so the hash of a block someone saves unchanged is the hash it had.
 *
 * A paragraph or quote loses blank lines at its two ends: the markdown 라피 reads could not carry
 * them back (a blank line is where one block ends).
 */
export function cleanContent(input: {
  kind: unknown;
  text: unknown;
  attrs: unknown;
}): BlockContent | ContentInvalid {
  if (typeof input.kind !== "string" || !KINDS.has(input.kind)) {
    return { invalid: "kind" };
  }
  const kind = input.kind as HubDocBlockKind;
  if (typeof input.text !== "string") return { invalid: "text" };
  let text = input.text.normalize("NFC").replace(/\r\n?/g, "\n");
  if (CONTROL.test(text)) return { invalid: "text" };
  if (charLength(text) > HUB_DOC_BLOCK_MAX_CHARS) return { invalid: "text" };
  if (ONE_LINE.has(kind) && text.includes("\n")) return { invalid: "text" };
  if (kind === "paragraph" || kind === "quote") {
    text = text.replace(/^\n+|\n+$/g, "");
  }
  if ((kind === "divider" || kind === "table") && text !== "") {
    return { invalid: "text" };
  }

  const raw = input.attrs ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { invalid: "attrs" };
  }
  const given = raw as Record<string, unknown>;
  const allowed = ATTRS_OF[kind];
  if (Object.keys(given).some((key) => !allowed.includes(key as never))) {
    return { invalid: "attrs" };
  }
  const attrs: HubDocBlockAttrs = {};
  if (given.ordered !== undefined) {
    if (typeof given.ordered !== "boolean") return { invalid: "attrs" };
    if (given.ordered) attrs.ordered = true;
  }
  if (given.checked !== undefined) {
    if (typeof given.checked !== "boolean") return { invalid: "attrs" };
    if (given.checked) attrs.checked = true;
  }
  if (given.indent !== undefined) {
    const indent = given.indent;
    if (
      typeof indent !== "number" ||
      !Number.isInteger(indent) ||
      indent < 0 ||
      indent > 3
    ) {
      return { invalid: "attrs" };
    }
    if (indent > 0) attrs.indent = indent;
  }
  if (given.lang !== undefined) {
    if (typeof given.lang !== "string" || !LANG.test(given.lang)) {
      return { invalid: "attrs" };
    }
    attrs.lang = given.lang;
  }
  for (const key of ["fileId", "taskId"] as const) {
    if (given[key] !== undefined) {
      const value = given[key];
      if (typeof value !== "string" || !REF_ID.test(value)) {
        return { invalid: "attrs" };
      }
      attrs[key] = value;
    }
  }
  if (kind === "file" && !attrs.fileId) return { invalid: "attrs" };
  if (kind === "task-link" && !attrs.taskId) return { invalid: "attrs" };
  if (kind === "table") {
    const rows = cleanRows(given.rows);
    if (!rows) return { invalid: "attrs" };
    attrs.rows = rows;
  }
  return { kind, text, attrs };
}

/**
 * A table's cells: one line each, trimmed, every row as wide as the widest, so drawing it and
 * reading it back gives the same rows.
 */
function cleanRows(raw: unknown): string[][] | null {
  if (raw === undefined) return [[""]];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > TABLE_MAX_ROWS) {
    return null;
  }
  let width = 1;
  let total = 0;
  const rows: string[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length > TABLE_MAX_COLUMNS) return null;
    const cells: string[] = [];
    for (const cell of row) {
      if (typeof cell !== "string") return null;
      const clean = cell.normalize("NFC").trim();
      if (clean.includes("\n") || clean.includes("\r") || CONTROL.test(clean)) {
        return null;
      }
      total += charLength(clean);
      cells.push(clean);
    }
    width = Math.max(width, cells.length);
    rows.push(cells);
  }
  if (total > HUB_DOC_BLOCK_MAX_CHARS) return null;
  return rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ""),
  ]);
}

/** Attributes with their keys in one order, so equal attributes serialise equally. */
function canonicalAttrs(attrs: HubDocBlockAttrs): unknown[] {
  return [
    attrs.ordered ?? false,
    attrs.checked ?? false,
    attrs.indent ?? 0,
    attrs.lang ?? null,
    attrs.rows ?? null,
    attrs.fileId ?? null,
    attrs.taskId ?? null,
  ];
}

/**
 * What 라피 sends back as `expectHash`: 16 hex characters of a SHA-256 of the kind, text and
 * attributes. Not the version: a version is how many saves, a hash is what the block says, so 라피
 * reading a block a person saved without changing still holds a good hash.
 */
export function blockHash(content: BlockContent): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        content.kind,
        content.text,
        canonicalAttrs(content.attrs),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

/** The words search finds a block by: its text, or a table's cells. */
export function searchableText(content: BlockContent): string {
  if (content.kind === "table") {
    return (content.attrs.rows ?? []).map((row) => row.join(" ")).join("\n");
  }
  return content.text;
}
