/**
 * WHAT A BROWSING CARD AND THE BANNER ARE CALLED.
 *
 * MEASURED 2026-09-24 (UI/UX audit, item 13), and again the same day on a local stack with
 * "네이버에서 서울, 부산, 제주 오늘 날씨": the cards were titled `search.naver.com` and said
 * "완료 · 3단계" — a host a person never typed and a count nobody asked for. The title is now the
 * site as people call it and what the Bot looked up there (2026-09-27: not the person's sentence).
 *
 * `t()` reads the site names through a variable, which `i18n-coverage.test.ts` cannot see, so this
 * walks the table the way `agent-refusals.test.ts` walks its own.
 */
import { describe, expect, test } from "bun:test";
import {
  EVERYDAY_SITES,
  plainLine,
  siteNameOf,
  siteNamesOf,
  taskHeading,
  taskTitle,
} from "../src/components/computer/task-title";
import {
  type BrowsingStep,
  lookedUpOf,
  sitesOf,
} from "../src/lib/computer/browsing";
import { ko } from "../src/lib/i18n-ko";

describe("the site's name", () => {
  test("every everyday site has its Korean name", () => {
    for (const site of EVERYDAY_SITES) {
      expect(ko[site.name]).toBeString();
      expect(ko[site.name]?.length).toBeGreaterThan(0);
    }
  });

  test("the most specific name wins, and a subdomain counts", () => {
    expect(siteNameOf("search.shopping.naver.com")).toBe("Naver Shopping");
    expect(siteNameOf("search.naver.com")).toBe("Naver");
    expect(siteNameOf("m.weather.naver.com")).toBe("Naver Weather");
    expect(siteNameOf("www.yes24.com")).toBe("YES24");
  });

  test("a business site is named as the 연결 screen names it", () => {
    expect(siteNameOf("ceo.baemin.com")).toBe("Baemin for Owners");
    expect(siteNameOf("sell.smartstore.naver.com")).toBe(
      "Naver Smart Store Seller Centre",
    );
  });

  test("a host nobody named is the host, without www", () => {
    expect(siteNameOf("www.example.org")).toBe("example.org");
  });

  test("two hosts of one site are one name", () => {
    expect(siteNamesOf(["naver.com", "search.naver.com", "yes24.com"])).toEqual(
      ["Naver", "YES24"],
    );
  });
});

/** A navigation as the transcript holds it, with the page it reached. */
function went(url: string, title?: string, reached = url): BrowsingStep {
  return {
    id: `call-${url}`,
    name: "computer_navigate",
    args: JSON.stringify({ url }),
    result: JSON.stringify({ ok: true, url: reached, title }),
  };
}

describe("what the Bot looked up, as half a title", () => {
  test("the words of the search it opened", () => {
    expect(
      lookedUpOf([
        went(
          "https://search.naver.com/search.naver?query=%EC%B6%98%EC%B2%9C+%ED%9A%A8%EC%9E%90%EB%8F%99+%EB%82%A0%EC%94%A8",
          "춘천 효자동 날씨 : 네이버 검색",
        ),
      ]),
    ).toBe("춘천 효자동 날씨");
    expect(
      lookedUpOf([went("https://www.google.com/search?q=kraft+bag")]),
    ).toBe("kraft bag");
    expect(
      lookedUpOf([
        went("https://www.youtube.com/results?search_query=김치찌개"),
      ]),
    ).toBe("김치찌개");
    // 네이버 지도 puts the words in the path.
    expect(
      lookedUpOf([
        went("https://map.naver.com/p/search/%EC%B6%98%EC%B2%9C%EC%97%AD"),
      ]),
    ).toBe("춘천역");
  });

  test("the last search, even after a page it opened from it", () => {
    expect(
      lookedUpOf([
        went("https://search.naver.com/search.naver?query=원두"),
        went("https://search.naver.com/search.naver?query=원두 1kg"),
        went("https://blog.naver.com/some/1", "원두 고르는 법 : 네이버 블로그"),
      ]),
    ).toBe("원두 1kg");
  });

  test("with no search, the page it opened, without the site's name after it", () => {
    expect(
      lookedUpOf([
        went("https://www.yes24.com/Product/Goods/1", "소년이 온다 - 예스24"),
      ]),
    ).toBe("소년이 온다");
    // A title that is only the site's name says nothing the other half does not.
    expect(
      lookedUpOf([went("https://www.naver.com/", "NAVER")]),
    ).toBeUndefined();
  });

  test("never the person's sentence, and never what was typed", () => {
    const typed: BrowsingStep = {
      id: "call-type",
      name: "computer_type",
      args: JSON.stringify({ ref: "e3", text: "secret-password-1234" }),
      result: JSON.stringify({ ok: true }),
    };
    expect(lookedUpOf([typed])).toBeUndefined();
    expect(
      JSON.stringify(
        lookedUpOf([
          went("https://nid.naver.com/nidlogin.login", "네이버 : 로그인"),
          typed,
        ]),
      ),
    ).not.toContain("secret-password-1234");
  });

  test("a long one is cut to one line", () => {
    const words = "가".repeat(60);
    const found = lookedUpOf([
      went(`https://search.naver.com/search.naver?query=${words}`),
    ]);
    expect(found?.length).toBe(40);
    expect(found?.endsWith("…")).toBe(true);
  });
});

