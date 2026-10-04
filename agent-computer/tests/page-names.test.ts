import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Browser, chromium, type Page } from "playwright";
import { readAriaSnapshot } from "../src/aria-snapshot";
import { holdToLabel } from "../src/label-hold";
import { namesFromThePage } from "../src/page-names";

/**
 * The name the page gives a control the tree left nameless, against the role engine the hold asks.
 *
 * Every case is a shape met on a real page or in Playwright's own name function, and every case is
 * asserted twice: the name the list will show, and that the hold (`label-hold.ts`) finds the control
 * still called exactly that — which is the whole point of computing it. A name that is right but
 * that the role engine spells differently is a refused click, so the second assertion is the one
 * that matters.
 *
 * Skipped where Playwright has no browser downloaded.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

let browser: Browser | null = null;

beforeAll(async () => {
  if (HAS_BROWSER) browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

/** 1×1 PNG: an image has to be drawn to be given a ref. */
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** Each case: the markup of one control, and the name the browser gives it. */
const CASES: [string, string][] = [
  [
    `<a href="/a"><span aria-hidden="true">★</span><strong>Headline</strong></a>`,
    "Headline",
  ],
  [
    `<a href="/b"><mark>무선</mark>마우스 <strong>특가</strong></a>`,
    "무선마우스 특가",
  ],
  [`<a href="/c"><div>첫 줄</div><div>둘째 줄</div></a>`, "첫 줄 둘째 줄"],
  [`<a href="/d"><strong>A</strong><br><em>B</em></a>`, "A B"],
  [
    `<a href="/e"><img src="${PIXEL}" width="20" height="20" alt="로고"><b>뉴스</b></a>`,
    "로고뉴스",
  ],
  [
    `<a href="/f"><table><caption class="blind">10월 캘린더</caption><tr><td><b>1</b></td></tr></table></a>`,
    "10월 캘린더",
  ],
  [
    `<a href="/g"><strong>코스피</strong> <em><span class="blind">현재가</span>7,003.74</em></a>`,
    "코스피 현재가7,003.74",
  ],
  [
    `<a href="/h"><span style="display:none">숨김</span><strong>보임</strong></a>`,
    "보임",
  ],
  [
    `<a href="/i"><span style="visibility:hidden">숨김</span><strong>보임</strong></a>`,
    "보임",
  ],
  [`<a href="/j"><i class="dot"></i>뉴스<i class="dot"></i>홈</a>`, "뉴스 홈"],
  [`<a href="/k"><span class="mid"></span><strong>본문</strong></a>`, "·본문"],
  [`<a href="/l"><span class="alt"></span><strong>본문</strong></a>`, "별본문"],
  [`<a href="/m"><span aria-label="라벨">본문</span><b>뒤</b></a>`, "라벨뒤"],
  [`<a href="/n"><nav title="t">nav text</nav><b>뒤</b></a>`, "t 뒤"],
  [
    `<a href="/o"><svg width="10" height="10"><title>아이콘</title><text>X</text></svg><b>설정</b></a>`,
    "아이콘설정",
  ],
  [`<a href="/p"><b>A&nbsp;B</b>&#8203;<em>C</em></a>`, "A BC"],
  [`<a href="/q"><span title="새 창"></span><b>열기</b></a>`, "새 창열기"],
  [
    `<a href="/r"><span style="display:inline-flex"><em>가</em></span><span>나</span></a>`,
    "가 나",
  ],
  [`<a href="/s"><ul><li>하나</li><li>둘</li></ul></a>`, "하나 둘"],
  [
    `<span id="lbl">외부 라벨</span><a href="/t" aria-labelledby="lbl"><b>안쪽</b></a>`,
    "외부 라벨",
  ],
  [
    `<button><span>결</span><span>제</span></button>`,
    // The browser runs these together, so a rule about 결제 reads 결제.
    "결제",
  ],
  [
    `<button><span style="display:inline-block">결</span><span style="display:inline-block">제</span></button>`,
    // And these apart: the hold holds the click to the browser's own spelling.
    "결 제",
  ],
];

const STYLE = `.blind{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.dot::before{content:"";display:inline-block;width:4px;height:4px}
.mid::before{content:"·"}
.alt::before{content:"★" / "별"}`;

