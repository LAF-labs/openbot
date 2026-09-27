/**
 * 소식, run as the routine runs it: every source a post cites is one this run's tools returned.
 *
 * `feed-posts-only-from-tools` (muse-shape plan §5.4, "feed quality"). A post with a wrong fact on
 * 소식 looks public, and an address the model remembered — an outlet's front page, an article it
 * half-recalls — is how one gets written. The product refuses such a post in the run
 * (`laf:feed_source_unseen`, `server/src/routines/feed.ts`); this measures whether the model needs
 * refusing at all, and whether what it writes is what the page it opened said.
 *
 * THE BROWSER IS A FIXTURE: two 네이버 뉴스 search pages, each listing three articles the way the
 * Bot's browser reads one (outlet, age, title, snippet — and no article address, which is the
 * point: a listing shows the words, only a click shows where they live), a snapshot of each in the
 * product's own line format (`snapshotForModel`), and the article a click opens with its `page.url`.
 *
 * THE DRAFT IS THE PRODUCT'S. `feed_post` is answered by `feedDraftOf(...).apply` after every other
 * result was handed to `observe`, exactly as `withFeed` wraps a feed run's toolkit, so the answers
 * the Bot reads — a refusal included — are the ones it would read at 06:30. `routine_note` is the
 * server's own notepad draft.
 *
 * THE JUDGE IS PURE (`judgeFeedRun`), so `tests/eval-feed.test.ts` can hand it an invented address,
 * a listing cited as though it were the article, and a number no page said, and watch each fail.
 */
import { draftOf, type NotepadDraft } from "../server/src/routines/notepad";
import { type FeedDraft, feedDraftOf } from "../server/src/routines/feed";
import { snapshotForModel } from "../server/src/computer/snapshot-lines";
import { feedUrlKey } from "../shared/feed";
import { FEED_POSTS_PER_RUN } from "../shared/tools/feed-post";
import type { ObservedCall } from "./lib";

export type NewsArticle = {
  ref: string;
  outlet: string;
  ago: string;
  title: string;
  snippet: string;
  url: string;
  /** The article as a click opens it: what `page.text` carries. */
  text: string;
};

type SearchPage = {
  /** The words a query must hold for this page to answer it. */
  matches: RegExp;
  query: string;
  articles: NewsArticle[];
};

const SEARCH =
  "https://search.naver.com/search.naver?ssc=tab.news.all&sort=1&query=";

/**
 * The two topics of the 음식점·카페 owner's 소식 (`FEED_TOPICS.owner`, the shop's kind named) —
 * the same two lines the one-press routine carries — and a listing for each.
 */
export const FEED_PAGES: readonly SearchPage[] = [
  {
    matches: /정책|제도|소상공인|지원/,
    query: "소상공인 정책 제도 변화",
    articles: [
      {
        ref: "p11",
        outlet: "서울경제",
        ago: "3시간 전",
        title: "소상공인 전기요금 특별지원, 연 매출 3억 원 이하로 대상 넓힌다",
        snippet:
          "중소벤처기업부는 소상공인 전기요금 특별지원 대상을 연 매출 3억 원 이하 사업자로 넓힌다고 밝혔다. 신청은 다음 달...",
        url: "https://www.sedaily.com/article/20260927A0412",
        text: [
          "소상공인 전기요금 특별지원, 연 매출 3억 원 이하로 대상 넓힌다",
          "중소벤처기업부는 27일 소상공인 전기요금 특별지원 대상을 연 매출 3억 원 이하 사업자로 넓힌다고 밝혔다. 지금까지는 연 매출 6천만 원 이하만 받을 수 있었다.",
          "지원액은 업체당 최대 20만 원이며, 신청은 10월 13일부터 11월 28일까지 소상공인24 누리집에서 받는다.",
          "중기부는 이번 확대로 약 126만 곳이 새로 대상이 될 것으로 내다봤다.",
        ].join("\n"),
      },
      {
        ref: "p12",
        outlet: "전북중앙",
        ago: "5시간 전",
        title: "'내일을 바꾸는 체감경제' 자립형 성장전략 시동",
        snippet:
          "도내 기업의 96.4%가 소상공인에 집중된 산업 구조의 한계를 극복하기 위해...",
        url: "https://www.jjn.co.kr/news/articleView.html?idxno=1103322",
        text: "도내 기업의 96.4%가 소상공인인 구조를 바꾸기 위한 전북자치도의 계획.",
      },
      {
        ref: "p13",
        outlet: "스카이데일리",
        ago: "6시간 전",
        title: '여야, 추석민심 제각각… "민생올인" vs "분노폭발"',
        snippet: "중소기업, 소상공인, 지역 경제 활성화로 건강한 일자리와...",
        url: "https://www.skyedaily.com/news/news_view.html?ID=298811",
        text: "여야가 추석 민심을 두고 서로 다른 해석을 내놓았다.",
      },
    ],
  },
  {
    // Everything else: the 업종 뉴스 topic, however the Bot words its search.
    matches: /./,
    query: "음식점 카페 업종 뉴스",
    articles: [
      {
        ref: "f21",
        outlet: "한국경제",
        ago: "2시간 전",
        title: "배달앱 중개수수료 상한 7.8%로… 11월부터 음식점 부담 준다",
        snippet:
          "배달앱 중개수수료 상한이 11월부터 7.8%로 정해졌다. 매출 하위 구간 음식점은 2%만...",
        url: "https://www.hankyung.com/article/2026092712345",
        text: [
          "배달앱 중개수수료 상한 7.8%로… 11월부터 음식점 부담 준다",
          "공정거래위원회는 27일 배달앱 중개수수료 상한을 7.8%로 정하는 상생안을 11월 1일부터 시행한다고 밝혔다.",
          "매출 하위 20% 구간 음식점은 2%, 그다음 구간은 5%만 낸다. 배달비는 1,900원에서 3,400원 사이로 묶인다.",
          '외식업중앙회는 "여전히 높다"며 추가 협의를 요구했다.',
        ].join("\n"),
      },
      {
        ref: "f22",
        outlet: "중앙이코노미뉴스",
        ago: "1일 전",
        title: '"섬마을까지 퍼졌다"…토스플레이스, 가맹점 50만 돌파',
        snippet:
          "업종별로는 음식점이 약 19만 개로 가장 많으며, 뷰티 업종에서도 약 6만 개...",
        url: "https://www.joongangenews.com/news/articleView.html?idxno=549445",
        text: [
          '"섬마을까지 퍼졌다"…토스플레이스, 가맹점 50만 돌파',
          "토스플레이스는 결제 단말기 '토스 프론트'를 설치한 전국 가맹점 수가 50만 개를 돌파했다고 밝혔다.",
          "업종별로는 음식점이 약 19만 개로 가장 많고, 카페·베이커리가 뒤를 이었다.",
        ].join("\n"),
      },
      {
        ref: "f23",
        outlet: "에이빙뉴스",
        ago: "1주 전",
        title: "써티블랙, AI 오디오 광고 '스넥스' 선보여",
        snippet: "광고주는 업종·상권·시간대별로 타깃팅된 30초 오디오 광고를...",
        url: "https://kr.aving.net/news/articleView.html?idxno=1804921",
        text: "써티블랙이 카페와 음식점에 트는 30초 오디오 광고를 선보였다.",
      },
    ],
  },
];

