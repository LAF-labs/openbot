import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "../src/components/channels/chat-messages";
import { sourcesByAnswer } from "../src/components/channels/sources";
import { siteIsForThisShop, sitesInShopOrder } from "../src/lib/shop/catalogue";

/**
 * Where an answer came from, taken from what the browser reported — never from the model
 * (ux-review-0.5.4, item 10) — and the connections list in the order this shop uses (item 20).
 * How the sources are drawn — a pill at the end of the answer — is `sources-pill.test.tsx`; the
 * first of them is all that pill shows, which is why their order is held here.
 */

const said = (id: string, role: "user" | "assistant", text = "…") =>
  ({ kind: "text", id, role, text }) as const;

const task = (
  id: string,
  steps: Array<{ name: string; result?: object | string }>,
): TranscriptItem => ({
  kind: "browse",
  id,
  notes: [],
  steps: steps.map((step, index) => ({
    id: `${id}-${index}`,
    name: step.name,
    args: "{}",
    ...(step.result === undefined
      ? {}
      : {
          result:
            typeof step.result === "string"
              ? step.result
              : JSON.stringify(step.result),
        }),
  })),
});

/** A web search, as its call sits in the transcript: the real tool's name, and the tool's own JSON. */
const searched = (id: string, result?: object | string): TranscriptItem => ({
  kind: "tool",
  id,
  toolCall: {
    id,
    type: "function",
    function: { name: "mcp__web-search__search", arguments: "{}" },
  },
  ...(result === undefined
    ? {}
    : {
        result: typeof result === "string" ? result : JSON.stringify(result),
      }),
});

describe("where an answer from a search came from", () => {
  test("the results the search handed back are the sources, with no page opened", () => {
    const items: TranscriptItem[] = [
      said("u1", "user", "내년 최저임금 얼마야?"),
      searched("s1", {
        source: "웹 검색",
        queries: ["2027년 최저임금 시급"],
        shown: 2,
        results: [
          {
            title: "내년도 최저임금 '1만 700원'",
            url: "https://www.korea.kr/news/a",
            date: "2026-08-08",
            snippet: "…",
          },
          {
            title: "최저임금위원회",
            url: "https://www.minimumwage.go.kr/",
            snippet: "…",
          },
          // Not an address anybody could open: not a source.
          { title: "깨진 결과", url: "javascript:alert(1)", snippet: "…" },
        ],
      }),
      said("a1", "assistant", "시간급 1만 700원이에요."),
    ];
    expect(sourcesByAnswer(items).get("a1")).toEqual([
      {
        url: "https://www.korea.kr/news/a",
        title: "내년도 최저임금 '1만 700원'",
        host: "korea.kr",
      },
      {
        url: "https://www.minimumwage.go.kr/",
        title: "최저임금위원회",
        host: "minimumwage.go.kr",
      },
    ]);
  });

  test("a search that was refused, or is still running, is not a source", () => {
    const items: TranscriptItem[] = [
      said("u1", "user"),
      searched(
        "s1",
        "오늘 쓸 수 있는 웹 검색을 다 썼다. 꼭 필요한 것은 브라우저로 찾고…",
      ),
      searched("s2"),
      said("a1", "assistant", "지금은 찾지 못했어요."),
    ];
    expect(sourcesByAnswer(items).size).toBe(0);
  });

  test("a search's result opened afterwards is one source, named as the page that was opened", () => {
    const items: TranscriptItem[] = [
      said("u1", "user"),
      searched("s1", {
        results: [
          { title: "공고", url: "https://www.nts.go.kr/a", snippet: "" },
        ],
      }),
      task("t1", [
        {
          name: "computer_read",
          result: {
            ok: true,
            url: "https://www.nts.go.kr/a",
            title: "공고 전문",
          },
        },
      ]),
      said("a1", "assistant"),
    ];
    // The same address once, named as the page that was actually opened.
    expect(sourcesByAnswer(items).get("a1")).toEqual([
      { url: "https://www.nts.go.kr/a", title: "공고 전문", host: "nts.go.kr" },
    ]);
  });
});

