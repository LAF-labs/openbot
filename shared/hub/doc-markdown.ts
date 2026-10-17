import type { HubDocBlockAttrs, HubDocBlockKind } from "./protocol";

/**
 * A team document as markdown, and back — our own code, because the kinds are fixed and few
 * (`HUB_DOC_BLOCK_KINDS`), and a library would be a dependency for what is a page of rules.
 *
 * TWO READINGS. A document drawn for 라피 puts a `<!-- <block id> <hash> -->` line before every
 * block, so what it reads names what it may change (`expectHash`). Read back WITH those lines, each
 * stretch between two of them is exactly one block, whatever its text holds — a paragraph whose
 * second line starts with `- ` stays one paragraph. Read WITHOUT them (markdown 라피 or a person
 * wrote fresh), blocks are found the way a markdown reader finds them: a blank line ends a
 * paragraph, each list line is its own block.
 *
 * WHAT IS ESCAPED, so that drawing then reading gives back the same blocks: a paragraph, heading or
 * list item whose text starts with something that would read as markdown syntax (or with a
 * backslash) is drawn with one more backslash in front, and reading takes one away; a table cell's
 * `|` and `\` are escaped; a code block's fence is longer than any run of backticks inside it; and a
 * line of any block that would read as a block marker is drawn with one more backslash.
 */

export type DocMarkdownBlock = {
  kind: HubDocBlockKind;
  text: string;
  attrs: HubDocBlockAttrs;
};

export type DocMarkdownMarked = DocMarkdownBlock & {
  /** From the marker line, when there was one. */
  id: string | null;
  hash: string | null;
};

const MARKER = /^<!-- (b_[a-z0-9]{10,40})(?: ([0-9a-f]{16}))? -->$/;
/** A text line that would read as a marker, with any backslashes already in front of it. */
const MARKER_LIKE = /^\\*<!-- b_[a-z0-9]{10,40}(?: [0-9a-f]{16})? -->$/;

const HEADING = /^(#{1,3}) (.*)$/;
const CHECK = /^((?: {2})*)- \[( |x|X)\] ?(.*)$/;
const BULLET = /^((?: {2})*)[-*+] (.*)$/;
const ORDERED = /^((?: {2})*)\d{1,9}[.)] (.*)$/;
const FENCE = /^(`{3,})([^`]*)$/;
const DIVIDER = /^(?:-{3,}|\*{3,}|_{3,})$/;
const LINK_BLOCK =
  /^\[((?:[^\]\\]|\\.)*)\]\(hub:\/\/(file|task)\/([A-Za-z0-9_-]{1,80})\)$/;

/** A text whose start would be read as syntax, or that starts with the escape itself. */
function needsEscape(text: string): boolean {
  return (
    /^[\s\\#>*+|[`~_-]/.test(text) ||
    /^\d{1,9}[.)](?: |$)/.test(text) ||
    /^<!--/.test(text)
  );
}

const escapeStart = (text: string) => (needsEscape(text) ? `\\${text}` : text);
const unescapeStart = (text: string) =>
  text.startsWith("\\") ? text.slice(1) : text;

/** Lines that would read as markers get one more backslash; reading takes one away. */
const guardLines = (text: string) =>
  text
    .split("\n")
    .map((line) => (MARKER_LIKE.test(line) ? `\\${line}` : line))
    .join("\n");
const unguardLine = (line: string) =>
  line.startsWith("\\") && MARKER_LIKE.test(line) ? line.slice(1) : line;

const escapeCell = (cell: string) =>
  cell.replaceAll("\\", "\\\\").replaceAll("|", "\\|");
const escapeLabel = (label: string) =>
  label.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
const unescapeLabel = (label: string) => label.replace(/\\(.)/g, "$1");

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  const cells: string[] = [];
  let cell = "";
  let closed = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] as string;
    closed = false;
    if (character === "\\" && index + 1 < body.length) {
      cell += body[index + 1];
      index += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      closed = true;
    } else {
      cell += character;
    }
  }
  if (!closed) cells.push(cell.trim());
  return cells;
}