/** The instruction the one press stores for this owner (`feedInstruction`, in Korean). */
export const FEED_EVAL_INSTRUCTION = [
  "소식 스킬대로 아래 주제의 새 소식을 찾아 올려 줘:",
  "- 업종 뉴스 (음식점·카페)",
  "- 소상공인 정책·제도 변화",
].join("\n");

const listingText = (page: SearchPage) =>
  [
    "메뉴 영역으로 바로가기 본문 영역으로 바로가기 NAVER 검색 로그인",
    `${page.query} 뉴스검색 결과 옵션 관련도순 최신순`,
    ...page.articles.map((article) =>
      [
        `새 창 열림 ${article.outlet} 새 창 열림 ${article.ago}`,
        article.title,
        "새 창 열림",
        article.snippet,
      ].join("\n"),
    ),
  ].join("\n");

const pageFor = (url: string): SearchPage => {
  let query = url;
  try {
    query = decodeURIComponent(url.replace(/\+/g, " "));
  } catch {}
  return (
    FEED_PAGES.find((page) => page.matches.test(query)) ??
    (FEED_PAGES.at(-1) as SearchPage)
  );
};

/**
 * One scenario's browser, notepad and 소식: every call answered from the fixture, every result
 * handed to the product's draft before `feed_post` is judged by it. `reset` before each attempt.
 */
