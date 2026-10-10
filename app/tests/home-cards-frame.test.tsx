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
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { acted } from "./support/turn-server";

/*
 * 홈'S FIRST CARDS, IN THE APP'S OWN FRAME (2026-10-10, `docs/laf/redesign-2026-10.md` §1 and §2,
 * piece 3-4).
 *
 * `home-cards.test.ts` has what each card says. This is the panel they stand in, mounted as the
 * app mounts it: that a first day's 홈 has none of them; that with something to say each is drawn
 * under 오늘, in the menu's order, as the way to its page; that the card of the page that is open
 * is not drawn; that 소식's posts are not marked seen by a card; that an answer that did not come,
 * or came in the wrong shape, costs one card and never 오늘; and that a Bot's answer landing asks
 * for all three again — the moment the working poll misses when a turn is short.
 */

type View = Awaited<ReturnType<typeof mountApp>>;
type Api = Parameters<typeof mountApp>[0]["api"];
type Request = Parameters<NonNullable<Api>>[0];

/*
 * The app's socket, kept where a test can speak down it. `support/app-router.tsx` installs one that
 * records nothing; this one is installed over it for this file, and put back with the document.
 */
let sockets: RecordingSocket[] = [];
class RecordingSocket {
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  send() {}

  close() {
    this.onclose?.();
  }
}

beforeAll(async () => {
  await installAppDom();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = RecordingSocket;
  (window as unknown as { WebSocket: unknown }).WebSocket = RecordingSocket;
}, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
  sockets = [];
});
setDefaultTimeout(20_000);
afterAll(removeAppDom);

const CHANNEL = {
  id: "c-1",
  name: "bot-1",
  agentIds: ["bot-1"],
  threadId: "thread-c-1",
  active: true,
  lastMessage: "…",
  lastMessageAt: "2026-09-20T00:00:00Z",
  lastMessageAgentId: "bot-1",
  unread: false,
  createdAt: "2026-09-20T00:00:00Z",
};

const POST = {
  id: "p-1",
  agentId: "bot-1",
  routineId: null,
  topic: "weather",
  title: "이번 주 날씨: 주말에 비",
  body: "…",
  sources: [],
  createdAt: "2026-10-10T06:30:00.000Z",
  seen: false,
  liked: false,
};

const GOAL = {
  id: "g-1",
  agentId: "bot-1",
  category: "study",
  title: "토익 800점 달성",
  target: "12월 말까지 800점",
  measure: { unit: "점", start: 720, goal: 800 },
  dueOn: "2026-12-31",
  status: "active",
  momentum: null,
  createdAt: "2026-10-10T06:41:00.000Z",
  updatedAt: "2026-10-10T06:41:00.000Z",
  lastEntryAt: null,
  entryCount: 0,
  latestValue: null,
  routines: [],
};

const MADE = {
  tool: "showChecklist",
  shelf: "checklist",
  title: "이사 준비",
  at: "2026-10-10T06:51:00.000Z",
  channelId: "c-1",
  messageId: "m-1",
};

/** The account: one Bot and its conversation, and whatever the three pages would answer. */
const account =
  (over: (request: Request) => Response | undefined = () => undefined) =>
  (request: Request) => {
    const answered = over(request);
    if (answered) return answered;
    const { pathname } = request;
    if (pathname === "/api/agents") {
      return json({ agents: [agentFixture({ id: "bot-1", name: "초롱" })] });
    }
    if (pathname === "/api/channels") return json({ channels: [CHANNEL] });
    if (pathname === "/api/agents/bot-1/day") {
      return json({
        day: "2026-10-10",
        zone: "Asia/Seoul",
        items: [],
        more: false,
      });
    }
    if (pathname === "/api/routines") return json({ routines: [] });
    if (pathname === "/api/feed/unseen") return json({ count: 2 });
    if (pathname === "/api/feed") {
      return json({ posts: [POST], next: null, unseen: 2, routines: [] });
    }
    if (pathname === "/api/goals") return json({ goals: [GOAL], active: 1 });
    if (pathname === "/api/agents/bot-1/made") {
      return json({ items: [MADE], next: null });
    }
    return undefined;
  };

/** The same account before anything was found, set or made. */
const firstDay = account(({ pathname }) => {
  if (pathname === "/api/feed/unseen") return json({ count: 0 });
  if (pathname === "/api/feed") {
    return json({ posts: [], next: null, unseen: 0, routines: [] });
  }
  if (pathname === "/api/goals") return json({ goals: [], active: 0 });
  if (pathname === "/api/agents/bot-1/made") {
    return json({ items: [], next: null });
  }
  return undefined;
});

