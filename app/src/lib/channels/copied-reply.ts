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
  // Footnotes: the renderer's own heading over them, and the arrow back up from each.
  ".sr-only",
  '[data-footnotes] > [id$="footnote-label"]',
  "[data-footnote-backref]",
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

/**
 * Code, line by line. The renderer draws each line as an element of its own with no newline between
 * two of them — and a line with nothing on it as an element holding one newline, which read as it
 * stands made every empty line of code two (drawn and copied, 2026-10-02).
 */
const lineOf = (line: Element) => (line.textContent ?? "").replace(/\n$/, "");

function codeOf(pre: Element): string {
  const code = pre.querySelector("code") ?? pre;
  const lines = [...code.childNodes];
  if (lines.length > 0 && lines.every(isElement)) {
    return lines.map(lineOf).join("\n");
  }
  return (code.textContent ?? "").replace(/\n$/, "");
}

function urlOf(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * Where a link leads, the way somebody would write it down: a mail address or a number, without the
 * `mailto:` or `tel:` a browser needs in front and without what a mail link carries after `?`.
 */
function addressOf(href: string): string {
  const direct = /^(?:mailto|tel):([^?]*)/i.exec(href);
  if (!direct) return href;
  const written = direct[1] ?? "";
  try {
    return decodeURIComponent(written);
  } catch {
    return written;
  }
}

/**
 * Whether a link's words already are its address.
 *
 * The renderer links an address that is written out, and tidies it as it does: `https://example.com`
 * leads to `https://example.com/`, `www.example.org` to `http://www.example.org/`, a mail address
 * to `mailto:`. Compared as they are written the two were never the same, and every address the Bot
 * wrote out was copied twice — `https://example.com (https://example.com/)` (review, fourth round).
 * So they are compared as addresses: both read the way a browser reads one.
 */
function saysAddress(label: string, address: string): boolean {
  if (label === address) return true;
  const target = urlOf(address);
  if (!target) return false;
  const shown = urlOf(label);
  if (shown) return shown.href === target.href;
  // Written without `https://`, as `www.example.org` is: the same place all the same.
  return urlOf(`${target.protocol}//${label}`)?.href === target.href;
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
  // Raised text has no place in a chat box: a power is written with its caret. A footnote's number
  // is raised too, and is a reference — it says so itself, below.
  if (tag === "sup") {
    return node.querySelector("[data-footnote-ref]") ? inner : `^${inner}`;
  }
  if (tag === "a") {
    const label = inner.trim();
    // "올랐어요.1" reads as a number that belongs to the sentence.
    if (node.hasAttribute("data-footnote-ref")) return `[${label}]`;
    const address = addressOf(node.getAttribute("href") ?? "");
    // A chat box cannot hold an address behind a word, so the address goes beside it — unless the
    // word is the address already, or it leads nowhere outside this answer.
    return address && !address.startsWith("#") && !saysAddress(label, address)
      ? `${label} (${address})`
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

/**
 * A list, one item a line. What else an item holds — another paragraph, code, a table, a list of
 * its own — hangs under the item's words, each read the way it is read anywhere else.
 *
 * An item used to be read as one run of words with only a list inside it set apart, and the run was
 * tidied the way words are. Drawn and copied, 2026-10-02: code under a numbered step lost its
 * indentation, which in Python is the program, and a table under one came out as its cells run
 * together (`가나12`). Numbered steps with a block of code each are the shape a how-to answer takes.
 */
function listOf(list: Element): string {
  // Nought is where a list may start, so the fallback is for no number at all, not for a falsy one.
  const start = Number.parseInt(list.getAttribute("start") ?? "", 10);
  const first = Number.isNaN(start) ? 1 : start;
  const isOrdered = tagOf(list) === "ol";
  const lines: string[] = [];
  let count = 0;
  for (const item of list.children) {
    if (tagOf(item) !== "li") continue;
    const blocks: string[] = [];
    blocksOf(item, blocks);
    const [head = "", ...rest] = blocks.filter(Boolean).join("\n").split("\n");
    // A checklist's box stands where the bullet would.
    const isChecklist = /^[☐☑]/.test(head);
    const marker = isChecklist ? "" : isOrdered ? `${first + count}. ` : "- ";
    lines.push(`${marker}${head}`.trimEnd());
    // Under the item's words, not under its marker. A line that is empty stays empty.
    const hang = " ".repeat(isChecklist ? 2 : marker.length);
    for (const line of rest) lines.push(line ? `${hang}${line}` : "");
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
    if (/^(?:p|h[1-6]|summary)$/.test(tag)) {
      flush();
      blocks.push(tidy(inlineOf(child)));
    } else if (tag === "ul" || tag === "ol") {
      flush();
      blocks.push(listOf(child));
    } else if (tag === "table") {
      flush();
      blocks.push(tableOf(child));
    } else if (tag === "pre") {
      flush();
      blocks.push(codeOf(child));
    } else if (tag === "hr") {
      flush();
    } else if (["blockquote", "div", "section", "details"].includes(tag)) {
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
  // The renderer draws a line of code as an element with nothing between two of them, and an
  // empty line as an element holding a newline of its own. See `codeOf`.
  for (const code of copy.querySelectorAll("pre code")) {
    const lines = [...code.childNodes];
    if (lines.length > 1 && lines.every(isElement)) {
      for (const line of lines) {
        if (line.textContent === "\n") line.textContent = "";
      }
      for (const line of lines.slice(0, -1)) line.after("\n");
    }
  }
  for (const element of copy.querySelectorAll("*")) {
    const kept = KEPT_ATTRIBUTES[tagOf(element)] ?? [];
    for (const name of element.getAttributeNames()) {
      if (!kept.includes(name)) element.removeAttribute(name);
    }
    // A footnote's number points at a place in this bubble, which is not where it is going.
    if (element.getAttribute("href")?.startsWith("#")) {
      element.removeAttribute("href");
    }
  }
  const html = copy.innerHTML.trim();
  return html ? html : null;
}
