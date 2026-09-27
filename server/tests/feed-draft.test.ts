/**
 * 소식's posts, judged inside the run (muse-shape plan §3.2, phase 7): only pages this run's tools
 * returned may be cited, three a run, nothing twice, and the tool exists only where it was put.
 */
import { describe, expect, test } from "bun:test";
import { feedUrlKey, urlsIn } from "../../shared/feed";
import { FEED_POST } from "../../shared/tools/feed-post";
import { feedDraftOf, withFeed } from "../src/routines/feed";
import type { UnattendedToolkit } from "../src/runner/unattended";

const ARTICLE = "https://www.ntoday.co.kr/news/articleView.html?idxno=129616";

const draft = (recent?: { titles?: string[]; sources?: string[] }) =>
  feedDraftOf({
    routineId: "routine-1",
    agentId: "bot-1",
    userId: "person-1",
    recent: {
      titles: new Set(recent?.titles ?? []),
      sources: new Set(
        (recent?.sources ?? []).map((url) => feedUrlKey(url) ?? ""),
      ),
    },
  });

const post = (over: Record<string, unknown> = {}) => ({
  topic: "업종 뉴스",
  title: "배달앱 수수료 논의",
  body: "수수료 상한 법안이 소위를 넘지 못했다.",
  sources: [{ title: "이투데이", url: ARTICLE }],
  ...over,
});

/** A browser whose click landed on the article, as `computer_click` answers it. */
const clicked = {
  ok: true,
  action: "click",
  url: "https://search.naver.com/search.naver?query=x",
  page: { url: ARTICLE, title: "배달앱 수수료 논의 산으로" },
};

describe("a source is a page this run's tools returned", () => {
  test("an address no tool returned is refused, the same address after the page is opened is taken", () => {
    const run = draft();
    const refused = run.apply(post());
    expect(refused).toMatchObject({
      ok: false,
      code: "laf:feed_source_unseen",
    });
    run.observe("computer_click", {}, clicked);
    expect(run.apply(post())).toMatchObject({ ok: true, posted: 1 });
    expect(run.posts).toHaveLength(1);
  });

  test("where a navigation was sent counts, and so does a link a result carried in its text", () => {
    const run = draft();
    run.observe(
      "computer_navigate",
      { url: "https://news.naver.com/section/101" },
      { ok: true, url: "https://news.naver.com/section/101" },
    );
    run.observe(
      "mcp__data__search",
      {},
      {
        ok: true,
        text: '[{"title":"공고","url":"https://www.bizinfo.go.kr/web/lay1/view.do?id=7"}]',
      },
    );
    expect(
      run.apply(
        post({
          sources: [
            { title: "경제", url: "http://m.news.naver.com/section/101/" },
          ],
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      run.apply(
        post({
          title: "새 공고",
          sources: [
            {
              title: "기업마당",
              url: "https://www.bizinfo.go.kr/web/lay1/view.do?id=7",
            },
          ],
        }),
      ),
    ).toMatchObject({ ok: true });
  });

  test("a navigation that failed is not a page opened", () => {
    const run = draft();
    run.observe(
      "computer_navigate",
      { url: ARTICLE },
      { ok: false, code: "laf:page_timeout" },
    );
    expect(run.apply(post())).toMatchObject({ code: "laf:feed_source_unseen" });
  });

  test("addresses compare as pages: scheme, www and m., a trailing slash and the fragment do not matter", () => {
    expect(feedUrlKey("https://www.example.com/a/")).toBe(
      feedUrlKey("http://example.com/a#x"),
    );
    expect(feedUrlKey("https://m.news.naver.com/a")).toBe("news.naver.com/a");
    expect(feedUrlKey("javascript:alert(1)")).toBeNull();
    expect(
      urlsIn('{"u":"https://a.kr/x?y=1","v":"see https://b.kr/z."}'),
    ).toEqual(["https://a.kr/x?y=1", "https://b.kr/z"]);
  });
});

describe("three a run, nothing twice, and the shape", () => {
  test("a fourth is refused as full", () => {
    const run = draft();
    run.observe("computer_click", {}, clicked);
    for (const [index, url] of [
      "https://a.kr/1",
      "https://a.kr/2",
      "https://a.kr/3",
    ].entries()) {
      run.observe("computer_navigate", { url }, { ok: true });
      expect(
        run.apply(
          post({ title: `소식 ${index}`, sources: [{ title: "a", url }] }),
        ),
      ).toMatchObject({ ok: true });
    }
    expect(run.apply(post({ title: "넷째" }))).toMatchObject({
      code: "laf:feed_full",
    });
  });

  test("a title or a source posted lately, or earlier in this run, is refused as a repeat", () => {
    const earlier = draft({ titles: ["배달앱 수수료 논의"] });
    earlier.observe("computer_click", {}, clicked);
    expect(earlier.apply(post())).toMatchObject({ code: "laf:feed_repeat" });

    const cited = draft({ sources: [ARTICLE] });
    cited.observe("computer_click", {}, clicked);
    expect(cited.apply(post({ title: "다른 제목" }))).toMatchObject({
      code: "laf:feed_repeat",
    });

    const twice = draft();
    twice.observe("computer_click", {}, clicked);
    expect(twice.apply(post())).toMatchObject({ ok: true });
    expect(
      twice.apply(post({ title: "  배달앱   수수료 논의 " })),
    ).toMatchObject({
      code: "laf:feed_repeat",
    });
  });

  test("no source, too many, a long title, or no body is refused with the field to fix", () => {
    const run = draft();
    run.observe("computer_click", {}, clicked);
    expect(run.apply(post({ sources: [] }))).toMatchObject({
      code: "laf:feed_post_invalid",
      field: "sources",
    });
    expect(run.apply(post({ title: "가".repeat(81) }))).toMatchObject({
      field: "title",
    });
    expect(run.apply(post({ body: " " }))).toMatchObject({ field: "body" });
    expect(run.apply(post({ topic: "가".repeat(21) }))).toMatchObject({
      field: "topic",
    });
    expect(
      run.apply(post({ sources: [{ title: "x", url: "ftp://a.kr/1" }] })),
    ).toMatchObject({ field: "sources" });
    expect(run.posts).toHaveLength(0);
  });
});

describe("the tool is where it was put, and nowhere else", () => {
  test("withFeed offers feed_post beside the run's tools and reads every other result", async () => {
    const calls: string[] = [];
    const inner: UnattendedToolkit = {
      tools: [{ name: "computer_click", description: "", parameters: {} }],
      execute: async (name) => {
        calls.push(name);
        return clicked;
      },
    };
    const run = draft();
    const toolkit = withFeed(inner, run);
    expect(toolkit.tools.map((tool) => tool.name)).toEqual([
      "computer_click",
      FEED_POST.name,
    ]);
    await toolkit.execute("computer_click", {}, undefined);
    expect(
      await toolkit.execute(FEED_POST.name, post(), undefined),
    ).toMatchObject({ ok: true });
    // The post was judged here: the inner toolkit never saw it.
    expect(calls).toEqual(["computer_click"]);
    expect(inner.tools.map((tool) => tool.name)).not.toContain(FEED_POST.name);
  });
});