const isSeparatorRow = (line: string) =>
  /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line.trim());

function indentOf(spaces: string): number {
  return Math.min(3, spaces.length / 2);
}

/** One block as markdown, without its marker. */
export function blockToMarkdown(block: DocMarkdownBlock): string {
  const { kind, text, attrs } = block;
  const pad = "  ".repeat(attrs.indent ?? 0);
  switch (kind) {
    case "heading1":
    case "heading2":
    case "heading3":
      return `${"#".repeat(Number(kind.slice(-1)))} ${escapeStart(text)}`;
    case "list":
      return `${pad}${attrs.ordered ? "1." : "-"} ${escapeStart(text)}`;
    case "check":
      return `${pad}- [${attrs.checked ? "x" : " "}] ${escapeStart(text)}`;
    case "quote":
      return guardLines(text)
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
    case "code": {
      const longest = Math.max(
        0,
        ...[...text.matchAll(/`+/g)].map((run) => run[0].length),
      );
      const fence = "`".repeat(Math.max(3, longest + 1));
      return `${fence}${attrs.lang ?? ""}\n${guardLines(text)}\n${fence}`;
    }
    case "divider":
      return "---";
    case "table": {
      const rows = attrs.rows ?? [[""]];
      const width = Math.max(1, ...rows.map((row) => row.length));
      const line = (row: string[]) =>
        `| ${Array.from({ length: width }, (_, index) => escapeCell(row[index] ?? "")).join(" | ")} |`;
      const [head = [], ...body] = rows;
      return [
        line(head),
        `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
        ...body.map(line),
      ].join("\n");
    }
    case "file":
      return `[${escapeLabel(text)}](hub://file/${attrs.fileId ?? ""})`;
    case "task-link":
      return `[${escapeLabel(text)}](hub://task/${attrs.taskId ?? ""})`;
    default: {
      const lines = guardLines(text).split("\n");
      lines[0] = escapeStart(lines[0] ?? "");
      return lines.join("\n");
    }
  }
}

/** A whole document for 라피: every block after its marker, blocks a blank line apart. */
export function docToMarkdown(
  blocks: readonly (DocMarkdownBlock & { id: string; hash?: string })[],
): string {
  return blocks
    .map(
      (block) =>
        `<!-- ${block.id}${block.hash ? ` ${block.hash}` : ""} -->\n${blockToMarkdown(block)}`,
    )
    .join("\n\n");
}

/**
 * The blocks in a markdown text. With markers, one block per marker (text before the first marker
 * is read as unmarked blocks with no id); without, the ordinary reading.
 */
export function markdownToBlocks(markdown: string): DocMarkdownMarked[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: DocMarkdownMarked[] = [];
  let pending: string[] = [];
  let marker: { id: string; hash: string | null } | null = null;
  const flush = () => {
    if (marker) {
      out.push({ ...readOne(trimBlank(pending)), ...marker });
    } else {
      for (const block of readMany(pending)) {
        out.push({ ...block, id: null, hash: null });
      }
    }
    pending = [];
  };
  for (const line of lines) {
    const found = MARKER.exec(line);
    if (found) {
      flush();
      marker = { id: found[1] as string, hash: found[2] ?? null };
    } else {
      pending.push(line);
    }
  }
  flush();
  return out;
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] as string).trim() === "") start += 1;
  while (end > start && (lines[end - 1] as string).trim() === "") end -= 1;
  return lines.slice(start, end);
}

/** Exactly one block from the lines between two markers. */
function readOne(lines: string[]): DocMarkdownBlock {
  const first = lines[0] ?? "";
  const single = lines.length === 1;
  if (lines.length === 0) return { kind: "paragraph", text: "", attrs: {} };
  const fence = FENCE.exec(first);
  if (fence) {
    const mark = fence[1] as string;
    const closing = lines.length > 1 && lines.at(-1) === mark;
    const inner = lines.slice(1, closing ? -1 : undefined).map(unguardLine);
    const lang = (fence[2] ?? "").trim();
    return {
      kind: "code",
      text: inner.join("\n"),
      attrs: lang ? { lang } : {},
    };
  }
  if (single) {
    const block = readLine(first);
    if (block) return block;
  }
  if (lines.every((line) => line.startsWith(">"))) {
    return {
      kind: "quote",
      text: lines
        .map((line) => unguardLine(line.replace(/^> ?/, "")))
        .join("\n"),
      attrs: {},
    };
  }
  if (
    lines.length >= 2 &&
    first.trim().startsWith("|") &&
    isSeparatorRow(lines[1] as string)
  ) {
    return {
      kind: "table",
      text: "",
      attrs: { rows: [first, ...lines.slice(2)].map(splitRow) },
    };
  }
  const text = lines.map(unguardLine);
  text[0] = unescapeStart(text[0] ?? "");
  return { kind: "paragraph", text: text.join("\n"), attrs: {} };
}

/** A line that is a whole block by itself, or null when it is part of a paragraph. */
function readLine(line: string): DocMarkdownBlock | null {
  const heading = HEADING.exec(line);
  if (heading) {
    const level = (heading[1] as string).length as 1 | 2 | 3;
    return {
      kind: `heading${level}`,
      text: unescapeStart(heading[2] as string),
      attrs: {},
    };
  }
  const check = CHECK.exec(line);
  if (check) {
    const indent = indentOf(check[1] as string);
    return {
      kind: "check",
      text: unescapeStart(check[3] as string),
      attrs: {
        ...(check[2] === " " ? {} : { checked: true }),
        ...(indent ? { indent } : {}),
      },
    };
  }
  if (DIVIDER.test(line)) return { kind: "divider", text: "", attrs: {} };
  const bullet = BULLET.exec(line);
  if (bullet) {
    const indent = indentOf(bullet[1] as string);
    return {
      kind: "list",
      text: unescapeStart(bullet[2] as string),
      attrs: indent ? { indent } : {},
    };
  }
  const ordered = ORDERED.exec(line);
  if (ordered) {
    const indent = indentOf(ordered[1] as string);
    return {
      kind: "list",
      text: unescapeStart(ordered[2] as string),
      attrs: { ordered: true, ...(indent ? { indent } : {}) },
    };
  }
  const link = LINK_BLOCK.exec(line);
  if (link) {
    const label = unescapeLabel(link[1] as string);
    return link[2] === "file"
      ? { kind: "file", text: label, attrs: { fileId: link[3] as string } }
      : {
          kind: "task-link",
          text: label,
          attrs: { taskId: link[3] as string },
        };
  }
  return null;
}

/** The ordinary reading of unmarked markdown. */
function readMany(lines: string[]): DocMarkdownBlock[] {
  const blocks: DocMarkdownBlock[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length > 0) blocks.push(readOne(paragraph));
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim() === "") {
      endParagraph();
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      endParagraph();
      const mark = fence[1] as string;
      let end = index + 1;
      while (end < lines.length && lines[end] !== mark) end += 1;
      blocks.push(readOne(lines.slice(index, Math.min(end + 1, lines.length))));
      index = end;
      continue;
    }
    if (line.startsWith(">")) {
      endParagraph();
      let end = index;
      while (end < lines.length && (lines[end] as string).startsWith(">")) {
        end += 1;
      }
      blocks.push(readOne(lines.slice(index, end)));
      index = end - 1;
      continue;
    }
    if (
      line.trim().startsWith("|") &&
      index + 1 < lines.length &&
      isSeparatorRow(lines[index + 1] as string)
    ) {
      endParagraph();
      let end = index + 2;
      while (
        end < lines.length &&
        (lines[end] as string).trim().startsWith("|")
      ) {
        end += 1;
      }
      blocks.push(readOne(lines.slice(index, end)));
      index = end - 1;
      continue;
    }
    const whole = readLine(line);
    if (whole) {
      endParagraph();
      blocks.push(whole);
      continue;
    }
    paragraph.push(line);
  }
  endParagraph();
  return blocks;
}