describe("where an answer came from", () => {
  test("the pages the turn read hang from the answer after them", () => {
    const items: TranscriptItem[] = [
      said("u1", "user"),
      said("a0", "assistant", "찾아볼게요"),
      task("t1", [
        {
          name: "computer_navigate",
          result: { ok: true, url: "https://weather.naver.com/", title: "" },
        },
        {
          name: "computer_read",
          result: {
            ok: true,
            url: "https://news.naver.com/a",
            title: "기사 A",
          },
        },
        // A press is not a page anybody read.
        {
          name: "computer_click",
          result: { ok: true, url: "https://news.naver.com/b" },
        },
      ]),
      said("a1", "assistant", "정리했어요"),
    ];
    const found = sourcesByAnswer(items);
    expect([...found.keys()]).toEqual(["a1"]);
    // The page read last is first: it is the one the answer was written after.
    expect(found.get("a1")).toEqual([
      {
        url: "https://news.naver.com/a",
        title: "기사 A",
        host: "news.naver.com",
      },
      {
        url: "https://weather.naver.com/",
        title: "",
        host: "weather.naver.com",
      },
    ]);
  });

  test("a failed read, a thrown result and a page that is not the web are not sources", () => {
    const items: TranscriptItem[] = [
      said("u1", "user"),
      task("t1", [
        { name: "computer_read", result: { ok: false, url: "https://x.com/" } },
        { name: "computer_read", result: "Error: the browser went away" },
        { name: "computer_read", result: { ok: true, url: "about:blank" } },
        { name: "computer_read" },
      ]),
      said("a1", "assistant"),
    ];
    expect(sourcesByAnswer(items).size).toBe(0);
  });

  test("each turn keeps its own, and the same page once", () => {
    const read = (url: string) => ({
      name: "computer_read",
      result: { ok: true, url, title: url },
    });
    const items: TranscriptItem[] = [
      said("u1", "user"),
      task("t1", [read("https://a.kr/"), read("https://a.kr/")]),
      said("a1", "assistant"),
      said("u2", "user"),
      said("a2", "assistant", "기억으로 답했어요"),
    ];
    const found = sourcesByAnswer(items);
    expect(found.get("a1")?.map((source) => source.url)).toEqual([
      "https://a.kr/",
    ]);
    expect(found.has("a2")).toBe(false);
  });
});

