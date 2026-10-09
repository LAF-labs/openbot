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

/**
 * What the screen drew.
 *
 * It left out what a Bot's face drew into itself: a frame loop that rewrote its SVG every frame, so
 * a page with a face never looked the same twice and the loop below ran out its 150 looks (measured
 * 2026-10-04: 13 s of the gate). The Bot has no face since 2026-10-09, and a screen that stops
 * changing is the whole of what is drawn.
 */
function drawnOf(main: HTMLElement): string {
  return main.innerHTML;
}

async function screen(path: string, extra?: ApiAnswer) {
  const view = await mountApp({ path, api: account(extra) });
  const main = view.main();
  if (!main) throw new Error("the app shell did not draw its main pane");
  /*
   * A SCREEN IS HANDED OVER ONCE IT HAS STOPPED CHANGING. The shell is up when `mountApp` returns;
   * what the screen draws from its own queries arrives on later turns of the loop — the next one
   * on an idle machine, several on a busy one. The tests below ask for what a screen drew the
   * moment they have it, and one of them asked too soon once in four runs of the gate: "nothing
   * matches [data-feed-discuss]", the post not yet drawn, in a run that had three other suites
   * going beside it. Three looks in a row that find the same page, 20ms apart, is "drawn".
   */
  let drawn = drawnOf(main);
  for (let same = 0, looks = 0; same < 3 && looks < 150; looks += 1) {
    await view.settle(20);
    const now = drawnOf(main);
    same = now === drawn ? same + 1 : 0;
    drawn = now;
  }
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
const SCREENS = [
  ["Updates", "/feed"],
  ["Ideas", "/ideas"],
  ["Goals", "/goals"],
  ["Made", "/made"],
  ["Routines", "/routines"],
  ["Skills", "/skills"],
  ["Notebook", "/notebook"],
] as const;

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

describe("아이디어", () => {
  const ASK = { key: "price-compare", state: "ready", via: [], needs: [] };
  const ROUTINE = { key: "word-quiz", state: "ready", via: [], needs: [] };
  const WAITS = {
    key: "review-replies",
    state: "connect",
    via: [],
    needs: [
      { kind: "site", id: "baemin-ceo" },
      { kind: "site", id: "naver-smartplace" },
    ],
  };
  const ideas = (
    cards: unknown[],
    persona: string | null = null,
  ): ApiAnswer => {
    return ({ pathname }) =>
      pathname === "/api/ideas" ? json({ persona, ideas: cards }) : undefined;
  };
  const card = (view: Awaited<ReturnType<typeof screen>>, key: string) =>
    view.one(`[data-idea="${key}"]`);

  test("a card is one line — what the Bot will do — under its category's icon", async () => {
    // A student, on a card the catalogue leads with for students: nothing says so in words.
    const view = await screen("/ideas", ideas([ASK, ROUTINE], "student"));
    const ask = card(view, "price-compare");
    const press = ask.querySelector("a");
    expect({
      words: press?.textContent,
      lines: press?.querySelectorAll(":scope > span > span").length,
      // The category is its icon, named when asked; what comes out is the card's own tooltip.
      category: ask
        .querySelector("[data-idea-category]")
        ?.getAttribute("title"),
      icon: ask.querySelectorAll("[data-idea-category] svg").length,
      tip: press?.getAttribute("title"),
    }).toEqual({
      words: "I'll compare prices on Naver Shopping",
      lines: 1,
      category: "Money and tax",
      icon: 1,
      tip: "The five lowest prices, with links.",
    });
    expect(view.count("[data-idea-waits]")).toBe(0);
  });

  test("a routine is marked by 루틴's clock, which says what a sentence under every one said", async () => {
    const view = await screen("/ideas", ideas([ASK, ROUTINE]));
    const marks = view.main.querySelectorAll("[data-idea-repeats]");
    expect(marks).toHaveLength(1);
    const mark = card(view, "word-quiz").querySelector("[data-idea-repeats]");
    const SAID =
      "It repeats at the time in the sentence. Change the time before you send it.";
    expect({
      words: mark?.textContent,
      icon: mark?.querySelectorAll("svg").length,
      name: mark?.getAttribute("aria-label"),
      tip: mark?.getAttribute("title"),
    }).toEqual({ words: "", icon: 1, name: SAID, tip: SAID });
    expect(ko[SAID]).toBeTruthy();
    // Nothing but the title is drawn as words.
    expect(card(view, "word-quiz").querySelector("a")?.textContent).toBe(
      "I'll quiz you on ten English words every evening",
    );
  });

  test("a card that waits on a connection still says so in words, and still goes to 연결", async () => {
    const view = await screen("/ideas", ideas([WAITS]));
    const waiting = card(view, "review-replies");
    expect(view.said("[data-idea-waits]")).toEqual([
      "Can do this once one is connected: Baemin for Owners · Naver Smart Place",
    ]);
    expect(waiting.querySelector("a")?.getAttribute("href")).toBe(
      "/settings/connected-accounts",
    );
    // A routine that cannot be asked yet is not marked as one: its line is what it waits on.
    expect(view.count("[data-idea-repeats]")).toBe(0);
  });

  test("the press is what it was: the sentence in the conversation's box, for the person to send", async () => {
    const view = await screen("/ideas", ideas([ASK]));
    const href = card(view, "price-compare")
      .querySelector("a")
      ?.getAttribute("href");
    const address = new URL(href ?? "", "http://localhost");
    expect({
      path: address.pathname,
      draft: address.searchParams.get("draft"),
    }).toEqual({
      path: "/channel/ch-1",
      draft:
        "Compare the five lowest prices on Naver Shopping for this product: ",
    });
    // 다음에 is still behind ⋯, named for its card.
    expect(
      card(view, "price-compare")
        .querySelector("button")
        ?.getAttribute("aria-label"),
    ).toBe("Options for “I'll compare prices on Naver Shopping”");
    // Drawing the page asks for the cards and writes nothing about them.
    expect(
      view.requests
        .filter((request) => request.pathname.startsWith("/api/ideas"))
        .map((request) => `${request.method} ${request.pathname}`),
    ).toEqual(["GET /api/ideas"]);
  });

  test("with every idea put away, the page says so in one line", async () => {
    const view = await screen("/ideas", ideas([]));
    expect(view.said("[data-ideas-empty]")).toEqual(["No ideas left."]);
    expect(ko["No ideas left."]).toBeTruthy();
  });
});

describe("목표", () => {
  const goal = (over: Record<string, unknown>) => ({
    agentId: "bot-1",
    measure: null,
    dueOn: null,
    status: "active",
    momentum: "on_track",
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    lastEntryAt: "2026-10-01T09:00:00.000Z",
    entryCount: 3,
    latestValue: null,
    routines: [],
    ...over,
  });
  const WATCHED = goal({
    id: "goal-1",
    category: "study",
    title: "12월 토익 800점",
    target: "12월 정기 시험에서 800점 넘기",
    measure: { unit: "점", start: 720, goal: 800 },
    latestValue: 760,
    dueOn: "2026-12-20",
  });
  const PLAIN = goal({
    id: "goal-2",
    category: "health",
    title: "주 3회 30분 걷기",
    target: "월·수·금 저녁에 30분씩 걷기",
    momentum: "at_risk",
  });
  const goals = (list: unknown[]): ApiAnswer => {
    return ({ pathname }) => {
      if (pathname === "/api/goals") {
        return json({ goals: list, active: list.length });
      }
      if (pathname === "/api/goals/goal-1") {
        return json({ goal: WATCHED, entries: [] });
      }
      return undefined;
    };
  };

  test("before any goal: the seven kinds, and one line saying what will be here", async () => {
    const view = await screen("/goals", goals([]));
    expect(view.count("[data-goal-categories] button")).toBe(7);
    expect(view.said("[data-goals-empty]")).toEqual([
      "Goals you set in the conversation are kept here.",
    ]);
    // No goal the person does not have is drawn as an example of one.
    expect(view.count("[data-goal]")).toBe(0);
    expect(view.main.textContent).not.toContain("Example");
    expect(ko["Goals you set in the conversation are kept here."]).toBeTruthy();
  });

  test("a goal's row: its title and how it is going, and one line under them", async () => {
    const view = await screen("/goals", goals([WATCHED, PLAIN]));
    const row = (id: string) => {
      const found = view.one(`[data-goal="${id}"]`);
      return {
        lines: [...found.querySelectorAll(":scope > span > span")].map(
          (line) => line.textContent,
        ),
        // The category is the icon, named when asked — not a word beside it.
        category: found.querySelector(":scope > span")?.getAttribute("title"),
      };
    };
    expect(row("goal-1")).toEqual({
      // What it watches: the day it is due and where the number stands.
      lines: [
        "12월 토익 800점On track",
        "Until December 20 · Now 760 · goal 800점",
      ],
      category: "Study and growth",
    });
    expect(row("goal-2")).toEqual({
      // A goal that watches neither says its target, which is all it has.
      lines: [
        "주 3회 30분 걷기Slipping a little",
        "월·수·금 저녁에 30분씩 걷기",
      ],
      category: "Health",
    });
  });

  test("a goal opened: the press that changes it is a named pencil, and the ones that settle it keep their words", async () => {
    const view = await screen("/goals?goal=goal-1", goals([WATCHED]));
    await view.waitFor(
      () => view.count("[data-goal-detail] h2") === 1,
      "the goal to open",
    );
    const detail = view.one("[data-goal-detail]");
    const change = view.one("[data-goal-change]");
    const address = new URL(change.getAttribute("href") ?? "", "http://x");
    expect({
      words: change.textContent,
      icon: change.querySelectorAll("svg").length,
      name: change.getAttribute("aria-label"),
      tip: change.getAttribute("title"),
      // The same press: the goal named in a sentence in the conversation's box.
      path: address.pathname,
      draft: address.searchParams.get("draft"),
    }).toEqual({
      words: "",
      icon: 1,
      name: "Change it in the conversation",
      tip: "Change it in the conversation",
      path: "/channel/ch-1",
      draft: "Change the goal “12월 토익 800점” like this: ",
    });
    expect(
      [...detail.querySelectorAll("button")].map((press) => press.textContent),
    ).toEqual(["Mark as done", "Stop this goal", "Delete"]);
    expect(view.said("[data-goal-timeline-empty]")).toEqual([
      "What you tell the Bot about it is logged here.",
    ]);
  });

  test("the sheet a kind opens still says a conversation follows — its button sends a message", () => {
    /*
     * 대화에서 시작 is the one press on this page that sends for the person, so the sentence before
     * it keeps the word. Read from the dictionary: the sheet is a dialog, and Base UI decides once
     * per process whether one can open (`confirm-dialog.test.tsx`).
     */
    const said =
      ko[
        "First I'll ask you a few things in the conversation and we'll shape the goal together."
      ];
    expect(said).toContain("대화");
    expect(ko["Start in the conversation"]).toBe("대화에서 시작");
  });
});

describe("만든 것", () => {
  const item = (tool: string, shelf: string, title: string | null) => ({
    tool,
    shelf,
    title,
    at: "2026-10-02T08:05:00.000Z",
    channelId: "ch-1",
    messageId: `msg-${tool}`,
  });
  const made = (items: unknown[]): ApiAnswer => {
    return ({ pathname, url }) => {
      if (pathname !== "/api/agents/bot-1/made") return undefined;
      const shelf = url.searchParams.get("shelf");
      return json({
        items: shelf
          ? items.filter((one) => (one as { shelf: string }).shelf === shelf)
          : items,
        next: null,
      });
    };
  };

  test("a card's kind is its icon: the word is beside the time only where it says more", async () => {
    const view = await screen(
      "/made",
      made([
        item("showFile", "file", "9월 정산.csv"),
        item("markdownTable", "table", "메뉴 가격표"),
        item("showBarChart", "table", "요일별 매출"),
        item("showChecklist", "checklist", null),
      ]),
    );
    const cards = [...view.main.querySelectorAll("[data-made-item]")].map(
      (card) => ({
        kind: card.getAttribute("data-made-item"),
        title: card.querySelector("span > span")?.textContent,
        // What the muted line says before its time.
        beside: (
          card.querySelector("[data-made-when]")?.textContent ?? ""
        ).includes(" · "),
        icon: card.querySelector(":scope > span")?.getAttribute("title"),
      }),
    );
    expect(cards).toEqual([
      // The file icon says 파일, the table icon 표: neither is said again in words.
      { kind: "showFile", title: "9월 정산.csv", beside: false, icon: "File" },
      {
        kind: "markdownTable",
        title: "메뉴 가격표",
        beside: false,
        icon: "Table",
      },
      // A chart sits under the table icon, so its kind is still a word.
      {
        kind: "showBarChart",
        title: "요일별 매출",
        beside: true,
        icon: "Bar chart",
      },
      // Untitled, it is called by its kind — once.
      {
        kind: "showChecklist",
        title: "Checklist",
        beside: false,
        icon: "Checklist",
      },
    ]);
    expect(
      view.one('[data-made-item="showBarChart"] [data-made-when]').textContent,
    ).toStartWith("Bar chart · ");
  });

  test("with nothing made: one line saying what will be here, and the header's one verb", async () => {
    const view = await screen("/made", made([]));
    expect(view.said("[data-made-empty]")).toEqual([
      "Tables, checklists, writing and files your Bot makes are kept here.",
    ]);
    expect(view.said("[data-made-start]")).toEqual(["Make"]);
    expect(
      ko["Tables, checklists, writing and files your Bot makes are kept here."],
    ).toBeTruthy();
  });
});

describe("루틴", () => {
  const routine = (over: Record<string, unknown> = {}) => ({
    id: "routine-1",
    agentId: "bot-1",
    name: "아침 브리핑",
    instruction: "매일 아침이다. 오늘 일정과 날씨를 세 줄로 알린다.",
    summary: "오늘 날씨와 일정을 세 줄로 알려 드려요.",
    scheduleKind: "daily",
    intervalMinutes: null,
    dailyLocal: "07:30",
    dailyTimeZone: "Asia/Seoul",
    dailyDays: [],
    enabled: true,
    pausedReason: null,
    keepRunning: false,
    lastRunAt: "2026-10-02T22:30:00.000Z",
    nextRunAt: "2026-10-04T22:30:00.000Z",
    ...over,
  });
  const routines = (list: unknown[]): ApiAnswer => {
    return ({ pathname }) => {
      if (pathname === "/api/routines") return json({ routines: list });
      if (pathname === "/api/routines/suggestions") {
        return json({ suggestions: [] });
      }
      if (pathname.endsWith("/runs")) return json({ runs: [] });
      if (pathname.endsWith("/notepad")) {
        return json({ notepad: { entries: [], updatedAt: null } });
      }
      return undefined;
    };
  };

  test("a row is its name and one line, and opens by its chevron — not by a word", async () => {
    const view = await screen("/routines", routines([routine()]));
    const row = view.one("[data-routine-row]");
    const lines = () =>
      [...row.querySelectorAll(":scope > span")].map(
        (line) => line.textContent,
      );
    expect(lines()).toHaveLength(2);
    expect(lines()[0]).toBe("아침 브리핑");
    // When it goes, and when it last went: the evidence that the switch kept its promise.
    expect(lines()[1]).toContain("7:30");
    expect(lines()[1]).toContain(" · Last ");
    expect({
      chevrons: row.querySelectorAll("svg").length,
      open: row.getAttribute("aria-expanded"),
      tip: row.getAttribute("title"),
    }).toEqual({ chevrons: 1, open: "false", tip: "Details" });
    // What it does and when it goes next are not on the row.
    expect(view.count("[data-routine-summary]")).toBe(0);
    expect(view.count("[data-routine-next]")).toBe(0);

    await view.click(row);
    expect({
      open: row.getAttribute("aria-expanded"),
      tip: row.getAttribute("title"),
      summary: view.said("[data-routine-summary]"),
      next: view.count("[data-routine-next]"),
    }).toEqual({
      open: "true",
      tip: "Less",
      summary: ["오늘 날씨와 일정을 세 줄로 알려 드려요."],
      next: 1,
    });
    expect(view.one("[data-routine-next]").textContent).toStartWith("Next ");
    expect(view.main.textContent).toContain("What the Bot is told each time");
  });

  test("지금 실행 keeps its words: a clock named only by a tooltip was a press nobody found", async () => {
    // The first-hour walk, 2026-09-27 (`routine-form.test.ts` holds the source to it).
    const view = await screen("/routines", routines([routine()]));
    expect(view.buttonNamed("Run now")?.querySelectorAll("svg")).toHaveLength(
      1,
    );
  });

  test("a routine that is off says nothing about a next run, and one that never ran nothing about a last", async () => {
    // Measured 2026-10-04: a routine switched off drew the run it had missed, "다음 실행 어제".
    const view = await screen(
      "/routines",
      routines([routine({ enabled: false, lastRunAt: null })]),
    );
    const row = view.one("[data-routine-row]");
    expect(view.one("[data-routine-line]").textContent).not.toContain("·");
    await view.click(row);
    expect(view.count("[data-routine-next]")).toBe(0);
    expect(view.said("[data-routine-summary]")).toEqual([
      "오늘 날씨와 일정을 세 줄로 알려 드려요.",
    ]);
  });

  test("a routine the unread rule paused still says why, on its row, in words", async () => {
    const view = await screen(
      "/routines",
      routines([routine({ enabled: false, pausedReason: "unread" })]),
    );
    const row = view.one("[data-routine-row]");
    expect(
      [...row.querySelectorAll(":scope > span")].map(
        (line) => line.textContent,
      )[2],
    ).toBe("Paused — its results went unread for a while");
    // And the banner over the list keeps every word: what it did, why, and what each press does.
    expect(view.main.textContent).toContain(
      "Keep running means they will not stop like this again, read or not.",
    );
  });

  test("with no routine: one line, no face over it, and the one verb is the header's", async () => {
    const view = await screen("/routines", routines([]));
    const empty = view.one("[data-routines-empty]");
    expect(empty.querySelector("svg")).toBeNull();
    expect({
      said: [...empty.querySelectorAll("p")].map((line) => line.textContent),
      presses: empty.querySelectorAll("a, button").length,
    }).toEqual({
      said: ["What your Bot does on its own at set times is kept here."],
      presses: 0,
    });
    expect(
      [...view.main.querySelectorAll('a[href="/routines?new=true"]')].map(
        (press) => press.textContent,
      ),
    ).toEqual(["New routine"]);
  });
});

describe("스킬", () => {
  const skill = (over: Record<string, unknown>) => ({
    ownerUserId: null,
    summary: "",
    instructions: "",
    origin: "personal",
    installedBy: null,
    grantedTo: [],
    ...over,
  });
  const BUILT_IN = skill({
    id: "skill-1",
    slug: "네이버블로그",
    title: "네이버 블로그 글 찾아 읽기",
    origin: "built_in",
  });
  const WORKSPACE = skill({
    id: "skill-2",
    slug: "standup",
    title: "Standup notes",
  });
  const skills = (list: unknown[]): ApiAnswer => {
    return ({ pathname }) =>
      pathname === "/api/plugins"
        ? json({ catalogue: [], servers: [], skills: list })
        : undefined;
  };

  test("a section's title stands alone: no sentence under 내 스킬, 기본 스킬 or 워크스페이스 스킬", async () => {
    const view = await screen("/skills", skills([BUILT_IN, WORKSPACE]));
    const sections = [...view.main.querySelectorAll("section")].map(
      (section) => ({
        title: section.querySelector("h2")?.textContent,
        // `PageSection` draws its description as the paragraph right under the title's row.
        sentences: section.querySelectorAll(":scope > p").length,
      }),
    );
    expect(sections).toEqual([
      { title: "Your skills", sentences: 0 },
      { title: "Built-in skills", sentences: 0 },
      { title: "Workspace skills", sentences: 0 },
    ]);
  });

  test("with none of the person's own: one line that says how one is called, no face over it, and the header's verb", async () => {
    const view = await screen("/skills", skills([BUILT_IN]));
    const empty = view.one("[data-skills-empty]");
    expect(empty.querySelector("svg")).toBeNull();
    expect({
      said: [...empty.querySelectorAll("p")].map((line) => line.textContent),
      presses: empty.querySelectorAll("a, button").length,
    }).toEqual({
      said: [
        "Save something you ask for often, and call it in the conversation by / and its name.",
      ],
      presses: 0,
    });
    expect(
      [...view.main.querySelectorAll('a[href="/skills?new=true"]')].map(
        (press) => press.textContent,
      ),
    ).toEqual(["New skill"]);
    // A built-in skill's row still shows the one thing a person types.
    expect(view.said("section code")).toEqual(["/네이버블로그"]);
  });
});

describe("수첩", () => {
  const LEARNED = {
    id: "m-1",
    slot: null,
    content: "금요일 오후에는 회의가 있어서 답이 늦다.",
    source: "bot",
    confirmed: false,
    carried: true,
    createdAt: "2026-09-30T03:00:00.000Z",
    evidence: {
      trust: "evidence",
      confidence: 0.9,
      channelId: "ch-1",
      messageId: "msg-1",
      excerpt: "금요일 오후엔 회의라 답 늦을 수 있어",
    },
  };
  const HOURS = {
    id: "m-slot",
    slot: "hours",
    content: "평일 10:00–21:00",
    source: "owner",
    confirmed: true,
    carried: true,
    createdAt: "2026-09-20T03:00:00.000Z",
  };
  const NOTICED = {
    id: "g-1",
    content: "이 사람은 짧은 답을 원한다.",
    source: "dream",
    day: "2026-09-28",
    createdAt: "2026-09-28T05:00:00.000Z",
  };
  const REWRITTEN = { ...NOTICED, id: "g-2", source: "owner" };
  const notebook = (
    lines: { memories?: unknown[]; guidance?: unknown[] } = {},
    me?: Record<string, unknown>,
  ): ApiAnswer => {
    return ({ pathname }) => {
      if (pathname === "/api/agents/bot-1/memories") {
        return json({
          memories: lines.memories ?? [],
          used: 120,
          cap: 2200,
          guidance: lines.guidance ?? [],
        });
      }
      if (me && pathname === "/api/me") {
        return json({
          user: {
            id: "user-1",
            email: "dev@laf.local",
            name: "Dev",
            image: null,
            role: "user",
            onboarded: true,
            ...me,
          },
          deployment: { autoReview: true },
        });
      }
      return undefined;
    };
  };
  /** A press as the page draws it: its words, or for an icon the name it carries, marked. */
  const presses = (row: Element) =>
    [...row.querySelectorAll("button, a")].map((press) =>
      press.textContent
        ? press.textContent
        : `icon:${press.getAttribute("aria-label")}|${press.getAttribute("title")}`,
    );

  test("a section's title stands alone — but 일하는 방식 still says when a change reaches the Bot", async () => {
    const view = await screen("/notebook", notebook({ guidance: [NOTICED] }));
    const sections = [...view.main.querySelectorAll("section")].map(
      (section) => ({
        title: section.querySelector("h2")?.textContent,
        sentences: [...section.querySelectorAll(":scope > p")].map(
          (line) => line.textContent,
        ),
      }),
    );
    expect(sections).toEqual([
      { title: "The shop", sentences: [] },
      // Its empty list says what will be here, in one line.
      {
        title: "What it remembers",
        sentences: ["What your Bot learns in conversations appears here."],
      },
      // A consequence, not an explanation: something to know before changing a line.
      {
        title: "How you like to work",
        sentences: ["Changes here reach your Bot from the next day."],
      },
    ]);
    expect(ko["Changes here reach your Bot from the next day."]).toContain(
      "다음 날",
    );
  });

  test("the gauge is the bar and its count, and the bar carries the name", async () => {
    const view = await screen("/notebook", notebook());
    expect(view.said("[data-notebook-room]")).toEqual([
      "120 of 2,200 characters",
    ]);
    expect(view.one("progress").getAttribute("aria-label")).toBe(
      "Room in the Notebook",
    );
    expect(view.main.textContent).not.toContain("Room in the Notebook");
  });

  test("수정 is a named pencil; 맞아요, 잊기 and 지우기 keep their words", async () => {
    const view = await screen(
      "/notebook",
      notebook({ memories: [LEARNED, HOURS], guidance: [NOTICED] }),
    );
    expect(presses(view.one('[data-memory="bot"]'))).toEqual([
      "icon:Show it in the conversation|Show it in the conversation",
      "That's right",
      "icon:Edit|Edit",
      "Forget",
    ]);
    expect(presses(view.one('[data-guidance="dream"]'))).toEqual([
      "icon:Edit|Edit",
      "Clear it",
    ]);
    expect(presses(view.one('[data-notebook-slot="hours"]'))).toEqual([
      "icon:Edit|Edit",
      "Clear it",
    ]);
    // Every icon on the page is a button with one glyph and no words.
    for (const pencil of view.main.querySelectorAll("[data-notebook-edit]")) {
      expect({
        words: pencil.textContent,
        glyphs: pencil.querySelectorAll("svg").length,
      }).toEqual({ words: "", glyphs: 1 });
    }
  });

  test("an empty shop line's press is the pencil, named for the line it writes", async () => {
    const view = await screen("/notebook", notebook({ memories: [HOURS] }));
    expect(presses(view.one('[data-notebook-slot="shop_name"]'))).toEqual([
      "icon:Write the shop name|Write the shop name",
    ]);
    expect(presses(view.one('[data-notebook-slot="offer"]'))).toEqual([
      "icon:Write what you sell|Write what you sell",
    ]);
    // The row says its name once.
    expect(view.one('[data-notebook-slot="shop_name"]').textContent).toBe(
      "Shop name",
    );

    // And the pencil still opens the box, with the line's own example in it.
    const pencil = view.one('[data-notebook-slot="shop_name"] button');
    await view.click(pencil);
    expect(
      view
        .one('[data-notebook-slot="shop_name"] textarea')
        .getAttribute("placeholder"),
    ).toBe("e.g. Miso Café");
  });

  test("내 정보 is one row: what is set, and a named way there — nothing about what is not set", async () => {
    const bare = await screen("/notebook", notebook());
    const row = bare.one("[data-notebook-my-info]");
    expect(row.textContent).toBe("My shop");
    expect(presses(row)).toEqual([
      "icon:Change these on My shop|Change these on My shop",
    ]);
    expect(row.querySelector("a")?.getAttribute("href")).toBe("/settings/shop");
    await bare.unmount();

    const set = await screen(
      "/notebook",
      notebook(
        {},
        {
          shop: { kind: "food", places: ["naver-smartplace"] },
          whereabouts: {
            place: "춘천",
            timeZone: "Asia/Seoul",
            locale: "ko-KR",
          },
        },
      ),
    );
    expect(set.one("[data-notebook-my-info]").textContent).toBe(
      "My shopRestaurant or café · Naver Smart Place · 춘천",
    );
  });

  test("what the Bot learned a line from is one line: the words, and a named way back to them", async () => {
    const view = await screen("/notebook", notebook({ memories: [LEARNED] }));
    const learned = view.one("[data-notebook-learned]");
    expect({
      said: learned.textContent,
      heading: learned.getAttribute("title"),
      lines: learned.children.length,
    }).toEqual({
      said: "금요일 오후엔 회의라 답 늦을 수 있어",
      heading: "Where it learned this",
      lines: 2,
    });
  });

  test("a line of 일하는 방식 says who wrote it only where it was not the Bot", async () => {
    const view = await screen(
      "/notebook",
      notebook({ guidance: [NOTICED, REWRITTEN] }),
    );
    expect(
      [...view.one('[data-guidance="dream"]').querySelectorAll("span")].map(
        (line) => line.textContent,
      ),
    ).toEqual([]);
    expect(
      [...view.one('[data-guidance="owner"]').querySelectorAll("span")].map(
        (line) => line.textContent,
      ),
    ).toEqual(["You wrote this"]);
  });

  test("the box for a new line is anybody's example, and counts once there is something to count", async () => {
    const view = await screen("/notebook", notebook());
    const box = view.one(
      'textarea[aria-label="Write something down for your Bot"]',
    );
    expect(box.getAttribute("placeholder")).toBe(
      "e.g. I have meetings on Friday afternoons.",
    );
    // No shop in the example: the box is everybody's (CLAUDE.md, the persona is a hint).
    expect(ko["e.g. I have meetings on Friday afternoons."]).not.toMatch(
      /가게|손님|사장/,
    );
    expect(view.count("[data-line-count]")).toBe(0);
    await view.type(box as HTMLTextAreaElement, "메모");
    expect(view.said("[data-line-count]")).toEqual(["2/400"]);
  });
});
