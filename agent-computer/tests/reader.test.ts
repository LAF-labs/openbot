import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Browser, chromium } from "playwright";
import { compactText, type FrameRead, readerScript } from "../src/reader";

/**
 * The page's words, fewer characters (`reader.ts`). The folding is pure; the reader runs in a page,
 * so its half is asked of a real Chromium, skipped where none is downloaded.
 */

describe("compactText", () => {
  test("a weather card's one-word lines become one line", () => {
    // The shape Naver's weather search has in `innerText`, measured 2026-09-25.
    const raw = "12시\n흐림\n23\n°\n \n13시\n흐림\n25\n°\n \n";
    expect(compactText(raw)).toBe("12시 흐림 23 ° 13시 흐림 25 °");
  });

  test("a long line stands alone, and the short ones around it fold", () => {
    const sentence =
      "상반기엔 코스닥에서 시총 미달에 따른 상폐 상장사가 없었으나 하반기 들어 늘어났다.";
    expect(compactText(`경제\n금융\n${sentence}\n입력\n2026.09.25.`)).toBe(
      `경제 금융\n${sentence}\n입력 2026.09.25.`,
    );
  });

  test("blank lines, runs of spaces and a repeated line go; no word does", () => {
    const text = compactText(
      "서울특별시\n서울특별시\n\n\n  중구   을지로 기준  \n",
    );
    expect(text).toBe("서울특별시 중구 을지로 기준");
  });

  test("a folded line stops growing, so a long menu is several lines", () => {
    const menu = Array.from({ length: 60 }, (_, i) => `메뉴${i}`).join("\n");
    const lines = compactText(menu).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
    expect(compactText(menu).replace(/\s/g, "")).toBe(menu.replace(/\s/g, ""));
  });
});

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const PARAGRAPH =
  "지역 상권 조사에 따르면 올가을 골목 상권의 카드 결제액은 지난해 같은 기간보다 눈에 띄게 늘었고, 특히 음식점과 카페의 주말 매출이 크게 올랐다. 상인들은 날씨가 선선해지면서 나들이 손님이 늘어난 것을 가장 큰 이유로 꼽았다.";
const chrome = (count: number) =>
  `<nav>${Array.from({ length: count }, (_, i) => `<a href="/m${i}">메뉴항목${i}</a>`).join(" ")}</nav>`;
const story = (declare: string) =>
  `<!doctype html><html><head>${declare}<title>t</title></head><body>${chrome(60)}<div id="story"><h2>가을 매출</h2>${Array.from({ length: 6 }, () => `<p>${PARAGRAPH}</p>`).join("")}</div>${chrome(60)}</body></html>`;

describe.skipIf(!HAS_BROWSER)("the reader, in a page", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  async function read(html: string, whole = false): Promise<FrameRead> {
    const page = await browser.newPage();
    await page.setContent(html);
    const result = await page.evaluate<FrameRead>(readerScript(whole));
    // The page is left as it was: nothing the reader declared outlives the call.
    expect(
      await page.evaluate(
        () => "Readability" in window || "isProbablyReaderable" in window,
      ),
    ).toBe(false);
    await page.close();
    return result;
  }

  test("a page that says it is an article is read as its story", async () => {
    const result = await read(
      story('<meta property="og:type" content="article">'),
    );
    expect(result.reader).toBe(true);
    expect(result.text).toContain("가을 매출");
    expect(result.text).toContain("나들이 손님");
    expect(result.text).not.toContain("메뉴항목");
    // Paragraphs stay paragraphs.
    expect(result.text.split("\n").filter(Boolean).length).toBeGreaterThan(5);
  });

  test("the same page that does not say so is read whole", async () => {
    // Naver's weather search passed `isProbablyReaderable` and lost today's low and high to it.
    const result = await read(story(""));
    expect(result.reader).toBe(false);
    expect(result.text).toContain("메뉴항목");
  });

  test("asked for whole, an article is read whole", async () => {
    const result = await read(
      story('<meta property="og:type" content="article">'),
      true,
    );
    expect(result.reader).toBe(false);
    expect(result.text).toContain("메뉴항목");
  });

  test("an article that is nearly the whole page is not called one", async () => {
    // A Naver photo story: Readability kept 96 % of the page and called it the article.
    const bare = `<!doctype html><html><head><meta property="og:type" content="article"></head><body><div>${Array.from({ length: 6 }, () => `<p>${PARAGRAPH}</p>`).join("")}</div></body></html>`;
    const result = await read(bare);
    expect(result.reader).toBe(false);
    expect(result.text).toContain("나들이 손님");
  });
});
