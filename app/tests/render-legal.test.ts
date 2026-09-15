import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  legalVersionOf,
  renderLegal,
  renderMarkdown,
} from "../scripts/render-legal";

/**
 * The two documents as the front door serves them: static HTML baked from the same markdown.
 *
 * Before an account exists the documents cannot come from a customer's VM — there is no VM yet —
 * so `images.yml` renders `app/src/legal/*.md` into the deploy bundle and the front door serves
 * `/legal/terms`, `/legal/privacy` and `/privacy.html` from it (self-serve contract §4.1, §14 W5).
 *
 * A renderer written here rather than a dependency, which makes escaping this file's job and not a
 * library's default: the output is a page on the product's own domain, and a document that could
 * carry markup through would be a page that runs whatever the file says. So every construct the
 * documents use is checked with markup in it, and the real files are rendered whole.
 */

const LEGAL = join(import.meta.dir, "../src/legal");
const read = (file: string) => readFileSync(join(LEGAL, file), "utf8");

const HOSTILE = `<img src=x onerror="alert(1)"> & 'quoted'`;

describe("nothing in a document becomes markup", () => {
  test("in a paragraph", () => {
    const html = renderMarkdown(`${HOSTILE}\n`);
    expect(html).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quoted&#39;</p>",
    );
  });

  test("in a heading, a list, a table, bold and code", () => {
    const html = renderMarkdown(
      [
        `## ${HOSTILE}`,
        "",
        `- ${HOSTILE}`,
        `1. ${HOSTILE}`,
        "",
        "| 항목 | 내용 |",
        "|---|---|",
        `| **<b>굵게</b>** | \`<script>\` |`,
      ].join("\n"),
    );
    expect(html).not.toMatch(/<(img|script|b)[\s>]/);
    expect(html).toContain("<h2>&lt;img src=x");
    expect(html).toContain("<li>&lt;img src=x");
    expect(html).toContain("<strong>&lt;b&gt;굵게&lt;/b&gt;</strong>");
    expect(html).toContain("<code>&lt;script&gt;</code>");
  });

  test("a link goes only somewhere a document may send somebody", () => {
    expect(renderMarkdown("[처리방침](/legal/privacy)")).toBe(
      '<p><a href="/legal/privacy">처리방침</a></p>',
    );
    expect(renderMarkdown("[문의](mailto:help@laf.test)")).toContain(
      '<a href="mailto:help@laf.test">',
    );
    expect(renderMarkdown("[문서](https://laf.test/a?b=1&c=2)")).toContain(
      '<a href="https://laf.test/a?b=1&amp;c=2">',
    );
    for (const target of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "//evil.example/x",
      "vbscript:x",
    ]) {
      const html = renderMarkdown(`[눌러](${target})`);
      expect([target, html.includes("<a ")]).toEqual([target, false]);
      expect(html).not.toContain("<b>");
    }
  });

  test("a quote in a link cannot leave its attribute", () => {
    const html = renderMarkdown('[x](/legal/a"onmouseover="alert(1))');
    expect(html).not.toMatch(/"\s*onmouseover=/);
  });

  test("the note at the head of the file, for whoever replaces it, is not on the page", () => {
    const html = renderMarkdown(
      "<!--\n  법률 자문 전 초안 — 자문 후 이 파일만 교체.\n-->\n\n# 이용약관\n",
    );
    expect(html).toBe("<h1>이용약관</h1>");
  });
});

describe("the shapes the documents are written in", () => {
  test("a table", () => {
    expect(
      renderMarkdown("| 회사 | 하는 일 |\n|---|---|\n| 솔라피 | 알림톡 |\n"),
    ).toBe(
      "<table><thead><tr><th>회사</th><th>하는 일</th></tr></thead><tbody><tr><td>솔라피</td><td>알림톡</td></tr></tbody></table>",
    );
  });

  test("lists, numbered and not", () => {
    expect(renderMarkdown("- 하나\n- 둘\n\n1. 첫째\n2. 둘째\n")).toBe(
      "<ul><li>하나</li><li>둘</li></ul><ol><li>첫째</li><li>둘째</li></ol>",
    );
  });
});

describe("the version the pages are baked at", () => {
  test("is the line under the title, and both documents must carry the same one", () => {
    expect(legalVersionOf(read("terms.md"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(legalVersionOf(read("terms.md"))).toBe(
      legalVersionOf(read("privacy.md")),
    );
    expect(() =>
      renderLegal({
        terms: "# 이용약관\n\n버전 2026-09-06\n",
        privacy: "# 개인정보 처리방침\n\n버전 2026-10-01\n",
      }),
    ).toThrow("version");
    expect(() =>
      renderLegal({
        terms: "# 이용약관\n\n본문\n",
        privacy: "# 개인정보 처리방침\n\n버전 2026-09-06\n",
      }),
    ).toThrow("version");
  });
});

describe("the documents this repository ships", () => {
  const baked = renderLegal({
    terms: read("terms.md"),
    privacy: read("privacy.md"),
  });

  test("are whole pages in Korean, titled, with the version file beside them", () => {
    const version = legalVersionOf(read("terms.md"));
    expect(baked.version).toBe(`${version}\n`);
    for (const [file, title] of [
      ["terms.html", "이용약관"],
      ["privacy.html", "개인정보 처리방침"],
    ] as const) {
      const page = baked[file];
      expect(page.startsWith("<!doctype html>")).toBe(true);
      expect(page).toContain('<html lang="ko">');
      expect(page).toContain(`<title>${title}`);
      expect(page).toContain(`버전 ${version}`);
      expect(page).not.toContain("<!--");
      expect(page).not.toContain("법률 자문 전 초안");
    }
  });

  test("keep every section heading the markdown has", () => {
    for (const [source, file] of [
      ["terms.md", "terms.html"],
      ["privacy.md", "privacy.html"],
    ] as const) {
      const sections = read(source).match(/^## /gm)?.length ?? 0;
      expect(sections).toBeGreaterThan(5);
      expect(baked[file].match(/<h2>/g)?.length).toBe(sections);
    }
  });

  test("link to each other where the markdown does", () => {
    expect(baked["terms.html"]).toContain('<a href="/legal/privacy">');
  });

  test("are written to the directory the image build copies, by the command images.yml runs", async () => {
    const out = mkdtempSync(join(tmpdir(), "legal-"));
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "../scripts/render-legal.ts"), out],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    expect(readdirSync(out).sort()).toEqual([
      "privacy.html",
      "terms.html",
      "version",
    ]);
    expect(readFileSync(join(out, "terms.html"), "utf8")).toBe(
      baked["terms.html"],
    );
  });
});
