/**
 * What a page says, in as few characters as still say it.
 *
 * Two things, both measured on the pages this product's owners read (2026-09-25, `bun run
 * eval:browse`):
 *
 * 1. **The article, when there is one.** A Naver news article's `innerText` is the portal's menus,
 *    the ranking box, the comments and the related-article rail around a few hundred characters of
 *    story, and the 6,000-character extract was mostly those. Firefox's Reader View solves exactly
 *    this, and its engine is published as `@mozilla/readability` (Apache-2.0,
 *    github.com/mozilla/readability): `isProbablyReaderable` decides whether a document has an
 *    article at all, and `Readability` takes it out. It runs inside the page, on a clone of the
 *    document, so the page the person is watching is never touched, and its source is injected per
 *    read inside a closure — nothing is left on `window` for a site to notice.
 *
 *    Pages without an article — a search result, a weather card, a shop listing — are read as
 *    before, because those are exactly the pages Reader View declines, and the one rule a Bot must
 *    be able to rely on is that a price box next to the story is not silently dropped: a page read
 *    as an article says so (`reader: true`), and `computer_read` with `whole` reads all of it.
 *
 * 2. **One line per thought, not per element.** `innerText` breaks at every block element, so a
 *    weather card arrives as `12시` / `흐림` / `23` / `°` on four lines with blank ones between —
 *    measured on Naver's weather search: most lines under five characters. {@link compactText}
 *    folds runs of short lines into one and drops the blank ones, which is what a person's eye does.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The published files, as the package ships them. Read once at start, injected per read. */
const READABILITY_SOURCE = readFileSync(
  require.resolve("@mozilla/readability/Readability.js"),
  "utf8",
);
const READERABLE_SOURCE = readFileSync(
  require.resolve("@mozilla/readability/Readability-readerable.js"),
  "utf8",
);

/** What a frame hands back. `reader` when the text is the article Readability took out. */
export type FrameRead = { text: string; reader: boolean };

/**
 * An article shorter than this is not trusted to be the page: Readability on a listing can find a
 * "main" block of two sentences, and answering from that is worse than reading the whole page.
 */
const ARTICLE_MIN_CHARS = 280;

/**
 * Runs in the page. Written as a function so the type checker reads it, and shipped as its source.
 *
 * The article's blocks become lines by walking its element tree: a detached element has no layout,
 * so `innerText` on it is `textContent`, which runs paragraphs together.
 */
function readInPage(
  Readability: new (
    document: Document,
    options: Record<string, unknown>,
  ) => { parse(): { title?: string; content?: unknown } | null },
  isProbablyReaderable: (
    document: Document,
    options: { minContentLength: number },
  ) => boolean,
  whole: boolean,
  minChars: number,
): FrameRead {
  const body = document.body;
  if (!body) return { text: "", reader: false };
  const everything = body.innerText ?? "";
  /*
   * AN ARTICLE ONLY WHERE THE PAGE SAYS IT IS ONE. `isProbablyReaderable` alone said yes to Naver's
   * weather search (measured 2026-09-25), and Readability then took the ten-day outlook as "the
   * article" and dropped today's low and high — the answer. A page that publishes itself as an
   * article (Open Graph's `og:type`, schema.org's `*Article`/`BlogPosting`, an `<article>` element)
   * is one a reader view is for; a search result is not, whatever its paragraphs look like.
   */
  const ogType =
    document
      .querySelector('meta[property="og:type"]')
      ?.getAttribute("content") ?? "";
  const declared =
    /article/i.test(ogType) ||
    document.querySelector("article") !== null ||
    Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    ).some((script) =>
      /"@type"\s*:\s*"(\w*Article|BlogPosting)"/.test(script.textContent ?? ""),
    );
  /*
   * HALF THE PARAGRAPH, IN HANGUL. The check counts a paragraph of 140 characters or more, a length
   * tuned on Latin text; a Korean sentence says in 60 characters what an English one says in 140,
   * and a news paragraph of 120 was not counted at all (measured on the fixture's story).
   */
  if (
    whole ||
    !declared ||
    !isProbablyReaderable(document, { minContentLength: 70 })
  ) {
    return { text: everything, reader: false };
  }
  let article: { title?: string; content?: unknown } | null = null;
  try {
    article = new Readability(document.cloneNode(true) as Document, {
      serializer: (element: Element) => element,
    }).parse();
  } catch {
    article = null;
  }
  const root = article?.content;
  if (!(root instanceof Element)) return { text: everything, reader: false };
  const BLOCK =
    /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|OL|P|PRE|SECTION|TABLE|TD|TH|TR|UL)$/;
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out.push((node.textContent ?? "").replace(/\s+/g, " "));
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === "BR") {
      out.push("\n");
      return;
    }
    const block = BLOCK.test(node.tagName);
    if (block) out.push("\n");
    if (node.tagName === "LI") out.push("- ");
    for (const child of Array.from(node.childNodes)) walk(child);
    if (block) out.push("\n");
  };
  walk(root);
  const text = out.join("");
  const kept = text.replace(/\s+/g, "").length;
  /*
   * Too short to be the page, or nearly all of it. The second is Readability failing rather than
   * succeeding: on a Naver photo story with no body it kept the portal's menus and the ranking box,
   * 96 % of the page, and called that the article (measured 2026-09-25). Nothing is gained by it
   * and the page would be marked abridged when it is not.
   */
  if (kept < minChars || kept > 0.8 * everything.replace(/\s+/g, "").length) {
    return { text: everything, reader: false };
  }
  const title = (article?.title ?? "").trim();
  return { text: title ? `${title}\n${text}` : text, reader: true };
}

/**
 * The expression `frame.evaluate` runs: the two published files inside a closure, then the reader.
 *
 * `module` is shadowed so the files' CommonJS tail (`if (typeof module === "object")`) does nothing,
 * and nothing they declare outlives the call.
 */
export function readerScript(whole: boolean): string {
  return `(() => { var module = undefined;\n${READABILITY_SOURCE}\n${READERABLE_SOURCE}\nreturn (${readInPage.toString()})(Readability, isProbablyReaderable, ${whole ? "true" : "false"}, ${ARTICLE_MIN_CHARS}); })()`;
}

/** A line this short is a fragment of the one around it — a label, a unit, a menu item. */
const SHORT_LINE = 24;
/** And a folded line stops growing here, so a long menu is several lines rather than one wall. */
const FOLDED_LINE = 120;

/**
 * Blank lines out, repeated lines out, runs of short lines folded into one.
 *
 * Nothing is reworded and nothing but whitespace and an immediate repeat is dropped: the model reads
 * every word the page showed, in the order it showed them.
 */
export function compactText(text: string): string {
  const lines = text
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\r]+/g, " ").trim())
    .filter(Boolean);
  const out: string[] = [];
  let run = "";
  let previous = "";
  const flush = () => {
    if (run) out.push(run);
    run = "";
  };
  for (const line of lines) {
    if (line === previous) continue;
    previous = line;
    if (line.length > SHORT_LINE) {
      flush();
      out.push(line);
      continue;
    }
    if (run && run.length + 1 + line.length > FOLDED_LINE) flush();
    run = run ? `${run} ${line}` : line;
  }
  flush();
  return out.join("\n");
}
