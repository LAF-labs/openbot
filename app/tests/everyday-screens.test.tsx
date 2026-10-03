import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiAnswer,
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * THE EVERYDAY SCREENS SAY LESS (2026-10-04).
 *
 * The owner, about the app as a whole: too many characters on the screen, information nobody
 * needs, and words where an icon would do. Measured that day at 1280 in Korean, whitespace removed:
 * 소식 577 characters, 아이디어 1,042, 목표 129, 만든 것 371, 수첩 513, 루틴 187, 스킬 258 — and every
 * one opened on a sentence explaining itself, with sections that explained themselves again.
 *
 * What is held here is the shape, not the count: a count moves with a person's data, and the shape
 * is what a later change undoes without noticing — a `description` handed to the shell again, a
 * card's second and third line, a word put back beside an icon that already says it.
 *
 * MOUNTED THROUGH THE ROUTE TREE, in English (the test locale): what is read is what the screen
 * drew. Where a control became an icon its words are still there to be asked for, in `aria-label`
 * and in `title`, and the Korean is in the dictionary.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
// The whole route tree renders here; under a loaded machine that is more than the runner's five seconds.
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const BOT = agentFixture({ id: "bot-1", name: "초롱" });
const CONVERSATION = {
  id: "ch-1",
  name: "초롱",
  agentIds: ["bot-1"],
  threadId: "t1",
  active: true,
  lastMessage: "다 했어요",
  lastMessageAt: "2026-10-03T09:00:00.000Z",
  lastMessageAgentId: "bot-1",
  unread: false,
  createdAt: "2026-10-01T09:00:00.000Z",
};

/**
 * A person with their Bot and its one conversation — with none, every screen sends them to make
 * one — and whatever else the screen under test is told.
 */
function account(extra: ApiAnswer = () => undefined): ApiAnswer {
  return (request) => {
    const told = extra(request);
    if (told) return told;
    const { pathname } = request;
    if (pathname === "/api/agents") return json({ agents: [BOT] });
    if (pathname === "/api/channels") return json({ channels: [CONVERSATION] });
    if (pathname === "/api/agents/bot-1/day") {
      return json({
        day: "2026-10-03",
        zone: "Asia/Seoul",
        items: [],
        more: false,
      });
    }
    if (pathname === "/api/feed/unseen") return json({ count: 0 });
    return undefined;
  };
}

async function screen(path: string, extra?: ApiAnswer) {
  const view = await mountApp({ path, api: account(extra) });
  const main = view.main();
  if (!main) throw new Error("the app shell did not draw its main pane");
  return {
    ...view,
    main,
    /** Everything under a selector, as the words a person reads. */
    said: (selector: string) =>
      [...main.querySelectorAll(selector)].map(
        (element) => element.textContent?.trim() ?? "",
      ),
    count: (selector: string) => main.querySelectorAll(selector).length,
    one: (selector: string) => {
      const found = main.querySelector<HTMLElement>(selector);
      if (!found) throw new Error(`nothing matches ${selector}`);
      return found;
    },
  };
}

/** The screens, by the title each draws. Each is added here by the change that cut its words. */
const SCREENS = [["Updates", "/feed"]] as const;

describe("a page's title stands alone", () => {
  /*
   * `PageShell` still takes a `description` — 설정 and 관리 are configuration, mostly reading, and
   * have not had this pass — so nothing in the types stops an everyday screen handing it one again.
   * This does: the header is the title's row and nothing under it.
   */
  for (const [title, path] of SCREENS) {
    test(`${title} opens on its title, with no sentence under it`, async () => {
      const view = await screen(path);
      const header = view.one("header");
      expect({
        titles: [...header.querySelectorAll("h1")].map((h1) => h1.textContent),
        sentences: header.querySelectorAll("p").length,
        rows: header.children.length,
      }).toEqual({ titles: [title], sentences: 0, rows: 1 });
    });
  }
});

