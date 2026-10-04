import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "../src/components/channels/chat-messages";
import { sourcesByAnswer } from "../src/components/channels/sources";
import { siteIsForThisShop, sitesInShopOrder } from "../src/lib/shop/catalogue";

/**
 * Where an answer came from, taken from what the browser reported — never from the model
 * (ux-review-0.5.4, item 10) — and the connections list in the order this shop uses (item 20).
 * How the sources are drawn — a pill at the end of the answer — is `sources-pill.test.tsx`.
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

  test("a search and a page read after it both count, the page last", () => {
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
    expect(found.get("a1")).toEqual([
      {
        url: "https://weather.naver.com/",
        title: "",
        host: "weather.naver.com",
      },
      {
        url: "https://news.naver.com/a",
        title: "기사 A",
        host: "news.naver.com",
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