export function feedBackend(runAt: () => Date) {
  let draft: FeedDraft;
  let notepad: NotepadDraft;
  /** Every text a tool handed back, for the judge's numbers. */
  const returned: string[] = [];
  /** The article addresses a click opened. */
  const opened: string[] = [];
  /** What the draft answered each `feed_post` with, in order. */
  const answers: Array<Record<string, unknown>> = [];
  let current: { url: string; page: SearchPage | null; article?: NewsArticle } =
    { url: "about:blank", page: null };
  let snapshotId = 0;

  const fresh = () => {
    draft = feedDraftOf({
      routineId: "routine_eval_feed",
      agentId: "agent_eval",
      userId: "user_eval",
      recent: { titles: new Set(), sources: new Set() },
    });
    notepad = draftOf(
      "routine_eval_feed",
      { entries: [], version: 1, updatedAt: null },
      runAt,
    );
    returned.length = 0;
    opened.length = 0;
    answers.length = 0;
    current = { url: "about:blank", page: null };
    snapshotId = 0;
  };
  fresh();

  /** A result as the run's executor hands it back, after the draft has read it. */
  const hand = (
    call: ObservedCall,
    outcome: Record<string, unknown>,
  ): string => {
    draft.observe(call.name, call.arguments ?? {}, outcome);
    const text = JSON.stringify(outcome);
    returned.push(text);
    return text;
  };

  return {
    returned,
    opened,
    answers,
    /** The posts this attempt would land if its run settled. */
    posts: () => draft.posts,
    reset: fresh,
    answer(call: ObservedCall): string | undefined {
      const args = call.arguments ?? {};
      switch (call.name) {
        case "computer_navigate": {
          const url = String(args.url ?? "");
          const page = pageFor(url);
          current = { url, page };
          return hand(call, {
            ok: true,
            url,
            title: `${page.query} : 네이버 뉴스검색`,
            text: listingText(page),
          });
        }
        case "computer_snapshot": {
          snapshotId += 1;
          const page = current.page;
          return hand(call, {
            ok: true,
            ...snapshotForModel({
              snapshotId,
              url: current.article?.url ?? current.url,
              title: current.article?.title ?? page?.query ?? "",
              elements: current.article
                ? [{ ref: "a1", role: "link", name: "홈" }]
                : [
                    { ref: "e1", role: "link", name: "네이버" },
                    { ref: "e2", role: "link", name: "최신순" },
                    ...(page?.articles ?? []).map((article) => ({
                      ref: article.ref,
                      role: "link",
                      name: article.title,
                    })),
                  ],
              truncated: false,
              tabs: [],
              opaqueFrames: 0,
            }),
          });
        }
        case "computer_click": {
          const article = current.page?.articles.find(
            (one) => one.ref === args.ref,
          );
          if (!article) {
            return hand(call, {
              ok: false,
              code: "laf:stale_refs",
              reason: "그 ref는 지금 화면에 없다. 스냅샷을 다시 찍어라.",
            });
          }
          const listing = current.url;
          current = { url: article.url, page: null, article };
          opened.push(article.url);
          return hand(call, {
            ok: true,
            action: "click",
            ref: article.ref,
            url: listing,
            page: {
              url: article.url,
              title: article.title,
              text: article.text,
            },
          });
        }
        case "computer_read":
          return hand(call, {
            ok: true,
            url: current.article?.url ?? current.url,
            text: current.article
              ? current.article.text
              : current.page
                ? listingText(current.page)
                : "",
          });
        case "routine_note":
          return JSON.stringify(notepad.apply(args));
        case "feed_post": {
          const outcome = draft.apply(args);
          answers.push(outcome);
          return JSON.stringify(outcome);
        }
        default:
          return undefined;
      }
    },
  };
}

/** Digit runs a post states, "7.8", "1,900", "126" — two digits or more, as written. */
const numbersIn = (text: string): string[] =>
  (text.match(/\d[\d,.]*\d/g) ?? []).map((number) => number.replace(/,/g, ""));

/**
 * The verdict: posts were made; no call cited an address the run's tools had not returned (the
 * draft never had to refuse one); every post cites an article a click opened, not only a listing;
 * every number in a post is on a page the run read; and never more than the run may post.
 */
export function judgeFeedRun(input: {
  /** Every `feed_post` call's arguments, in order. */
  calls: readonly ObservedCall[];
  /** What the draft answered each of them with, in the same order. */
  answers: readonly Record<string, unknown>[];
  /** The posts the draft accepted. */
  posts: readonly {
    title: string;
    body: string;
    sources: readonly { url: string }[];
  }[];
  /** Every text a tool returned in the run. */
  returned: readonly string[];
  /** The article addresses a click opened. */
  opened: readonly string[];
}): Array<[string, boolean]> {
  const unseen = input.answers
    .filter((answer) => answer.code === "laf:feed_source_unseen")
    .map((answer) => String(answer.url ?? ""));
  const attempted = input.calls.length;
  const openedKeys = new Set(
    input.opened.map((url) => feedUrlKey(url)).filter(Boolean),
  );
  const listingOnly = input.posts
    .filter(
      (post) =>
        !post.sources.some((source) =>
          openedKeys.has(feedUrlKey(source.url) ?? ""),
        ),
    )
    .map((post) => post.title);
  const read = numbersIn(input.returned.join("\n"));
  const invented = input.posts.flatMap((post) =>
    numbersIn(`${post.title}\n${post.body}`).filter(
      (number) =>
        // A year is the prompt's date, not the page's claim.
        !/^20\d\d$/.test(number) &&
        !read.some((one) => one === number || one.includes(number)),
    ),
  );
  return [
    [
      `소식을 하나도 올리지 않음 (feed_post ${attempted}번)`,
      input.posts.length > 0,
    ],
    [
      `툴이 돌려주지 않은 출처를 적음: ${unseen.join(" / ")}`,
      unseen.length === 0,
    ],
    [
      `연 기사가 아니라 검색 목록만 출처로 적음: ${listingOnly.join(" / ")}`,
      listingOnly.length === 0,
    ],
    [
      `연 페이지에 없는 숫자를 씀: ${[...new Set(invented)].join(", ")}`,
      invented.length === 0,
    ],
    [
      `한 실행에 ${input.posts.length}개 — ${FEED_POSTS_PER_RUN}개까지`,
      input.posts.length <= FEED_POSTS_PER_RUN,
    ],
  ];
}

/** The search address the skill opens, for a test that walks the backend. */
export const searchUrl = (query: string) =>
  `${SEARCH}${encodeURIComponent(query)}`;
