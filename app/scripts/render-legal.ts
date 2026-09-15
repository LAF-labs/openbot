/**
 * The terms and the privacy policy, baked into static pages for the front door.
 *
 * Before somebody has an account there is no VM to read the documents on, and a trial's sign-up form
 * links to them (self-serve contract §4.1). So CI renders `app/src/legal/*.md` into the deploy bundle
 * (`.github/workflows/images.yml`, the `deploy` job), and the front door serves `/legal/terms`,
 * `/legal/privacy` and `/privacy.html` from `legal/` in the bundle of the channel it runs:
 *
 *     bun app/scripts/render-legal.ts deploy/legal
 *       → deploy/legal/terms.html, deploy/legal/privacy.html, deploy/legal/version
 *
 * `version` is one line: the version both documents carry, which is `LEGAL_VERSION`
 * (`server/tests/legal-version.test.ts` holds the three together). The front door records it beside a
 * sign-up's consent, and closes sign-up when the file is missing.
 *
 * WRITTEN HERE RATHER THAN TAKEN FROM A LIBRARY. The deploy job installs nothing — it builds an image
 * from `scratch` in seconds — and a markdown library's first job is passing HTML through, which on
 * a page on the product's own domain is a page that runs whatever the file says. This renders the
 * handful of shapes the two documents are written in (headings, paragraphs, lists, tables, bold,
 * inline code, links) and ESCAPES EVERYTHING ELSE: markup in a document arrives on the page as text.
 * A link goes only to a path on the same site, an https address, or a mailto.
 *
 * The in-app pages render the same files with Streamdown (`components/legal/legal-page.tsx`); these
 * pages are for the minutes before an account exists, and say the same words.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? "");
}

/** Where a document may send somebody: a path on this site, an https address, or a mail. */
function safeHref(target: string): string | null {
  if (target.startsWith("/") && !target.startsWith("//")) return target;
  if (/^https:\/\/[^\s]+$/i.test(target)) return target;
  if (/^mailto:[^\s]+$/i.test(target)) return target;
  return null;
}

/** Code, a link or bold — whichever comes first — and everything around them escaped. */
const INLINE = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*/;

function inline(text: string): string {
  let written = "";
  let rest = text;
  for (;;) {
    const found = INLINE.exec(rest);
    if (!found) return written + escapeHtml(rest);
    written += escapeHtml(rest.slice(0, found.index));
    const [whole, code, label, target, bold] = found;
    if (code !== undefined) {
      written += `<code>${escapeHtml(code)}</code>`;
    } else if (label !== undefined) {
      const href = safeHref(target ?? "");
      written += href
        ? `<a href="${escapeHtml(href)}">${inline(label)}</a>`
        : inline(label);
    } else {
      written += `<strong>${inline(bold ?? "")}</strong>`;
    }
    rest = rest.slice(found.index + whole.length);
  }
}