describe("소식", () => {
  const ROUTINE = {
    id: "routine-1",
    agentId: "bot-1",
    name: "소식",
    summary: null,
    instruction: "소식 스킬대로 올려 줘:\n- 업종 뉴스\n- 이번 주 날씨",
    enabled: true,
    pausedReason: null,
    nextRunAt: "2026-10-05T21:30:00.000Z",
    dailyLocal: "06:30",
    dailyTimeZone: "Asia/Seoul",
  };
  const POST = {
    id: "feed_0f8c1c62-4bd6-4d2c-9a5b-1b7a3e0a9c11",
    agentId: "bot-1",
    routineId: "routine-1",
    topic: "업종 뉴스",
    title: "배달 수수료가 내려요",
    body: "다음 달부터 중개 수수료가 내려가요.\n작은 가게부터 적용돼요.",
    sources: [{ title: "공지", url: "https://news.example.com/1" }],
    createdAt: "2026-10-03T21:30:00.000Z",
    seen: true,
    liked: false,
  };
  const feed = (page: {
    posts?: unknown[];
    routines?: unknown[];
  }): ApiAnswer => {
    return ({ pathname, method }) => {
      if (pathname === "/api/feed" && method === "GET") {
        return json({
          posts: page.posts ?? [],
          next: null,
          unseen: 0,
          routines: page.routines ?? [],
        });
      }
      if (pathname.startsWith("/api/feed/") && method === "POST") {
        return json({ liked: true, hidden: true });
      }
      return undefined;
    };
  };

  test("before there is a 소식 routine: one line saying what will come, and the one press", async () => {
    const view = await screen("/feed", feed({}));
    const make = view.one("[data-feed-make]");
    // The line names what the press will look for; nothing else is said, and nothing else is offered.
    expect(
      [...make.querySelectorAll("p")]
        .map((line) => line.textContent ?? "")
        .filter(Boolean),
    ).toEqual([
      "Every morning, posted here: News about what I am interested in, This week's weather",
    ]);
    expect(
      [...make.querySelectorAll("button, a")].map((press) => press.textContent),
    ).toEqual(["Get updates every morning"]);
    expect(ko["Every morning, posted here: {topics}"]).toContain("{topics}");
  });

  test("the first day's tour: a stop is one line under its place's icon, and the place's name", async () => {
    const view = await screen("/feed", feed({}));
    const stops = [...view.main.querySelectorAll("[data-tour-stop]")];
    expect(stops).toHaveLength(5);
    for (const stop of stops) {
      // The icon, then two lines of words: what the place does, and what it is called.
      expect({
        stop: stop.getAttribute("data-tour-stop"),
        icons: stop.querySelectorAll("svg").length,
        lines: [...stop.querySelectorAll("span > span")].length,
      }).toEqual({
        stop: stop.getAttribute("data-tour-stop"),
        icons: 1,
        lines: 2,
      });
    }
    expect(view.said('[data-tour-stop="ideas"]')).toEqual([
      "Things worth handing me, one press eachIdeas",
    ]);
  });

  test("with a routine and nothing posted: one line, and the card's second press is a named pencil", async () => {
    const view = await screen("/feed", feed({ routines: [ROUTINE] }));
    expect(view.said("[data-feed-empty]")).toEqual(["Nothing posted yet."]);
    expect(view.count("[data-feed-make]")).toBe(0);
    const change = view.one("[data-feed-change]");
    expect({
      words: change.textContent,
      icon: change.querySelectorAll("svg").length,
      name: change.getAttribute("aria-label"),
      tip: change.getAttribute("title"),
      // Still the same press: the routine's name, in a sentence, in the conversation's box.
      goes: change.getAttribute("href")?.startsWith("/channel/ch-1?draft="),
    }).toEqual({
      words: "",
      icon: 1,
      name: "Change in the conversation",
      tip: "Change in the conversation",
      goes: true,
    });
    // The card's own verb keeps its words.
    expect(view.said("[data-feed-run]")).toEqual(["Make now"]);
  });

  test("a post: no line repeating the card, and its three presses are icons named for it", async () => {
    const view = await screen(
      "/feed",
      feed({ routines: [ROUTINE], posts: [POST] }),
    );
    const post = view.one("[data-feed-post]");
    // The label and when, the title, the words, the page it came from — and nothing after them.
    expect(
      [...post.querySelectorAll("p, h3, li")].map((line) => line.textContent),
    ).toEqual([
      "배달 수수료가 내려요",
      "다음 달부터 중개 수수료가 내려가요.\n작은 가게부터 적용돼요.",
      "공지",
    ]);
    expect(post.textContent).not.toContain("Why this");
    const presses = [...post.querySelectorAll("button")].map((press) => ({
      words: press.textContent,
      icons: press.querySelectorAll("svg").length,
      name: press.getAttribute("aria-label"),
      tip: press.getAttribute("title"),
    }));
    expect(presses).toEqual([
      {
        words: "",
        icons: 1,
        name: "Hide “배달 수수료가 내려요”",
        tip: "Hide",
      },
      {
        words: "",
        icons: 1,
        name: "Like “배달 수수료가 내려요”",
        tip: "Like",
      },
      {
        words: "",
        icons: 1,
        name: "Talk about “배달 수수료가 내려요”",
        tip: "Talk about it",
      },
    ]);
    for (const key of [
      "Hide “{title}”",
      "Like “{title}”",
      "Talk about “{title}”",
    ]) {
      expect(ko[key]).toContain("{title}");
    }
  });

  test("the icons still do what the words did: like, hide with its way back, and talk", async () => {
    const view = await screen(
      "/feed",
      feed({ routines: [ROUTINE], posts: [POST] }),
    );
    const sent = () =>
      view.requests
        .filter((request) => request.method === "POST")
        .map((request) => [request.pathname, request.body]);

    await view.click(view.one("[data-feed-like]"));
    expect(sent()).toContainEqual([
      `/api/feed/${POST.id}/like`,
      { liked: true },
    ]);
    expect(view.one("[data-feed-like]").getAttribute("aria-pressed")).toBe(
      "true",
    );

    await view.click(view.one("[data-feed-hide]"));
    expect(sent()).toContainEqual([
      `/api/feed/${POST.id}/hide`,
      { hidden: true },
    ]);
    expect(view.count("[data-feed-post]")).toBe(0);
    // What hiding does is still said in words, with the press that takes it back.
    expect(view.main.textContent).toContain(
      "Hidden. The next updates will pick fewer like it.",
    );
    expect(view.buttonNamed("Undo")?.textContent).toBe("Undo");
  });

  test("이야기하기 opens the conversation, by the bubble", async () => {
    const view = await screen(
      "/feed",
      feed({ routines: [ROUTINE], posts: [POST] }),
    );
    await view.click(view.one("[data-feed-discuss]"));
    await view.waitFor(
      () => view.router.state.location.pathname === "/channel/ch-1",
      "the conversation to open",
    );
    expect(view.router.state.location.pathname).toBe("/channel/ch-1");
  });
});
