import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { existsSync } from "node:fs";
import { type Browser, chromium, type Page } from "playwright";
import { readSettledPageText } from "../src/page-text";
import {
  compactText,
  type FrameRead,
  parseFrameRead,
  readerScript,
  thrownInPage,
} from "../src/reader";
import {
  READER_BROKEN_TEXT,
  REPLACED_BUILTINS_SCRIPT,
  REPLACED_BUILTINS_TEXT,
} from "./fixture-site";

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

describe("parseFrameRead", () => {
  test("the flag, then the text", () => {
    expect(parseFrameRead("1제목\n본문")).toEqual({
      text: "제목\n본문",
      reader: true,
    });
    expect(parseFrameRead("0")).toEqual({ text: "", reader: false });
  });

  test("anything else is no answer, not an empty page", () => {
    // What every object came back as on 고용24.
    expect(parseFrameRead(undefined)).toBeUndefined();
    expect(parseFrameRead({ text: "x", reader: false })).toBeUndefined();
    expect(parseFrameRead("")).toBeUndefined();
    expect(parseFrameRead("x")).toBeUndefined();
  });

  test("a throw inside the page is said by a name from our list, never by the page's", () => {
    expect(thrownInPage("!TypeError")).toBe("TypeError");
    expect(thrownInPage("!")).toBe("other");
    // A page chooses what it throws: a name is as free a place for a person's text as a message.
    expect(thrownInPage("!홍길동 010-1234-5678")).toBe("other");
    // And it is not an answer, so the page is read plainly.
    expect(parseFrameRead("!TypeError")).toBeUndefined();
    expect(thrownInPage("0본문")).toBeUndefined();
    expect(thrownInPage(undefined)).toBeUndefined();
  });
});

/** What the reader wrote to the log while a test ran, each line as its fields. */
let warned: ReturnType<typeof spyOn<Console, "warn">>;
beforeEach(() => {
  warned = spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warned.mockRestore();
});
const fellBack = () =>
  warned.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("reader_fell_back"));

/**
 * A tab that is not a browser's: each `evaluate` asked of its document answers with the next of
 * `answers`, a string or nothing as the answer and an `Error` as the rejection. For what a real
 * Chromium cannot be made to do on request — a renderer that crashes mid-read.
 */
