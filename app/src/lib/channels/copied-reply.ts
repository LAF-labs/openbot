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
 * BOTH ARE READ OFF THE ANSWER ON SCREEN, NOT OUT OF THE MARKDOWN — the element the transcript
 * still names `bubble-content`, though since 2026-10-04 an answer is drawn in no bubble
 * (`chat-transcript.tsx`). The first two versions of this took the marks off the markdown with a
 * pass of their own, and each review found another place where that pass and the renderer
 * disagreed about what a mark is: a table whose rule has one hyphen, a fence inside a longer
 * fence, an escaped star, a star with spaces round it, an indented code block, a reference link —
 * seven in two rounds, every one true, and no end to them, because a second reading of markdown is
 * a second parser. What the renderer drew is the one reading there is. The words are what it
 * drew, read in order.
 *
 * AND WHAT IT CAN DRAW IS A LIST WITH AN END. The renderer cleans what an answer writes as HTML and
 * lets through some fifty elements and a handful of attributes — a start and a value on a list, a
 * span on a cell — and nothing else. Reading them one finding at a time took four rounds of review
 * (a list from nought, a list of terms, an item's own number, …); `READ_ELEMENTS` is the whole
 * list, each read on purpose, and `copied-reply.test.tsx` draws every element HTML has to see that
 * none gets through that is not on it.
 */

/** What the renderer and this app put beside the words that is not the answer. */
export const NOT_THE_ANSWER = [
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

/**
 * Every element the renderer lets an answer draw, and how its words are read. Found by drawing each
 * element HTML has (the test does it again on every run): a renderer that lets a new one through
 * fails there, instead of having it read as if it were a `span`.
 */
const READ_AS = {
  /** Its own block or blocks, read like the answer's own. */
  container: ["blockquote", "details", "div", "section"],
  /** One block: the words that run along it. */
  line: ["h1", "h2", "h3", "h4", "h5", "h6", "p", "summary"],
  /** Read by the function named for it. */
  special: [
    ...["a", "br", "code", "hr", "img", "input", "pre", "q", "rt", "sup"],
    ...["del", "s", "strike"],
    ...["dd", "dl", "dt", "li", "ol", "ul"],
    ...["table", "tbody", "td", "tfoot", "th", "thead", "tr"],
  ],
  /** Words, where they stand. `rp` is the bracket a reading without ruby support falls back on. */
  inline: [
    ...["b", "em", "i", "ins", "kbd", "picture", "rp", "ruby", "samp"],
    ...["source", "span", "strong", "sub", "tt", "var"],
  ],
} as const;

export const READ_ELEMENTS: ReadonlySet<string> = new Set(
  Object.values(READ_AS).flat(),
);

const CONTAINERS: ReadonlySet<string> = new Set([...READ_AS.container, "dd"]);
// A term or an item standing by itself, outside its list, is still a line of its own.
const LINES: ReadonlySet<string> = new Set([...READ_AS.line, "dt", "li"]);
/** What is never part of the line it is found in. */
const STANDS_ALONE: ReadonlySet<string> = new Set([
  ...CONTAINERS,
  ...["dl", "ol", "table", "ul"],
]);
/** The renderer wraps a picture in a `div` and leaves it in its sentence. */
const PICTURE = '[data-streamdown="image-wrapper"]';

/** A whole number an attribute holds, or null where it holds none. Nought is a number. */
function numberOn(element: Element, attribute: string): number | null {
  const held = Number.parseInt(element.getAttribute(attribute) ?? "", 10);
  return Number.isNaN(held) ? null : held;
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
  // Whatever an answer wrote, the renderer draws a box that cannot be pressed: ☐ and ☑ are what a
  // chat box can show of one.
  if (tag === "input") {
    return (node as HTMLInputElement).checked || node.hasAttribute("checked")
      ? "☑"
      : "☐";
  }
  // Code keeps every character it has, spaces included.
  if (tag === "code") return node.textContent ?? "";
  if (tag === "pre") return `\n${codeOf(node)}\n`;
  // A block where a line was expected — a list in a cell, a table in a quotation's sentence — is
  // read as the block it is, on lines of its own.
  if (STANDS_ALONE.has(tag) && !node.matches(PICTURE)) {
    return `\n${linesOf(node.parentElement ?? node, node).join("\n")}\n`;
  }
  const inner = [...node.childNodes].map(inlineOf).join("");
  if (tag === "p") return `${inner}\n`;
  // Raised text has no place in a chat box: a power is written with its caret. A footnote's number
  // is raised too, and is a reference — it says so itself, below.
  if (tag === "sup") {
    return node.querySelector("[data-footnote-ref]") ? inner : `^${inner}`;
  }
  // Struck out is the one thing a chat box has to be told in marks: without them `~~어제~~ 오늘` reads
  // as both. Two tildes each side is how it is written where there is no line to draw.
  if (tag === "del" || tag === "s" || tag === "strike") {
    return inner.trim() ? `~~${inner}~~` : inner;
  }
  // The browser draws a quotation's marks; they are not in its text.
  if (tag === "q") return `“${inner}”`;
  // A reading drawn above what it reads stands beside it in brackets — the answer's own (`rp`)
  // where it wrote them.
  if (tag === "rt") {
    return node.parentElement?.querySelector("rp") ? inner : `(${inner})`;
  }
  if (tag === "a") {
    const label = inner.trim();
    // A link with no words draws nothing; a space where it stood is all that is left of it.
    if (!label) return inner ? " " : "";
    // "올랐어요.1" reads as a number that belongs to the sentence.
    if (node.hasAttribute("data-footnote-ref")) return `[${label}]`;
    const address = addressOf(node.getAttribute("href") ?? "");
    // A chat box cannot hold an address behind a word, so the address goes beside it — unless the
    // word is the address already, or it leads nowhere outside this answer.
    const said =
      address && !address.startsWith("#") && !saysAddress(label, address)
        ? `${label} (${address})`
        : label;
    // The space an answer left inside the link is still the space between its words.
    const [lead = ""] = /^\s*/.exec(inner) ?? [];
    const [trail = ""] = /\s*$/.exec(inner.slice(lead.length)) ?? [];
    return `${lead ? " " : ""}${said}${trail ? " " : ""}`;
  }
  return inner;
}

/** How many columns or rows a cell takes: one, unless it says more. Never nought, never a thousand. */
function spanOf(cell: Element, attribute: "colspan" | "rowspan"): number {
  return Math.min(Math.max(numberOn(cell, attribute) ?? 1, 1), 100);
}

/**
 * A table, row by row, with a tab between cells: the one separator every paste target keeps.
 *
 * A cell that spans is laid out the way it is drawn — the columns and rows it covers stay empty —
 * so what is under a column in the answer is under it in the spreadsheet.
 */
function tableOf(table: Element): string {
  const grid: (string | undefined)[][] = [];
  const rows = [...table.querySelectorAll("tr")].filter(
    (row) => row.closest("table") === table,
  );
  rows.forEach((row, at) => {
    let column = 0;
    for (const cell of row.children) {
      if (!["th", "td"].includes(tagOf(cell))) continue;
      const line = grid[at] ?? [];
      grid[at] = line;
      // Past whatever a cell from a row above reaches down into.
      while (line[column] !== undefined) column += 1;
      const words = linesOf(cell).join(" ");
      const across = spanOf(cell, "colspan");
      const down = spanOf(cell, "rowspan");
      for (let below = 0; below < down; below += 1) {
        const covered = grid[at + below] ?? [];
        grid[at + below] = covered;
        for (let beside = 0; beside < across; beside += 1) {
          covered[column + beside] = below === 0 && beside === 0 ? words : "";
        }
      }
      column += across;
    }
  });
  return Array.from(grid, (line) =>
    Array.from(line ?? [], (cell) => cell ?? "").join("\t"),
  ).join("\n");
}

/** Whether an item is one of a checklist: the renderer drew a box at its head. Not what it says. */
function hasBox(item: Element): boolean {
  const first = item.firstElementChild;
  if (!first) return false;
  if (tagOf(first) === "input") return true;
  // An item written with a blank line after it holds its words in a paragraph, box and all.
  const inside = tagOf(first) === "p" ? first.firstElementChild : null;
  return inside !== null && tagOf(inside) === "input";
}

/** `under` put in front of every line that has something on it. A line that is empty stays empty. */
function hung(lines: readonly string[], under: string): string[] {
  return lines.map((line) => (line ? `${under}${line}` : ""));
}

/** What an element holds — or the one child of it named — as lines: its blocks one under the other. */
function linesOf(element: Element, only?: Element): string[] {
  const blocks: string[] = [];
  blocksOf(element, blocks, only);
  return blocks.filter(Boolean).join("\n").split("\n");
}

/**
 * A list, one item a line. What else an item holds — another paragraph, code, a table, a list of
 * its own — hangs under the item's words, each read the way it is read anywhere else.
 *
 * An item used to be read as one run of words with only a list inside it set apart, and the run was
 * tidied the way words are. Drawn and copied, 2026-10-02: code under a numbered step lost its
 * indentation, which in Python is the program, and a table under one came out as its cells run
 * together (`가나12`). Numbered steps with a block of code each are the shape a how-to answer takes.
 *
 * Numbered the way it is drawn: from the list's start, nought included, and from an item's own
 * number where it says one.
 */
function listOf(list: Element): string {
  const isOrdered = tagOf(list) === "ol";
  let number = numberOn(list, "start") ?? 1;
  const lines: string[] = [];
  for (const item of list.children) {
    if (tagOf(item) !== "li") continue;
    number = numberOn(item, "value") ?? number;
    const [head = "", ...rest] = linesOf(item);
    // A checklist's box stands where the bullet would.
    const marker = hasBox(item) ? "" : isOrdered ? `${number}. ` : "- ";
    lines.push(`${marker}${head}`.trimEnd());
    // Under the item's words, not under its marker.
    lines.push(...hung(rest, " ".repeat(marker.length || 2)));
    number += 1;
  }
  return lines.join("\n");
}

/** A list of terms: each term on its line, and what it means under it. */
function termsOf(list: Element): string {
  const lines: string[] = [];
  for (const entry of list.children) {
    const tag = tagOf(entry);
    if (tag === "dt") lines.push(...linesOf(entry));
    else if (tag === "dd") lines.push(...hung(linesOf(entry), "  "));
    // An answer may group them in a `div`, as HTML allows.
    else if (tag === "div") lines.push(termsOf(entry));
  }
  return lines.filter(Boolean).join("\n");
}

/** The blocks under `element` — or the one child of it named — in order, each as its words. */
function blocksOf(element: Element, blocks: string[], only?: Element): void {
  let running = "";
  const flush = () => {
    const words = tidy(running);
    if (words) blocks.push(words);
    running = "";
  };
  for (const child of only ? [only] : element.childNodes) {
    if (!isElement(child)) {
      running += inlineOf(child);
      continue;
    }
    if (child.matches(NOT_THE_ANSWER)) continue;
    const tag = tagOf(child);
    if (LINES.has(tag)) {
      flush();
      blocks.push(tidy(inlineOf(child)));
    } else if (tag === "ul" || tag === "ol") {
      flush();
      blocks.push(listOf(child));
    } else if (tag === "dl") {
      flush();
      blocks.push(termsOf(child));
    } else if (tag === "table") {
      flush();
      blocks.push(tableOf(child));
    } else if (tag === "pre") {
      flush();
      blocks.push(codeOf(child));
    } else if (tag === "hr") {
      flush();
    } else if (CONTAINERS.has(tag) && !child.matches(PICTURE)) {
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

/** What survives on an element copied out of the answer. Everything else is ours, not the answer's. */
const KEPT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href"],
  img: ["src", "alt"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  ol: ["start"],
  li: ["value"],
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
    // A footnote's number points at a place in this answer, which is not where it is going.
    if (element.getAttribute("href")?.startsWith("#")) {
      element.removeAttribute("href");
    }
  }
  const html = copy.innerHTML.trim();
  return html ? html : null;
}
