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
 *  - WORDS (`text/plain`): paragraphs, list markers, a table's cells separated by tabs — which a
 *    spreadsheet takes into its cells and a chat box shows as columns — and code as it was written.
 *  - THE ANSWER AS DRAWN (`text/html`), with our own controls and styling taken off, so a table
 *    lands in a document as a table and bold as bold.
 *
 * BOTH ARE READ OFF THE BUBBLE ON SCREEN, NOT OUT OF THE MARKDOWN. The first two versions of this
 * took the marks off the markdown with a pass of their own, and each review found another place
 * where that pass and the renderer disagreed about what a mark is: a table whose rule has one
 * hyphen, a fence inside a longer fence, an escaped star, a star with spaces round it, an indented
 * code block, a reference link — seven in two rounds, every one true, and no end to them, because a
 * second reading of markdown is a second parser. What the renderer drew is the one reading there
 * is. The words are what it drew, read in order.
 */

/** What the renderer and this app put in a bubble that is not the answer. */
const NOT_THE_ANSWER = [
  "button",
  "svg",
  '[role="menu"]',
  '[aria-hidden="true"]',
  // A code block's language label and its copy/download buttons; an image's "not available".
  '[data-streamdown="code-block-header"]',
  '[data-streamdown="code-block-actions"]',
  '[data-streamdown="image-fallback"]',
].join(", ");

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

const tagOf = (element: Element) => element.tagName.toLowerCase();
const isElement = (node: Node): node is Element =>
  node.nodeType === ELEMENT_NODE;

/** Lines trimmed and runs of spaces closed up: what the page's own layout does to its text. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\xa0]+/g, " ").trim())
    .join("\n")
    .trim();
}

/** Code, line by line. The renderer draws each line as an element of its own, with no newline between. */
function codeOf(pre: Element): string {
  const code = pre.querySelector("code") ?? pre;
  const lines = [...code.childNodes];
  if (lines.length > 0 && lines.every(isElement)) {
    return lines.map((line) => line.textContent ?? "").join("\n");
  }
  return (code.textContent ?? "").replace(/\n$/, "");
}

/** What runs along a line: words, a link with its address, a picture's description, a line break. */
function inlineOf(node: Node): string {
  if (node.nodeType === TEXT_NODE) {
    return (node.textContent ?? "").replace(/\s+/g, " ");
  }
  if (!isElement(node) || node.matches(NOT_THE_ANSWER)) return "";
  const tag = tagOf(node);
  if (tag === "br") return "\n";
  if (tag === "img") return node.getAttribute("alt") ?? "";
  if (tag === "input") {
    if (node.getAttribute("type") !== "checkbox") return "";
    // A checklist's boxes are drawn, not typed: ☐ and ☑ are what a chat box can show.
    return (node as HTMLInputElement).checked || node.hasAttribute("checked")
      ? "☑"
      : "☐";
  }
  // Code keeps every character it has, spaces included.
  if (tag === "code") return node.textContent ?? "";
  if (tag === "pre") return `\n${codeOf(node)}\n`;
  const inner = [...node.childNodes].map(inlineOf).join("");
  if (tag === "p") return `${inner}\n`;
  if (tag === "a") {
    const label = inner.trim();
    const href = node.getAttribute("href") ?? "";
    // A chat box cannot hold an address behind a word, so the address goes beside it.
    return href && href !== label && !href.startsWith("#")
      ? `${label} (${href})`
      : label;
  }
  return inner;
}

/** A table, row by row, with a tab between cells: the one separator every paste target keeps. */
function tableOf(table: Element): string {
  return [...table.querySelectorAll("tr")]
    .map((row) =>
      [...row.children]
        .filter((cell) => ["th", "td"].includes(tagOf(cell)))
        .map((cell) => tidy(inlineOf(cell)).replace(/\n/g, " "))
        .join("\t"),
    )
    .join("\n");
}