const HEADING = /^(#{1,6})\s+(.+)$/;
const BULLET = /^[-*]\s+(.+)$/;
const NUMBERED = /^\d+\.\s+(.+)$/;
const TABLE_RULE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const cellsOf = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

/**
 * A document's body as HTML: the note at its head for whoever replaces the file is dropped, and the
 * rest is the shapes above with every other character escaped.
 */
export function renderMarkdown(markdown: string): string {
  const source = markdown.trimStart().startsWith("<!--")
    ? markdown.slice(markdown.indexOf("-->") + 3)
    : markdown;
  const lines = source.split(/\r?\n/);
  const blocks: string[] = [];

  const startsBlock = (line: string, next: string | undefined) =>
    HEADING.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    (line.trimStart().startsWith("|") && TABLE_RULE.test(next ?? ""));

  for (let at = 0; at < lines.length; ) {
    const line = lines[at] ?? "";
    if (!line.trim()) {
      at += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      blocks.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      at += 1;
      continue;
    }

    if (
      line.trimStart().startsWith("|") &&
      TABLE_RULE.test(lines[at + 1] ?? "")
    ) {
      const head = cellsOf(line)
        .map((cell) => `<th>${inline(cell)}</th>`)
        .join("");
      const rows: string[] = [];
      at += 2;
      while (
        at < lines.length &&
        (lines[at] ?? "").trimStart().startsWith("|")
      ) {
        rows.push(
          `<tr>${cellsOf(lines[at] ?? "")
            .map((cell) => `<td>${inline(cell)}</td>`)
            .join("")}</tr>`,
        );
        at += 1;
      }
      blocks.push(
        `<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`,
      );
      continue;
    }

    const list = BULLET.test(line)
      ? { pattern: BULLET, tag: "ul" }
      : NUMBERED.test(line)
        ? { pattern: NUMBERED, tag: "ol" }
        : null;
    if (list) {
      const items: string[] = [];
      while (at < lines.length && list.pattern.test(lines[at] ?? "")) {
        const item = list.pattern.exec(lines[at] ?? "")?.[1] ?? "";
        items.push(`<li>${inline(item)}</li>`);
        at += 1;
      }
      blocks.push(`<${list.tag}>${items.join("")}</${list.tag}>`);
      continue;
    }

    const paragraph: string[] = [];
    while (
      at < lines.length &&
      (lines[at] ?? "").trim() &&
      (paragraph.length === 0 || !startsBlock(lines[at] ?? "", lines[at + 1]))
    ) {
      paragraph.push((lines[at] ?? "").trim());
      at += 1;
    }
    if (paragraph.length > 0) {
      blocks.push(`<p>${inline(paragraph.join(" "))}</p>`);
    }
  }
  return blocks.join("");
}

/** The version a document is agreed to at: the `버전 YYYY-MM-DD` line under its title. */
export function legalVersionOf(markdown: string): string | null {
  return /^버전 (\d{4}-\d{2}-\d{2})$/m.exec(markdown)?.[1] ?? null;
}

const titleOf = (markdown: string, fallback: string) =>
  /^# (.+)$/m.exec(markdown)?.[1]?.trim() ?? fallback;

/** A whole page around one document, readable without anything else from the product loaded. */
function page(markdown: string, fallbackTitle: string): string {
  const title = escapeHtml(titleOf(markdown, fallbackTitle));
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — LAF 에이전트</title>
<style>
:root { color-scheme: light dark; --fg: #1a1a1a; --muted: #6b6b6b; --bg: #ffffff; --line: #e2e2de; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --muted: #9a9a9a; --bg: #1e1e1e; --line: #333333; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", sans-serif; word-break: keep-all; }
main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 2rem; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 2.25rem 0 .5rem; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; margin: 1rem 0; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: .45rem .6rem; text-align: left; vertical-align: top; }
code { font-family: inherit; font-size: .95em; padding: 0 .3em; border-radius: .3em; background: color-mix(in srgb, var(--fg) 7%, transparent); }
a { color: inherit; }
footer { max-width: 44rem; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; color: var(--muted); font-size: .85rem; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<main>${renderMarkdown(markdown)}</main>
<footer><a href="/legal/terms">이용약관</a> · <a href="/legal/privacy">개인정보 처리방침</a></footer>
</body>
</html>
`;
}

/**
 * The three files the bundle carries, from the two documents — or a refusal to bake them.
 *
 * Refused when either document carries no version, or the two carry different ones: the front door
 * records ONE version beside a consent, and a page baked at a version nobody agreed to is the thing a
 * consent record must never point at.
 */
export function renderLegal(sources: { terms: string; privacy: string }): {
  "terms.html": string;
  "privacy.html": string;
  version: string;
} {
  const terms = legalVersionOf(sources.terms);
  const privacy = legalVersionOf(sources.privacy);
  if (!terms || !privacy) {
    throw new Error(
      `render-legal: a document carries no version line (terms ${terms ?? "none"}, privacy ${privacy ?? "none"}) — the "버전 YYYY-MM-DD" line under its title`,
    );
  }
  if (terms !== privacy) {
    throw new Error(
      `render-legal: the two documents carry different versions (terms ${terms}, privacy ${privacy}), and a consent records one`,
    );
  }
  return {
    "terms.html": page(sources.terms, "이용약관"),
    "privacy.html": page(sources.privacy, "개인정보 처리방침"),
    version: `${terms}\n`,
  };
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: bun app/scripts/render-legal.ts <out-dir>");
    process.exit(2);
  }
  const legal = join(import.meta.dir, "../src/legal");
  const baked = renderLegal({
    terms: readFileSync(join(legal, "terms.md"), "utf8"),
    privacy: readFileSync(join(legal, "privacy.md"), "utf8"),
  });
  mkdirSync(out, { recursive: true });
  for (const [file, contents] of Object.entries(baked)) {
    writeFileSync(join(out, file), contents);
  }
  console.log(
    `render-legal: ${Object.keys(baked).join(" · ")} at version ${baked.version.trim()} → ${out}`,
  );
}