describe("which source is first, and how many a site has", () => {
  const read = (url: string, title = "") => ({
    name: "computer_read",
    result: { ok: true, url, title },
  });
  const result = (url: string, title = "") => ({ title, url, snippet: "…" });
  const urlsOf = (items: TranscriptItem[]) =>
    sourcesByAnswer(items)
      .get("a1")
      ?.map((source) => source.url);

  /*
   * THE OWNER'S OWN CONVERSATION, 2026-10-04, as it was read: the Bot searched for 성심당's opening
   * hours, opened the bakery's own page — the search's first result — and answered "공식
   * 홈페이지에서 확인했어요". The list began with placeview.co.kr and ended with the bakery.
   */
  test("the page the Bot opened last is first, then the search's results as the search ranked them", () => {
    const items: TranscriptItem[] = [
      said("u1", "user", "성심당 본점 영업시간이랑 휴무일 알려줘"),
      searched("s1", {
        results: [
          result(
            "http://sungsimdang.co.kr/31/15",
            "성심당 본점 > [Brand] 브랜드",
          ),
          result(
            "https://www.placeview.co.kr/id/1",
            "성심당 본점 - 플레이스뷰",
          ),
          result(
            "https://blog.naver.com/a/1",
            "성심당 본점 주변엔 뭐가 있을까?",
          ),
          result("https://blog.naver.com/b/2", "대전 성심당은 언제 쉴까?"),
          result("http://sungsimdang.co.kr/", "성심당"),
        ],
      }),
      task("t1", [
        {
          name: "computer_navigate",
          result: {
            ok: true,
            url: "http://sungsimdang.co.kr/31/15",
            title: "성심당 본점 > [Brand] 브랜드 | 성심당",
          },
        },
      ]),
      said("a1", "assistant", "공식 홈페이지에서 확인했어요"),
    ];
    expect(sourcesByAnswer(items).get("a1")).toEqual([
      {
        url: "http://sungsimdang.co.kr/31/15",
        title: "성심당 본점 > [Brand] 브랜드 | 성심당",
        host: "sungsimdang.co.kr",
      },
      {
        url: "https://www.placeview.co.kr/id/1",
        title: "성심당 본점 - 플레이스뷰",
        host: "placeview.co.kr",
      },
      // The blog's two pages are one 네이버 블로그: the one the search ranked higher.
      {
        url: "https://blog.naver.com/a/1",
        title: "성심당 본점 주변엔 뭐가 있을까?",
        host: "blog.naver.com",
      },
    ]);
  });

  /*
   * THE SAME CONVERSATION'S SHARE PRICE: 토스증권, 토스증권, tradingkey.com, fintel.io,
   * kr.investing.com, itooza.com, 토스증권 — the first a page titled "페이지를 찾을 수 없습니다",
   * the last the page the price was read from.
   */
  test("a site read three times is one source: the page read there last, and not one that was not found", () => {
    const items: TranscriptItem[] = [
      said("u1", "user", "토스증권에서 테슬라 주가를 찾아서 알려줘"),
      task("t1", [
        read(
          "https://www.tossinvest.com/search?keyword=tesla",
          "토스증권 | 페이지를 찾을 수 없습니다",
        ),
        read("https://www.tossinvest.com/", "토스증권"),
      ]),
      searched("s1", {
        results: [
          result("https://www.tradingkey.com/kr/news/1"),
          result("https://fintel.io/ko/so/us/tsla"),
          result("https://kr.investing.com/equities/tesla"),
          result("https://itooza.com/vscoreus/TSLA"),
        ],
      }),
      task("t2", [
        read(
          "https://www.tossinvest.com/stocks/US20100629001/order",
          "503,854원 +4.65% | 테슬라",
        ),
      ]),
      said("a1", "assistant", "토스증권에서 확인했어요."),
    ];
    expect(urlsOf(items)).toEqual([
      "https://www.tossinvest.com/stocks/US20100629001/order",
      "https://www.tradingkey.com/kr/news/1",
      "https://fintel.io/ko/so/us/tsla",
      "https://kr.investing.com/equities/tesla",
      "https://itooza.com/vscoreus/TSLA",
    ]);
  });

  test("a later search's results stand before an earlier one's, each in its own ranking", () => {
    const items: TranscriptItem[] = [
      said("u1", "user"),
      searched("s1", {
        results: [result("https://one.kr/1"), result("https://two.kr/2")],
      }),
      searched("s2", {
        results: [result("https://three.kr/3"), result("https://four.kr/4")],
      }),
      said("a1", "assistant"),
    ];
    expect(urlsOf(items)).toEqual([
      "https://three.kr/3",
      "https://four.kr/4",
      "https://one.kr/1",
      "https://two.kr/2",
    ]);
  });

  /*
   * BY THE NAME THE PILL SAYS, NOT BY THE HOST: two hosts people call 네이버 are one pill, and a
   * part of the site they call something else — 네이버 뉴스 — is its own, as on a browsing task's
   * title (`siteNameOf`). A host nobody has a name for is named by itself, so each is its own.
   */
  test("hosts with one name are one source, and a part of a site with its own name is its own", () => {
    const items: TranscriptItem[] = [
      said("u1", "user"),
      task("t1", [
        read("https://search.naver.com/search.naver?query=a"),
        read("https://news.naver.com/section/101"),
        read("https://n.news.naver.com/mnews/article/1"),
        read("https://m.naver.com/"),
        read("https://kr.investing.com/a"),
        read("https://investing.com/b"),
      ]),
      said("a1", "assistant"),
    ];
    expect(urlsOf(items)).toEqual([
      "https://investing.com/b",
      "https://kr.investing.com/a",
      "https://m.naver.com/",
      "https://n.news.naver.com/mnews/article/1",
    ]);
  });

  test("at most eight sites, and they are the eight nearest the answer", () => {
    const items: TranscriptItem[] = [
      said("u1", "user"),
      task(
        "t1",
        Array.from({ length: 12 }, (_, at) => read(`https://site-${at}.kr/`)),
      ),
      said("a1", "assistant"),
    ];
    expect(urlsOf(items)).toEqual(
      [11, 10, 9, 8, 7, 6, 5, 4].map((at) => `https://site-${at}.kr/`),
    );
  });
});

describe("the connections list, in this shop's order", () => {
  const sites = [
    { id: "hometax" },
    { id: "naver-smartstore" },
    { id: "baemin-ceo" },
    { id: "coupangeats-store" },
  ];

  test("the places picked first, then the kind's likeliest, then the catalogue's order", () => {
    const ordered = sitesInShopOrder(sites, {
      kind: "food",
      places: ["coupangeats-store"],
    }).map((site) => site.id);
    expect(ordered[0]).toBe("coupangeats-store");
    expect(ordered.indexOf("baemin-ceo")).toBeLessThan(
      ordered.indexOf("hometax"),
    );
    expect(siteIsForThisShop("baemin-ceo", { kind: "food", places: [] })).toBe(
      true,
    );
  });

  test("with nothing answered, the order is the catalogue's", () => {
    expect(
      sitesInShopOrder(sites, { kind: null, places: [] }).map(
        (site) => site.id,
      ),
    ).toEqual(sites.map((site) => site.id));
  });
});
