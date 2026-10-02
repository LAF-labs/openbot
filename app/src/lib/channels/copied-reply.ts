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
 */

/** A table's separator row: `|---|:--:|`. It draws a line and holds no words. */
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
/** A horizontal rule: three or more of one mark, alone on the line. */
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*(?:```|~~~)/;

/** A line's inline marks taken off, with what they held kept. A link keeps its address. */
function withoutMarks(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) =>
      label === href || String(href).startsWith("#")
        ? label
        : `${label} (${href})`,
    )
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, "$1")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(
      /(^|[^\p{L}\p{N}])[*_](?=\S)(.+?)(?<=\S)[*_](?![\p{L}\p{N}])/gu,
      "$1$2",
    );
}

/** A table's row, cell by cell, with a tab between: the one separator every paste target keeps. */
function tableRow(line: string): string {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => withoutMarks(cell.replace(/\\\|/g, "|")).trim())
    .join("\t");
}

function plainLine(line: string): string {
  if (RULE.test(line)) return "";
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const rest = line
    .slice(indent.length)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:>\s?)+/, "")
    // A checklist's boxes are drawn, not typed: ☐ and ☑ are what a chat box can show.
    .replace(/^[-*+]\s+\[ \]\s+/, "☐ ")
    .replace(/^[-*+]\s+\[[xX]\]\s+/, "☑ ")
    .replace(/^[*+]\s+/, "- ");
  return `${indent}${withoutMarks(rest)}`.trimEnd();
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
  let isCode = false;
  let isTable = false;
  for (const [index, line] of source.entries()) {
    if (isTable) {
      // Every line is a row until a blank one; the rule under the header is the only line dropped.
      if (line.trim() !== "") {
        if (!TABLE_RULE.test(line)) lines.push(tableRow(line));
        continue;
      }
      isTable = false;
    }
    if (FENCE.test(line)) {
      // The fence's own line opens or closes a block; the code inside it is copied as written.
      isCode = !isCode;
      continue;
    }
    if (isCode) {
      lines.push(line);
      continue;
    }
    if (TABLE_RULE.test(line)) continue;
    if (line.includes("|") && TABLE_RULE.test(source[index + 1] ?? "")) {
      lines.push(tableRow(line));
      isTable = true;
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