describe("the whole title", () => {
  test("site · what was looked up, named for where the task ended up", () => {
    // Tests read the English keys; on a Korean screen this is "네이버 쇼핑 · 원두 1kg".
    expect(
      taskTitle(["naver.com", "search.shopping.naver.com"], "원두 1kg"),
    ).toBe("Naver Shopping · 원두 1kg");
  });

  test("the walk's card: a sentence about the shop is not the title", () => {
    /*
     * 2026-09-27: "우리 가게는 춘천 효자동에 있는 한식당이에요" started a weather search, and the card
     * was titled with the sentence. The card now says what was searched for.
     */
    const steps = [
      went(
        "https://search.naver.com/search.naver?query=춘천 효자동 날씨",
        "춘천 효자동 날씨 : 네이버 검색",
      ),
    ];
    expect(taskTitle(sitesOf(steps), lookedUpOf(steps))).toBe(
      "Naver · 춘천 효자동 날씨",
    );
  });

  test("either half alone, and nothing for neither", () => {
    expect(taskTitle([], "소년이 온다")).toBe("소년이 온다");
    expect(taskTitle(["yes24.com"], undefined)).toBe("YES24");
    expect(taskTitle(["yes24.com"], "  ")).toBe("YES24");
    expect(taskTitle([], undefined)).toBeNull();
  });
});

/*
 * THE CARD'S TWO LINES (the owner's screenshot, 2026-10-03): "tossinvest.com · 테슬라" led with a
 * host and cut what was asked about, and "tossinvest.com · 토스증권" said the site twice.
 */
describe("the card's heading: where, small, and what, as the title", () => {
  test("토스증권 is named, before 토스 and under its own host", () => {
    expect(siteNameOf("tossinvest.com")).toBe("Toss Securities");
    expect(siteNameOf("www.tossinvest.com")).toBe("Toss Securities");
    expect(siteNameOf("toss.im")).toBe("Toss");
    expect(ko["Toss Securities"]).toBe("토스증권");
  });

  test("what was looked up is the title, and the site the line above it", () => {
    expect(taskHeading(["tossinvest.com"], "테슬라")).toEqual({
      site: "Toss Securities",
      title: "테슬라",
    });
    expect(
      taskHeading(["naver.com", "search.shopping.naver.com"], " 원두 1kg "),
    ).toEqual({ site: "Naver Shopping", title: "원두 1kg" });
  });

  test("the site's own name looked up is said once, as the title", () => {
    for (const lookedUp of [
      "Toss Securities",
      "toss securities",
      " TossSecurities ",
      "Ｔoss Securities",
    ]) {
      expect([lookedUp, taskHeading(["tossinvest.com"], lookedUp)]).toEqual([
        lookedUp,
        { site: null, title: "Toss Securities" },
      ]);
    }
    // A name that only begins the same is something looked up there.
    expect(taskHeading(["tossinvest.com"], "Toss Securities 수수료")).toEqual({
      site: "Toss Securities",
      title: "Toss Securities 수수료",
    });
  });

  test("with nothing looked up the site is the title, and with neither there is none", () => {
    expect(taskHeading(["yes24.com"], undefined)).toEqual({
      site: null,
      title: "YES24",
    });
    expect(taskHeading(["yes24.com"], "  ")).toEqual({
      site: null,
      title: "YES24",
    });
    expect(taskHeading([], "소년이 온다")).toEqual({
      site: null,
      title: "소년이 온다",
    });
    expect(taskHeading([], undefined)).toEqual({ site: null, title: null });
  });
});

test("one line of what the Bot said, without the marks a bubble would draw", () => {
  expect(plainLine("## 가게 마감\n1. 불 끄기")).toBe("가게 마감");
  expect(plainLine("**서울** 확인했어요")).toBe("서울 확인했어요");
});