async function pageWith(body: string): Promise<Page> {
  const page = await (browser as Browser).newPage({
    viewport: { width: 1280, height: 800 },
  });
  await page.setContent(
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${body}</body></html>`,
  );
  return page;
}

/** The page's names for every control the tree left nameless, and the tree's own line for each. */
async function namesOn(page: Page) {
  const yaml = await page.ariaSnapshot({ mode: "ai" });
  const read = readAriaSnapshot(yaml);
  const names = await namesFromThePage(page, read.unnamed, 2_000);
  return read.elements
    .filter((element) => read.unnamed.includes(element.ref))
    .map((element) => ({ ...element, name: names.get(element.ref) }));
}

describe.skipIf(!HAS_BROWSER)(
  "the name the page gives a nameless control",
  () => {
    test("is the role engine's name, to the space, in every shape", async () => {
      const page = await pageWith(
        CASES.map(([markup]) => `<div>${markup}</div>`).join(""),
      );
      try {
        const yaml = await page.ariaSnapshot({ mode: "ai" });
        const read = readAriaSnapshot(yaml);
        const names = await namesFromThePage(page, read.unnamed, 2_000);
        const outcomes: string[] = [];
        for (const element of read.elements) {
          if (!read.unnamed.includes(element.ref)) continue;
          const name = names.get(element.ref) ?? "(none)";
          const held = await holdToLabel(
            page.locator(`aria-ref=${element.ref}`),
            {
              role: element.role,
              name,
            },
          ).catch((error: Error) => error.message);
          outcomes.push(`${name} -> ${held}`);
        }
        // The tree printed some of these with a name of its own; those are not asked about, and every
        // one asked about is named as the browser names it.
        const wanted = CASES.map(([, name]) => name);
        for (const outcome of outcomes) {
          const name = outcome.slice(0, outcome.lastIndexOf(" -> "));
          expect([outcome, wanted.includes(name)]).toEqual([outcome, true]);
          expect(outcome).toEndWith(" -> same");
        }
        // At least the shapes the tree is known to blank (2026-10-04): the decoration, the inline
        // split, the caption, the image beside a word, the line break.
        for (const name of [
          "Headline",
          "무선마우스 특가",
          "10월 캘린더",
          "로고뉴스",
          "A B",
        ]) {
          expect(outcomes).toContain(`${name} -> same`);
        }
      } finally {
        await page.close();
      }
    });

    test("never carries what is typed into a field, by any path", async () => {
      const secret = "hunter2!SuperSecret";
      const page = await pageWith(
        [
          `<button><input aria-label="검색어"> <strong>찾기</strong></button>`,
          `<a href="/x"><textarea aria-label="메모"></textarea><b>메모 열기</b></a>`,
          `<a href="/y"><select aria-label="선택"><option>서울</option><option selected>${secret}</option></select><b>지역</b></a>`,
          `<a href="/z"><input type="number" aria-label="수량" value="482913"><b>수량</b></a>`,
          `<input id="typed" aria-label="입력"><a href="/w" aria-labelledby="typed"><b>입력값으로 이름</b></a>`,
        ].join(""),
      );
      try {
        for (const field of await page
          .locator("input:not([type=number]), textarea")
          .all()) {
          await field.fill(secret);
        }
        const named = await namesOn(page);
        expect(named.length).toBeGreaterThan(0);
        expect(JSON.stringify(named)).not.toContain(secret);
        expect(JSON.stringify(named)).not.toContain("482913");
        // The words around the fields are still the names.
        expect(named.map((element) => element.name)).toContain("찾기");
      } finally {
        await page.close();
      }
    });

    test("a control hidden from the accessibility tree is named as the hold's second question names it", async () => {
      const page = await pageWith(
        `<a href="/h" aria-hidden="true"><strong>숨은 링크</strong></a>`,
      );
      try {
        const [link] = await namesOn(page);
        expect(link?.name).toBe("숨은 링크");
        // Refused as hidden, not as renamed: the Bot is told the truth about why.
        const held = await holdToLabel(page.locator(`aria-ref=${link?.ref}`), {
          role: "link",
          name: link?.name ?? "",
        }).catch((error: Error) => error.message);
        expect(held).toBe("laf:element_not_actionable");
      } finally {
        await page.close();
      }
    });

    test("a ref that names nothing is left out, and nothing waits past the time given", async () => {
      const page = await pageWith(`<a href="/a"><strong>있음</strong></a>`);
      try {
        const yaml = await page.ariaSnapshot({ mode: "ai" });
        const read = readAriaSnapshot(yaml);
        const started = Date.now();
        const names = await namesFromThePage(
          page,
          [...read.unnamed, "e9999"],
          300,
        );
        expect(Date.now() - started).toBeLessThan(1_500);
        expect([...names.values()]).toEqual(["있음"]);
        expect(names.has("e9999")).toBe(false);
      } finally {
        await page.close();
      }
    });
  },
);
