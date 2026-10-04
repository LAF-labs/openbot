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

/** When an extract is not trusted to be the page, and the page is read whole instead. */
type ArticleLimits = {
  /**
   * An article shorter than this is not trusted to be the page: Readability on a listing can find a
   * "main" block of two sentences, and answering from that is worse than reading the whole page.
   */
  minChars: number;
  /**
   * A page with less to say than this is read whole, article or not.
   *
   * THE NOTICE IS THE PAGE. Measured 2026-10-04 on the labelled set (`evals/page-facts`): 69 of its
   * 80 pages that are not what they were opened for — "해당 상품은 구매가 어려워", "원하시는 페이지를
   * 찾을 수 없습니다" — are 1,500 characters or less, and on 컬리's goods page Readability took the
   * footer as the article and the notice was nowhere in what the Bot read. Abridging a page this
   * short saves the model under 1,500 characters; what it can lose is the one sentence that answers.
   * No real article in the set has a page this short around it: the shortest is 1,869 (정책브리핑).
   */
  shortPage: number;
  /**
   * An extract whose words are mostly link text is a menu, not a story.
   *
   * Measured on the set: 연합뉴스's not-found page under an article address handed back the section
   * menu as the article (97 % link text), and the homes of 정책브리핑, 부산, 강남구 and 한겨레 a list of
   * links (87–100 %). The densest real article was 정책브리핑's press release at 46 %, Wikipedia's
   * pages 12–36 %.
   */
  maxLinkShare: number;
  /**
   * On a page whose only claim to an article is an `<article>` element, the extract must come from
   * inside one.
   *
   * A shop puts each product card in an `<article>`, so the element says there is an article somewhere
   * on the page, not that Readability's pick is it. Measured on the set: 무신사's and Zillow's homes
   * and 컬리's goods page came back as their legal footers (0 % of it inside any `<article>`),
   * Spiegel's and 삼성's homes as a teaser block (3–5 %); every real article whose page had the
   * element was 89–100 % inside it (네이버 뉴스, 연합뉴스, Cloudflare, Google's documentation).
   *
   * ONLY WHERE THE ELEMENT IS ALL THE PAGE SAYS. A news page that calls itself an article
   * (`og:type`, JSON-LD) and keeps its story in a `<div>`, with `<article>` for the related-story
   * cards beside it, is not held to this: its story would be read whole — the menus first, cut at
   * the cap, the problem the reader exists for. Every page above that only this rule declined says
   * nothing of itself but the element (`og:type` "website" or none, no JSON-LD article); on a page
   * that does say so the rule never decided anything in the set (연합뉴스's missing article is 97 %
   * links). What the extract looks like could not stand in for that: Zillow's footer is 1,249
   * characters, 80 % of them in long lines, in paragraphs, with no heading — longer and more like a
   * story than four of the set's twelve real articles (433 to 619 characters).
   */
  minInsideShare: number;
};

const ARTICLE_LIMITS: ArticleLimits = {
  minChars: 280,
  shortPage: 1_500,
  maxLinkShare: 0.8,
  minInsideShare: 0.5,
};

/**
 * Runs in the page. Written as a function so the type checker reads it, and shipped as its source.
 *
 * The article's blocks become lines by walking its element tree: a detached element has no layout,
 * so `innerText` on it is `textContent`, which runs paragraphs together.
 *
 * IT ANSWERS WITH A STRING, NEVER AN OBJECT: the flag, then the text ({@link parseFrameRead}).
 * Playwright turns an object into what crosses the wire with a serialiser it runs inside the page,
 * and that serialiser builds its bookkeeping with the page's own global `Map`. 고용24 (work24.go.kr,
 * and ei.go.kr, which lands there) replaces `Map` with a Java-style one — `put`, `get`,
 * `containsKey`, no `set` — so every object any `evaluate` returned there came back `undefined`, and
 * `/navigate` failed on the page with `undefined is not an object (evaluating 'main.read.text')`
 * (measured 2026-10-04, 2 of 2 on each address). A string is handed back before that bookkeeping is
 * used.
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
  limits: ArticleLimits,
): string {
  const body = document.body;
  if (!body) return "0";
  const everything = body.innerText ?? "";
  const plainly = `0${everything}`;
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
  // What the document says of itself, apart from what one of its elements is called.
  const saysSo =
    /article/i.test(ogType) ||
    Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    ).some((script) =>
      /"@type"\s*:\s*"(\w*Article|BlogPosting)"/.test(script.textContent ?? ""),
    );
  const marked = Array.from(document.querySelectorAll("article"));
  const declared = saysSo || marked.length > 0;
  /*
   * HALF THE PARAGRAPH, IN HANGUL. The check counts a paragraph of 140 characters or more, a length
   * tuned on Latin text; a Korean sentence says in 60 characters what an English one says in 140,
   * and a news paragraph of 120 was not counted at all (measured on the fixture's story).
   */
  if (
    whole ||
    everything.replace(/\s+/g, " ").trim().length < limits.shortPage ||
    !declared ||
    !isProbablyReaderable(document, { minContentLength: 70 })
  ) {
    return plainly;
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
  if (!(root instanceof Element)) return plainly;
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
  const squeeze = (value: string) => value.replace(/\s+/g, "");
  const kept = squeeze(text).length;
  /*
   * Too short to be the page, or nearly all of it. The second is Readability failing rather than
   * succeeding: on a Naver photo story with no body it kept the portal's menus and the ranking box,
   * 96 % of the page, and called that the article (measured 2026-09-25). Nothing is gained by it
   * and the page would be marked abridged when it is not.
   */
  if (kept < limits.minChars || kept > 0.8 * squeeze(everything).length) {
    return plainly;
  }
  // A menu (`maxLinkShare`). Against the extract's own words, not the walk's, which adds a "- " per item.
  let linked = 0;
  for (const link of Array.from(root.querySelectorAll("a"))) {
    linked += squeeze(link.textContent ?? "").length;
  }
  if (linked >= limits.maxLinkShare * squeeze(root.textContent ?? "").length) {
    return plainly;
  }
  /*
   * Not from the `<article>` that is all the page calls an article (`minInsideShare`). Compared line
   * by line, by text: the extract is a clone's, re-parented by Readability, so where it sat in the
   * page is gone and what it says is all there is to compare. `textContent` rather than `innerText`
   * on the page's side, because the clone keeps text a style sheet hides and the comparison must not
   * count that against a real article.
   */
  if (!saysSo) {
    const inside = squeeze(
      marked.map((element) => element.textContent ?? "").join(""),
    );
    let total = 0;
    let found = 0;
    for (const line of text.split("\n")) {
      const words = squeeze(line.replace(/^\s*- /, ""));
      if (words.length < 4) continue;
      total += words.length;
      if (inside.includes(words)) found += words.length;
    }
    if (total > 0 && found < limits.minInsideShare * total) return plainly;
  }
  const title = (article?.title ?? "").trim();
  return `1${title ? `${title}\n${text}` : text}`;
}