/** A list, one item a line, a nested one indented under its item. */
function listOf(list: Element, depth: number): string {
  const first = Number.parseInt(list.getAttribute("start") ?? "1", 10) || 1;
  const isOrdered = tagOf(list) === "ol";
  const lines: string[] = [];
  let count = 0;
  for (const item of list.children) {
    if (tagOf(item) !== "li") continue;
    const nested: Element[] = [];
    let own = "";
    for (const child of item.childNodes) {
      if (isElement(child) && ["ul", "ol"].includes(tagOf(child))) {
        nested.push(child);
      } else {
        own += inlineOf(child);
      }
    }
    const words = tidy(own);
    // A checklist's box stands where the bullet would.
    const marker = /^[☐☑]/.test(words)
      ? ""
      : isOrdered
        ? `${first + count}. `
        : "- ";
    const indent = "  ".repeat(depth);
    const [head = "", ...rest] = words.split("\n");
    lines.push(`${indent}${marker}${head}`);
    // What follows in the same item hangs under its first line.
    for (const line of rest) {
      lines.push(`${indent}${" ".repeat(marker.length)}${line}`);
    }
    for (const inner of nested) lines.push(listOf(inner, depth + 1));
    count += 1;
  }
  return lines.join("\n");
}

/** The blocks under `element`, in order, each as its words. */
function blocksOf(element: Element, blocks: string[]): void {
  let running = "";
  const flush = () => {
    const words = tidy(running);
    if (words) blocks.push(words);
    running = "";
  };
  for (const child of element.childNodes) {
    if (!isElement(child)) {
      running += inlineOf(child);
      continue;
    }
    if (child.matches(NOT_THE_ANSWER)) continue;
    const tag = tagOf(child);
    if (/^(?:p|h[1-6])$/.test(tag)) {
      flush();
      blocks.push(tidy(inlineOf(child)));
    } else if (tag === "ul" || tag === "ol") {
      flush();
      blocks.push(listOf(child, 0));
    } else if (tag === "table") {
      flush();
      blocks.push(tableOf(child));
    } else if (tag === "pre") {
      flush();
      blocks.push(codeOf(child));
    } else if (tag === "hr") {
      flush();
    } else if (tag === "blockquote" || tag === "div" || tag === "section") {
      flush();
      blocksOf(child, blocks);
    } else {
      running += inlineOf(child);
    }
  }
  flush();
}

/** The answer's words, read off what was drawn: a blank line between blocks. */
export function copiedWords(body: Element): string {
  const blocks: string[] = [];
  blocksOf(body, blocks);
  return blocks.filter(Boolean).join("\n\n");
}

/** What survives on an element copied out of the bubble. Everything else is ours, not the answer's. */
const KEPT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href"],
  img: ["src", "alt"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  ol: ["start"],
  input: ["type", "checked", "disabled"],
};

/**
 * The answer as drawn, for whatever pastes rich text. Null when there is nothing to hand over.
 *
 * Taken off the copy: our controls (the renderer puts copy and download buttons on every table and
 * code block), their icons, and every class, style and data attribute — a document should get a
 * table, not this app's colours. One thing is put back: the renderer draws bold as a styled span,
 * which without its class is no longer bold, so it leaves here as `<strong>`.
 */
export function copiedHtml(body: Element | null | undefined): string | null {
  if (!body) return null;
  const copy = body.cloneNode(true) as Element;
  for (const extra of copy.querySelectorAll(NOT_THE_ANSWER)) extra.remove();
  for (const bold of copy.querySelectorAll('[data-streamdown="strong"]')) {
    const strong = bold.ownerDocument.createElement("strong");
    strong.append(...bold.childNodes);
    bold.replaceWith(strong);
  }
  // The renderer draws a line of code as an element with nothing between two of them.
  for (const code of copy.querySelectorAll("pre code")) {
    const lines = [...code.childNodes];
    if (lines.length > 1 && lines.every(isElement)) {
      for (const line of lines.slice(0, -1)) line.after("\n");
    }
  }
  for (const element of copy.querySelectorAll("*")) {
    const kept = KEPT_ATTRIBUTES[tagOf(element)] ?? [];
    for (const name of element.getAttributeNames()) {
      if (!kept.includes(name)) element.removeAttribute(name);
    }
  }
  const html = copy.innerHTML.trim();
  return html ? html : null;
}
