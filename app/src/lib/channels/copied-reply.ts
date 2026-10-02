/**
 * WHAT 복사 PUTS ON THE CLIPBOARD: THE ANSWER AS IT READS, NOT THE MARKDOWN THAT DREW IT.
 *
 * Pressed on the running app, 2026-10-02: 복사 under an answer with a table wrote the Bot's raw text
 * — `| 이름 | 값 |` and `| --- | --- |`, and `**` around every bold word. An answer is the artefact
 * — a summary, a list, a table of prices — and where it goes next is 카카오톡, a 배민 answer box, a
 * 한글 document, a spreadsheet. None of them draws markdown.
 *
 * So two things are written, and whatever is pasted into takes the one it understands:
 *
 *  - WORDS (`text/plain`), with the marks gone and the shape kept: paragraphs, list markers, a
 *    table's cells separated by tabs — which a spreadsheet takes into its cells and a chat box shows
 *    as columns — and code as it was written.
 *  - THE ANSWER AS DRAWN (`text/html`), from the bubble on screen with our own controls and styling
 *    taken off, so a table lands in a document as a table and bold as bold.
 *
 * A line-by-line pass, like `spoken-text.ts` and for its reason: the renderer that draws the bubble
 * is a lazy chunk, and this must work the moment the button is there.
 *
 * WHAT IS A TABLE, A CODE BLOCK AND A MARK IS DECIDED AS THE RENDERER DECIDES IT. Three places where
 * a looser reading copied something other than what was drawn (review of this change):
 *
 *  - a table's rule may have ONE hyphen a cell (`| - | - |`), and is a rule only when it has as many
 *    cells as the header above it;
 *  - a code block closes on a fence of the same mark and at least the same length as the one that
 *    opened it — three backticks inside a four-backtick block are code;
 *  - punctuation behind a backslash is punctuation to show, not a mark.
 *
 * And, found by reading this pass against the renderer after that: what is inside a code span is
 * code, and keeps its stars; a heading may be underlined with `===`, or close its own `##`; an
 * entity is the character it names; a backslash at the end of a line is a line break.
 */

/** A table's delimiter row: `|-|:-:|`. It draws a line and holds no words. */
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
/** A horizontal rule: three or more of one mark, alone on the line. */
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** The fence that opens a code block, and what follows it on its line. */
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
/** `===` under a line of words: that line is a heading. */
const HEADING_UNDERLINE = /^\s{0,3}=+\s*$/;

/** ASCII punctuation: behind a backslash one of these is shown, and in a code span all of them are. */
const PUNCTUATION = /[!-/:-@[-`{-~]/g;
const isPunctuation = (char: string | undefined) =>
  char !== undefined && /^[!-/:-@[-`{-~]$/.test(char);

/**
 * Where punctuation that is NOT a mark waits while the marks are taken off: the private-use block,
 * one place per ASCII character. Nothing a person types lives there. The pattern is built from the
 * numbers, so that no invisible character sits in this file.
 */
const SHELTER = 0xe000;
const SHELTERED = new RegExp(
  `[${String.fromCharCode(SHELTER)}-${String.fromCharCode(SHELTER + 0x7f)}]`,
  "g",
);

const shelter = (mark: string) =>
  String.fromCharCode(SHELTER + mark.charCodeAt(0));

/** Where the run of `length` backticks that closes a code span begins, from `from` on; -1 if none. */
function closingRun(text: string, from: number, length: number): number {
  let at = text.indexOf("`", from);
  while (at !== -1) {
    let end = at;
    while (text[end] === "`") end += 1;
    if (end - at === length) return at;
    at = text.indexOf("`", end);
  }
  return -1;
}

/**
 * The line with everything that only LOOKS like a mark put out of the marks' reach.
 *
 * Read left to right, as the renderer reads it, because the two rules lean on each other: a
 * backslash before punctuation shows that punctuation — an escaped backtick opens no code span —
 * and inside a code span a backslash is a backslash and every star is a star. The span's own
 * backticks go: they drew the code, they are not in it.
 */
function sheltered(text: string): string {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    if (char === "\\" && isPunctuation(text[at + 1])) {
      out += shelter(text.charAt(at + 1));
      at += 2;
      continue;
    }
    if (char !== "`") {
      out += char;
      at += 1;
      continue;
    }
    let end = at;
    while (text[end] === "`") end += 1;
    const length = end - at;
    const close = closingRun(text, end, length);
    if (close === -1) {
      // Backticks that open nothing are backticks.
      out += text.slice(at, end).replace(PUNCTUATION, shelter);
      at = end;
      continue;
    }
    const code = text.slice(end, close);
    // One space of padding either side is the span's, not the code's.
    const held =
      code.length > 2 && code.startsWith(" ") && code.endsWith(" ")
        ? code.slice(1, -1)
        : code;
    out += held.replace(PUNCTUATION, shelter);
    at = close + length;
  }
  return out;
}

function unsheltered(text: string): string {
  return text.replace(SHELTERED, (held) =>
    String.fromCharCode(held.charCodeAt(0) - SHELTER),
  );
}

/** The entities a model writes, as the characters they stand for. */
const ENTITIES: Readonly<Record<string, string>> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&amp;": "&",
};