/**
 * What {@link readerScript} answered, or nothing when it is not an answer the reader gives.
 *
 * Nothing is what a page that breaks `evaluate` itself produces, or one whose own JavaScript threw
 * inside the reader ({@link thrownInPage}), and the caller reads the page plainly then
 * (`page-text.ts`) rather than taking a missing answer for an empty page.
 */
export function parseFrameRead(value: unknown): FrameRead | undefined {
  if (typeof value !== "string") return undefined;
  const flag = value.charAt(0);
  if (flag !== "0" && flag !== "1") return undefined;
  return { text: value.slice(1), reader: flag === "1" };
}

/**
 * How a script says the page's own JavaScript threw inside it: `!`, then the error's name.
 *
 * CAUGHT IN THE PAGE, SO THAT NOTHING ELSE CAN PASS FOR IT. The first version let `evaluate` reject
 * and took every rejection that was not a navigation, a detached frame or a closed tab for the
 * page's doing — and a renderer that crashed is none of the three (`Target crashed`, with the page
 * not closed and the frame not detached), so a crashed tab was answered 200, empty, "this page's
 * scripts kept it from being read". Naming what is NOT the page's doing can never be complete. A
 * throw inside the page is caught there and comes back as an answer; a rejection is then always the
 * browser's — a crash, a closed target, a protocol error, a page that left — and is thrown on as it
 * was before there was a fallback.
 */
const CAUGHT_IN_PAGE =
  'catch (error) { var name = ""; try { name = "" + error.name; } catch (unnamed) {} return "!" + name; }';

/** The names an error is logged by. Anything else a page throws is `other`: its name is its own text. */
const ERROR_NAMES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "InternalError",
  "DOMException",
  "SecurityError",
  "NotSupportedError",
  "InvalidStateError",
]);

/**
 * The name of what the page's own JavaScript threw inside a script of ours, or nothing when the
 * answer does not say it threw. One of {@link ERROR_NAMES} or `other`, never the page's own string:
 * a page chooses what it throws, and a name is as free a place to put a person's text as a message.
 */
export function thrownInPage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.charAt(0) !== "!") return undefined;
  const name = value.slice(1);
  return ERROR_NAMES.has(name) ? name : "other";
}

/**
 * The expression `frame.evaluate` runs: the two published files inside a closure, then the reader.
 *
 * `module` is shadowed so the files' CommonJS tail (`if (typeof module === "object")`) does nothing,
 * and nothing they declare outlives the call. The limits are written into the source rather than
 * passed as an argument, which Playwright would carry in with the same `Map` it carries answers out
 * with (`readInPage`). The closure sits inside the `try`, as a function of its own, so the files
 * stay at the top of a function body as they were written to be.
 */
export function readerScript(whole: boolean): string {
  return `(() => { try { return (() => { var module = undefined;\n${READABILITY_SOURCE}\n${READERABLE_SOURCE}\nreturn (${readInPage.toString()})(Readability, isProbablyReaderable, ${whole ? "true" : "false"}, ${JSON.stringify(ARTICLE_LIMITS)}); })(); } ${CAUGHT_IN_PAGE} })()`;
}

/**
 * The page's visible text and nothing else, for a page whose scripts stopped the reader
 * (`page-text.ts`): the reader's own `0`, then the text. As small as a question to a page can be, so
 * that whatever broke the reader has as little as possible left to break.
 */
export const PLAIN_TEXT_SCRIPT = `(() => { try { var body = document.body; return "0" + (body ? body.innerText : ""); } ${CAUGHT_IN_PAGE} })()`;

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
