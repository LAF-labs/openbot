import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "../src/components/channels/chat-messages";
import { sourcesByAnswer } from "../src/components/channels/sources";
import { siteIsForThisShop, sitesInShopOrder } from "../src/lib/shop/catalogue";

/**
 * "출처 N개" under an answer, taken from what the browser reported — never from the model
 * (ux-review-0.5.4, item 10) — and the connections list in the order this shop uses (item 20).
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