/** A line's inline marks taken off, with what they held kept. A link keeps its address. */
function withoutMarks(text: string): string {
  return (
    text
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) =>
        label === href || String(href).startsWith("#")
          ? label
          : `${label} (${href})`,
      )
      .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, "$1")
      .replace(/\*\*|__|~~/g, "")
      .replace(
        /(^|[^\p{L}\p{N}])[*_](?=\S)(.+?)(?<=\S)[*_](?![\p{L}\p{N}])/gu,
        "$1$2",
      )
      // In one pass, so `&amp;lt;` is `&lt;` and is not decoded a second time.
      .replace(
        /&(?:lt|gt|quot|#39|apos|nbsp|amp);/g,
        (entity) => ENTITIES[entity] ?? entity,
      )
  );
}

/** What a line of prose, or a cell, reads as: sheltered, stripped, and given back. */
const read = (text: string) => unsheltered(withoutMarks(sheltered(text)));

/** A row's cells: split on its pipes, the outer ones dropped. An escaped pipe is a pipe in a cell. */
function cells(line: string): string[] {
  return line
    .replace(/\\\|/g, shelter("|"))
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|");
}

/** A table's row, cell by cell, with a tab between: the one separator every paste target keeps. */
function tableRow(line: string): string {
  return cells(line)
    .map((cell) => read(cell).trim())
    .join("\t");
}

/** Whether `rule` is the line under a table's header: a rule, as wide as the header. */
function isTableHead(header: string, rule: string | undefined): boolean {
  return (
    rule !== undefined &&
    header.includes("|") &&
    TABLE_RULE.test(rule) &&
    cells(header).length === cells(rule).length
  );
}

function plainLine(line: string): string {
  if (RULE.test(line)) return "";
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  // A backslash at the very end is a line break, which the line's own end already is.
  const body = sheltered(line.slice(indent.length).replace(/\\$/, ""));
  const rest = (
    /^#{1,6}\s/.test(body)
      ? // A heading, and the marks it may close itself with (`## 제목 ##`).
        body.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "")
      : body
  )
    .replace(/^(?:>\s?)+/, "")
    // A checklist's boxes are drawn, not typed: ☐ and ☑ are what a chat box can show.
    .replace(/^[-*+]\s+\[ \]\s+/, "☐ ")
    .replace(/^[-*+]\s+\[[xX]\]\s+/, "☑ ")
    .replace(/^[*+]\s+/, "- ");
  return `${indent}${unsheltered(withoutMarks(rest))}`.trimEnd();
}

/**
 * The answer's words: marks gone, shape kept.
 *
 * A TABLE IS FOUND THE WAY THE RENDERER FINDS IT: a line with a pipe in it, then the rule under it,
 * then every line until a blank one. Looking for `| … |` on each line alone missed the row a real
 * answer ended on — its closing pipe never arrived, the renderer drew the row all the same, and the
 * copied words kept that one line's pipes (pressed on the running app, on the first try of this).
 */
export function copiedText(markdown: string): string {
  const source = markdown.replace(/\r\n?/g, "\n").split("\n");
  const lines: string[] = [];
  /** The fence the code block in progress was opened with. */
  let fence: { mark: string; length: number } | null = null;
  let isTable = false;
  for (const [index, line] of source.entries()) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line)?.[1] ?? "";
      if (close.startsWith(fence.mark) && close.length >= fence.length) {
        fence = null;
      } else {
        // Code is copied as it was written, a shorter fence inside it included.
        lines.push(line);
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    // A backtick fence cannot carry a backtick after it: that is inline code, on a line of prose.
    if (open?.[1] && !(open[1].startsWith("`") && open[2]?.includes("`"))) {
      fence = { mark: open[1].charAt(0), length: open[1].length };
      isTable = false;
      continue;
    }
    if (isTable) {
      // Every line is a row until a blank one; the rule under the header is the only line dropped.
      if (line.trim() !== "") {
        if (!isTableHead(source[index - 1] ?? "", line)) {
          lines.push(tableRow(line));
        }
        continue;
      }
      isTable = false;
    }
    if (isTableHead(line, source[index + 1])) {
      lines.push(tableRow(line));
      isTable = true;
      continue;
    }
    // Under a line of words it makes that line a heading, and is not words itself.
    if (HEADING_UNDERLINE.test(line) && (source[index - 1] ?? "").trim()) {
      continue;
    }
    lines.push(plainLine(line));
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** What survives on an element copied out of the bubble. Everything else is ours, not the answer's. */
const KEPT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href"],
  img: ["src", "alt"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  ol: ["start"],
};

/**
 * The answer as drawn, for whatever pastes rich text. Null when there is nothing to hand over.
 *
 * Taken off the copy: our controls (the renderer puts copy and download buttons on every table and
 * code block), their icons, and every class, style and data attribute — a document should get a
 * table, not this app's colours.
 */
export function copiedHtml(body: Element | null | undefined): string | null {
  if (!body) return null;
  const copy = body.cloneNode(true) as Element;
  for (const extra of copy.querySelectorAll(
    'button, svg, [role="menu"], [aria-hidden="true"]',
  )) {
    extra.remove();
  }
  for (const element of copy.querySelectorAll("*")) {
    const kept = KEPT_ATTRIBUTES[element.tagName.toLowerCase()] ?? [];
    for (const name of element.getAttributeNames()) {
      if (!kept.includes(name)) element.removeAttribute(name);
    }
  }
  const html = copy.innerHTML.trim();
  return html ? html : null;
}