const panel = (view: View) =>
  view.host.querySelector("[data-home-panel]") as HTMLElement;
const cards = (view: View) => [
  ...panel(view).querySelectorAll<HTMLAnchorElement>("[data-home-card]"),
];
const drawn = (view: View) => cards(view).map((card) => card.dataset.homeCard);
const card = (view: View, is: string) =>
  cards(view).find((one) => one.dataset.homeCard === is);
const line = (view: View, is: string) =>
  card(view, is)?.querySelector("[data-home-card-line]")?.textContent ?? null;
const figure = (view: View, is: string) => {
  const found = card(view, is)?.querySelector<HTMLElement>(
    "[data-home-card-figure]",
  );
  return found
    ? { kind: found.dataset.homeCardFigure, text: found.textContent }
    : null;
};
const failedHome = (view: View) =>
  view.host.querySelectorAll('[data-failed-section="home"]').length;
const today = (view: View) =>
  [...panel(view).querySelectorAll("h2")].map((heading) => heading.textContent);

const mounted = async (api: Api, path = "/help") => {
  const view = await mountApp({ path, api });
  await view.waitFor(
    () => (panel(view)?.textContent ?? "").includes("Nothing yet today"),
    "오늘 in 홈",
  );
  return view;
};

describe("홈's first cards", () => {
  test("a first day has none: nothing found, set or made is nothing to say, and 홈 is 오늘 alone", async () => {
    const view = await mounted(firstDay);
    await view.settle(120);
    expect(drawn(view)).toEqual([]);
    // No empty list either: there is no box to draw around nothing.
    expect(panel(view).querySelectorAll("[data-home-cards]").length).toBe(0);
    expect(today(view)).toEqual(["Today"]);
  });

  test("with something to say, each stands under 오늘 in the menu's order: a name, one figure, ONE line, and the way to its page", async () => {
    const view = await mounted(account());
    await view.waitFor(() => drawn(view).length === 3, "the three cards");
    expect(drawn(view)).toEqual(["feed", "goals", "made"]);
    expect(cards(view).map((one) => one.getAttribute("href"))).toEqual([
      "/feed",
      "/goals",
      "/made",
    ]);

    // 소식: the newest post, and how many are new — the mark the menu's 소식 wears.
    expect(line(view, "feed")).toBe("이번 주 날씨: 주말에 비");
    expect(figure(view, "feed")).toEqual({ kind: "new", text: "22 new" });
    // 목표: the goal in progress, how many, and its number.
    expect(line(view, "goals")).toBe("토익 800점 달성");
    expect(figure(view, "goals")).toEqual({
      kind: "count",
      text: "11 in progress",
    });
    expect(card(view, "goals")?.textContent).toContain("Now 720 · goal 800점");
    // 만든 것: the newest thing, and when.
    expect(line(view, "made")).toBe("이사 준비");
    expect(figure(view, "made")?.kind).toBe("when");

    // Under 오늘, not over it: the list is what the panel is for.
    const list = panel(view).querySelector("[data-home-cards]") as HTMLElement;
    const heading = panel(view).querySelector("h2") as HTMLElement;
    expect(
      heading.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect([ko.Updates, ko.Goals, ko.Made]).toEqual([
      "소식",
      "목표",
      "만든 것",
    ]);
  });

  test("the card of the page that is open is not drawn, and every other is", async () => {
    const view = await mounted(account(), "/help");
    await view.waitFor(() => drawn(view).length === 3, "the three cards");

    for (const [path, without] of [
      ["/feed", ["goals", "made"]],
      ["/goals", ["feed", "made"]],
      ["/made", ["feed", "goals"]],
      ["/routines", ["feed", "goals", "made"]],
    ] as const) {
      await view.navigate(path);
      await view.waitFor(
        () => drawn(view).join() === without.join(),
        `the cards beside ${path}`,
      );
    }
  });

  test("소식's posts are not marked seen by its card: seen is what 소식's own page showed", async () => {
    const view = await mounted(account());
    await view.waitFor(() => line(view, "feed") !== null, "소식's card");
    await view.settle(200);
    const written = () =>
      view.requests
        .filter(
          (request) =>
            request.pathname.startsWith("/api/feed") &&
            request.method !== "GET",
        )
        .map((request) => `${request.method} ${request.pathname}`);
    expect(written()).toEqual([]);
    // And the button's mark, which says something is new, is still worn.
    expect(
      view.host
        .querySelector("[data-profile-menu]")
        ?.querySelectorAll('[data-mark="new"]').length,
    ).toBe(1);
  });

  test("an answer that did not come costs its own card, and never 오늘 or the others", async () => {
    const view = await mounted(
      account(({ pathname }) => {
        if (pathname === "/api/goals") {
          return json({ error: "laf:unavailable" }, 500);
        }
        if (pathname === "/api/agents/bot-1/made") {
          return json({ code: "laf:made_unavailable" }, 503);
        }
        return undefined;
      }),
    );
    await view.waitFor(() => drawn(view).length === 1, "소식's card alone");
    await view.settle(150);
    expect(drawn(view)).toEqual(["feed"]);
    expect(failedHome(view)).toBe(0);
    expect(today(view)).toEqual(["Today"]);
  });

  test.each([
    ["a list that is not a list", { posts: "x", goals: 7, items: {} }],
    ["nothing at all", null],
    [
      "records that are not records",
      { posts: [3], goals: [null], items: ["x"] },
    ],
  ])(
    "an answer of the wrong shape — %s — is no card and no throw: 오늘 stays",
    async (_, body) => {
      const view = await mounted(
        account(({ pathname }) =>
          pathname === "/api/feed" ||
          pathname === "/api/goals" ||
          pathname === "/api/agents/bot-1/made"
            ? json(body)
            : undefined,
        ),
      );
      await view.settle(200);
      expect(drawn(view)).toEqual([]);
      expect(failedHome(view)).toBe(0);
      expect(today(view)).toEqual(["Today"]);
    },
  );

  test("오늘 lists three of 한 일 in 홈 before the rest is a press away: there are cards under it", async () => {
    const items = [1, 2, 3, 4, 5].map((n) => ({
      kind: "learned",
      memoryId: `m-${n}`,
      at: `2026-10-10T0${n}:00:00.000Z`,
      head: `기억 ${n}`,
    }));
    const view = await mountApp({
      path: "/help",
      api: account(({ pathname }) =>
        pathname === "/api/agents/bot-1/day"
          ? json({ day: "2026-10-10", zone: "Asia/Seoul", items, more: false })
          : undefined,
      ),
    });
    await view.waitFor(
      () => (panel(view)?.textContent ?? "").includes("기억 1"),
      "오늘's rows",
    );
    const text = panel(view).textContent ?? "";
    expect(
      ["기억 1", "기억 2", "기억 3"].every((row) => text.includes(row)),
    ).toBe(true);
    expect(text).not.toContain("기억 4");
    expect(text).toContain("Show 2 more");
  });

  test("a Bot's answer landing asks for all three again — a turn too short for the working poll to have seen", async () => {
    let title = "이사 준비";
    const view = await mounted(
      account(({ pathname }) =>
        pathname === "/api/agents/bot-1/made"
          ? json({ items: [{ ...MADE, title }], next: null })
          : undefined,
      ),
    );
    await view.waitFor(() => line(view, "made") === "이사 준비", "만든 것");
    const asked = (pathname: string) =>
      view.requests.filter((request) => request.pathname === pathname).length;
    const paths = ["/api/feed", "/api/goals", "/api/agents/bot-1/made"];
    const before = paths.map(asked);
    const socket = sockets.at(-1);
    expect(socket?.url).toContain("/api/channels/events");

    // The run made a table and answered, all inside one tick of the poll.
    title = "요일 · 건수";
    await acted(() => {
      socket?.onmessage?.({
        data: JSON.stringify({
          channelId: "c-1",
          lastMessage: "표로 만들었어요.",
          lastMessageAt: "2026-10-10T06:51:30.000Z",
          lastMessageAgentId: "bot-1",
        }),
      });
    });
    await view.waitFor(
      () => line(view, "made") === "요일 · 건수",
      "만든 것's card to name the new table",
    );
    expect(
      paths.map(asked).every((count, at) => count > (before[at] ?? 0)),
    ).toBe(true);

    // The person's own message landing is not a Bot's work ending.
    const quiet = paths.map(asked);
    await acted(() => {
      socket?.onmessage?.({
        data: JSON.stringify({
          channelId: "c-1",
          lastMessage: "고마워",
          lastMessageAt: "2026-10-10T06:52:00.000Z",
        }),
      });
    });
    await view.settle(150);
    expect(paths.map(asked)).toEqual(quiet);
  });
});