function tabAnswering(
  url: string,
  answers: readonly (string | undefined | Error)[],
): Page {
  const left = [...answers];
  const frame = {
    url: () => url,
    parentFrame: () => null,
    isDetached: () => false,
    evaluate: async () => {
      const next = left.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return {
    // The one question asked of the page itself: whether it has finished loading.
    evaluate: async () => "complete",
    isClosed: () => false,
    mainFrame: () => frame,
    frames: () => [frame],
  } as unknown as Page;
}

describe("what counts as the page's doing", () => {
  /*
   * A renderer that crashed is not closed and its frame is not detached, so a fallback that only
   * knew what a navigation, a detached frame and a closed tab look like answered it 200, empty,
   * "this page's scripts kept it from being read". It is the browser that failed.
   */
  for (const said of ["Page crashed", "Target crashed"]) {
    test(`"${said}" is the browser's failure, whichever question it lands on`, async () => {
      const crash = () => new Error(`frame.evaluate: ${said}`);
      await expect(
        readSettledPageText(tabAnswering("https://example.com/", [crash()])),
      ).rejects.toThrow(said);
      // And when the reader had already come back with nothing, and the plain read is what crashes.
      await expect(
        readSettledPageText(
          tabAnswering("https://example.com/", [undefined, crash()]),
        ),
      ).rejects.toThrow(said);
    });
  }

  test("a fallback leaves one line: the origin and a name, and nothing of the page", async () => {
    const read = await readSettledPageText(
      tabAnswering("https://www.work24.go.kr/cm/main.do?seq=12345#top", [
        "!홍길동 010-1234-5678",
        "0본문 바로가기",
      ]),
    );
    expect(read).toMatchObject({ text: "본문 바로가기", plain: true });
    const lines = fellBack();
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      level: "warn",
      event: "reader_fell_back",
      origin: "https://www.work24.go.kr",
      frame: "main",
      reason: "threw",
      error: "other",
    });
    for (const kept of ["홍길동", "010", "main.do", "12345", "본문"]) {
      expect(lines[0]).not.toContain(kept);
    }

    warned.mockClear();
    await readSettledPageText(
      tabAnswering("https://www.work24.go.kr/", [undefined, "0본문"]),
    );
    const silent = JSON.parse(fellBack()[0] as string);
    expect(silent.reason).toBe("no_answer");
    expect(silent).not.toHaveProperty("error");
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
const paragraphs = (count: number, text = PARAGRAPH) =>
  Array.from({ length: count }, () => `<p>${text}</p>`).join("");
const chrome = (count: number) =>
  `<nav>${Array.from({ length: count }, (_, i) => `<a href="/m${i}">메뉴항목${i}</a>`).join(" ")}</nav>`;
/** Over 1,500 characters around the story, so the reader has a page long enough to abridge. */
const story = (declare: string) =>
  `<!doctype html><html><head>${declare}<title>t</title></head><body>${chrome(80)}<div id="story"><h2>가을 매출</h2>${paragraphs(6)}</div>${chrome(80)}</body></html>`;
const OG_ARTICLE = '<meta property="og:type" content="article">';

/** 컬리's goods page, the shape it had when the reader handed back its footer (2026-10-04). */
const NOTICE = "해당 상품은 구매가 어려워, 인기 상품을 추천드려요!";
const LEGAL =
  "주식회사 예시상점은 통신판매중개자로서 통신판매의 당사자가 아니며, 입점 판매자가 등록한 상품정보 및 거래에 대한 책임은 각 판매자에게 있습니다. 고객님은 안전거래를 위해 현금 결제 시 저희 쇼핑몰에서 가입한 구매안전서비스를 이용하실 수 있습니다.";
const cards = (count: number) =>
  Array.from(
    { length: count },
    (_, i) =>
      `<article class="card"><a href="/g${i}"><span>국산콩 두부 ${i}호 500g</span> <b>3,200원</b></a></article>`,
  ).join("");
const shop = (cardCount: number) =>
  `<!doctype html><html lang="ko"><head><title>상품</title></head><body>${chrome(10)}<main><h2 class="notice">${NOTICE}</h2>${cards(cardCount)}</main><div class="company-info">${paragraphs(4, LEGAL)}</div></body></html>`;

/**
 * 연합뉴스's address for an article that is not there (2026-10-04): the template still says it is an
 * article, the notice is one line Readability drops, and what it keeps is the block holding a sign-up
 * promotion and the whole section menu — "- 정치 - 정치전체 - …", 97 % link text.
 */
const MISSING = "원하시는 페이지를 찾을 수 없습니다.";
const PROMO =
  "새로운 소식지를 만나세요. 회원이 되시면 관심 있는 분야의 기사를 먼저 받아 보고, 읽던 기사를 저장해 두었다가 어느 기기에서든 이어서 읽을 수 있습니다. 지금 가입하면 첫 달 혜택도 함께 드립니다.";
const sectionMenu = Array.from(
  { length: 24 },
  (_, row) =>
    `<li><a href="/s${row}">분야 ${row}</a><ul>${Array.from({ length: 8 }, (_, i) => `<li><a href="/s${row}-${i}">세부 분야 소식 ${row}-${i}</a></li>`).join("")}</ul></li>`,
).join("");
const missingArticle = `<!doctype html><html lang="ko"><head>${OG_ARTICLE}<title>뉴스</title></head><body><div class="error-banner"><h2>${MISSING}</h2></div><div class="gnb">${paragraphs(4, PROMO)}<ul>${sectionMenu}</ul></div><div class="related"><ul>${Array.from({ length: 120 }, (_, i) => `<li>함께 보면 좋은 콘텐츠 ${i}</li>`).join("")}</ul></div></body></html>`;

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
    const answer = await page.evaluate(readerScript(whole));
    // The page is left as it was: nothing the reader declared outlives the call.
    expect(
      await page.evaluate(
        () => "Readability" in window || "isProbablyReaderable" in window,
      ),
    ).toBe(false);
    await page.close();
    const result = parseFrameRead(answer);
    if (!result) throw new Error(`the reader answered ${String(answer)}`);
    return result;
  }

  test("a page that says it is an article is read as its story", async () => {
    const result = await read(story(OG_ARTICLE));
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
    const result = await read(story(OG_ARTICLE), true);
    expect(result.reader).toBe(false);
    expect(result.text).toContain("메뉴항목");
  });

  test("an article that is nearly the whole page is not called one", async () => {
    // A Naver photo story: Readability kept 96 % of the page and called it the article. Long enough
    // that the short-page rule is not what decides it.
    const bare = `<!doctype html><html><head>${OG_ARTICLE}</head><body><div>${paragraphs(14)}</div></body></html>`;
    const result = await read(bare);
    expect(result.reader).toBe(false);
    expect(result.text).toContain("나들이 손님");
  });

  test("a story inside the page's own <article> is still the article", async () => {
    // A Naver news page: the story in an `<article>`, the related stories in cards of their own.
    const related = Array.from(
      { length: 6 },
      (_, i) => `<article><a href="/r${i}">함께 볼만한 뉴스 ${i}</a></article>`,
    ).join("");
    const result = await read(
      `<!doctype html><html><head>${OG_ARTICLE}<title>t</title></head><body>${chrome(80)}<article id="story"><h2>가을 매출</h2>${paragraphs(6)}</article><aside>${related}</aside>${chrome(80)}</body></html>`,
    );
    expect(result.reader).toBe(true);
    expect(result.text).toContain("나들이 손님");
    expect(result.text).not.toContain("메뉴항목");
  });

  test("a short page is read whole, and its notice with it", async () => {
    // 컬리: under 1,500 characters, and Readability's pick was the company footer.
    const result = await read(shop(4));
    expect(result.reader).toBe(false);
    expect(result.text).toContain(NOTICE);
  });

  test("a footer is not the article of a page whose articles are its product cards", async () => {
    // 무신사, and 컬리 with more on the page: the cards make it "an article", the footer is the pick.
    const html = shop(70);
    const page = await browser.newPage();
    await page.setContent(html);
    const length = await page.evaluate(
      () => document.body.innerText.replace(/\s+/g, " ").trim().length,
    );
    await page.close();
    // Over the short-page line, so this is the `<article>` rule's case and not that one's.
    expect(length).toBeGreaterThan(1_500);
    const result = await read(html);
    expect(result.reader).toBe(false);
    expect(result.text).toContain(NOTICE);
  });

  test("a wall of links is not the article", async () => {
    const page = await browser.newPage();
    await page.setContent(missingArticle);
    const length = await page.evaluate(
      () => document.body.innerText.replace(/\s+/g, " ").trim().length,
    );
    await page.close();
    expect(length).toBeGreaterThan(1_500);
    const result = await read(missingArticle);
    expect(result.reader).toBe(false);
    expect(result.text).toContain(MISSING);
  });

  test("a story in a <div> beside <article> teaser cards is still the article", async () => {
    // A news page that says it is an article, keeps the story in a `<div>` and uses `<article>` for
    // the related stories. Held to the element, it was read whole: menus first, the cap after.
    const related = Array.from(
      { length: 6 },
      (_, i) => `<article><a href="/r${i}">함께 볼만한 뉴스 ${i}</a></article>`,
    ).join("");
    const result = await read(
      `<!doctype html><html><head>${OG_ARTICLE}<title>t</title></head><body>${chrome(80)}<div id="story"><h2>가을 매출</h2>${paragraphs(6)}</div><aside>${related}</aside>${chrome(80)}</body></html>`,
    );
    expect(result.reader).toBe(true);
    expect(result.text).toContain("나들이 손님");
    expect(result.text).not.toContain("메뉴항목");
    expect(result.text).not.toContain("함께 볼만한 뉴스");
  });
});

describe.skipIf(!HAS_BROWSER)("a page that breaks the reader", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  async function opened(html: string) {
    const page = await browser.newPage();
    await page.setContent(html);
    return page;
  }

  test("고용24's Map: the reader still answers, as itself", async () => {
    const page = await opened(
      `<!doctype html><html><head><script>${REPLACED_BUILTINS_SCRIPT}</script></head><body><h1>고용 안내</h1><p>${REPLACED_BUILTINS_TEXT}</p></body></html>`,
    );
    // The page does to Playwright what work24.go.kr did: an object comes back as nothing.
    expect(await page.evaluate(() => ({ a: 1 }))).toBeUndefined();
    const read = await readSettledPageText(page);
    expect(read.text).toContain(REPLACED_BUILTINS_TEXT);
    expect(read.plain).toBeUndefined();
    await page.close();
  });

  test("a reader that throws: the page's text, read plainly, and the fact", async () => {
    const page = await opened(
      `<!doctype html><html><head><script>document.querySelector = function () { throw new TypeError("주민번호 900101-1234567"); };</script></head><body><h1>${READER_BROKEN_TEXT}</h1>${paragraphs(14)}</body></html>`,
    );
    const read = await readSettledPageText(page);
    expect(read.plain).toBe(true);
    expect(read.reader).toBeUndefined();
    expect(read.text).toContain(READER_BROKEN_TEXT);
    // Caught in the page and said as an answer: the name, and none of what the page threw with it.
    const lines = fellBack();
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      reason: "threw",
      error: "TypeError",
      frame: "main",
    });
    expect(lines[0]).not.toContain("900101");
    expect(lines[0]).not.toContain(READER_BROKEN_TEXT);
    await page.close();
  });

  test("not even the plain text: empty, and the fact — not a failure", async () => {
    const page = await opened(
      `<!doctype html><html><head><script>Object.defineProperty(HTMLElement.prototype, "innerText", { get: function () { throw new Error("no"); } });</script></head><body><p>${PARAGRAPH}</p></body></html>`,
    );
    const read = await readSettledPageText(page);
    expect(read.plain).toBe(true);
    expect(read.text).toBe("");
    await page.close();
  });

  test("a frame that breaks the reader is merged plainly, and says nothing about the page", async () => {
    // An advertiser's frame is not the page: forty of them sit on 연합뉴스's article.
    const breaks = (script: string, body: string) =>
      `<iframe srcdoc='<!doctype html><html><head><script>${script}</script></head><body>${body}</body></html>'></iframe>`;
    const page = await opened(
      `<!doctype html><html><body><p>${PARAGRAPH}</p>${breaks(
        "document.querySelector = function () { throw new Error(1); };",
        `<h1>${READER_BROKEN_TEXT}</h1>${paragraphs(14)}`,
      )}${breaks(
        'Object.defineProperty(HTMLElement.prototype, "innerText", { get: function () { throw new Error(2); } });',
        "<p>읽히지 않는 프레임</p>",
      )}</body></html>`,
    );
    await page.waitForFunction(() => window.frames.length === 2);
    const read = await readSettledPageText(page);
    expect(read.plain).toBeUndefined();
    expect(read.text).toContain(READER_BROKEN_TEXT);
    expect(read.frames?.map((frame) => frame.code ?? "read")).toEqual([
      "read",
      "laf:frame_opaque",
    ]);
    await page.close();
  });
});
