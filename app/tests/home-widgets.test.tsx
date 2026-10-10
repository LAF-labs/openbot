import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { FeedPost } from "../../shared/feed";
import type { GoalView } from "../../shared/goals";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiAnswer,
  type ApiRequest,
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * 소식 · 목표 · 만든 것 IN 홈, UNDER 오늘 (`home-widgets.tsx`; piece 3-4).
 *
 * Each is the top of a screen that already existed, drawn small in a column open on every screen.
 * What that position makes easy to get wrong is held here:
 *
 *  - A WIDGET READS AND NEVER MARKS. 소식's page marks a post seen when it shows it; a widget that
 *    did the same would mark every post seen on arrival, on whatever screen was open, and put out
 *    the dot that says something is new.
 *  - WHAT A DEPLOYMENT DOES NOT HAVE IS NOT DRAWN, and a read that only failed says so.
 *  - 만든 것 IS A BOT'S, so it is not asked for before there is a Bot to name.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
  // The next app mounted reads the storage again (`support/app-router.tsx`).
  localStorage.clear();
});
afterAll(async () => {
  await removeAppDom();
});

const AT = "2026-10-09T03:00:00.000Z";

const post = (id: string, title: string, seen: boolean): FeedPost => ({
  id,
  agentId: "bot-1",
  routineId: null,
  topic: "장사",
  title,
  body: "…",
  sources: [],
  createdAt: AT,
  seen,
  liked: false,
});

const goal = (
  id: string,
  title: string,
  status: GoalView["status"],
  measure: GoalView["measure"] = null,
): GoalView => ({
  id,
  agentId: "bot-1",
  category: "study",
  title,
  target: "",
  measure,
  dueOn: null,
  status,
  momentum: null,
  createdAt: AT,
  updatedAt: AT,
  lastEntryAt: null,
  entryCount: 0,
  latestValue: measure ? 640 : null,
  routines: [],
});

const made = (messageId: string, title: string | null, tool = "showFile") => ({
  tool,
  shelf: "file",
  title,
  at: AT,
  channelId: "c-1",
  messageId,
});

/** The account's one Bot and its conversation, and whatever a test adds on top. */
const account =
  (more: ApiAnswer): ApiAnswer =>
  (request) => {
    const { pathname } = request;
    if (pathname === "/api/agents") {
      return json({ agents: [agentFixture({ id: "bot-1", name: "초롱" })] });
    }
    if (pathname === "/api/channels") {
      return json({
        channels: [
          {
            id: "c-1",
            name: "초롱",
            agentIds: ["bot-1"],
            threadId: "thread-c-1",
            active: true,
            lastMessage: "다 했어요",
            lastMessageAt: AT,
            lastMessageAgentId: "bot-1",
            unread: false,
            createdAt: AT,
          },
        ],
      });
    }
    if (pathname === "/api/agents/bot-1/day") {
      return json({
        day: "2026-10-09",
        zone: "Asia/Seoul",
        items: [],
        more: false,
      });
    }
    return more(request);
  };

/** A deployment with all three lists, each longer than a widget draws. */
const full: ApiAnswer = ({ pathname }) => {
  if (pathname === "/api/feed") {
    return json({
      posts: [
        post("p-1", "이번 주 배달 수수료가 바뀌어요", false),
        post("p-2", "소상공인 정책자금 3차 접수", true),
        post("p-3", "주말 비 소식", true),
        post("p-4", "네 번째 소식", true),
      ],
      next: null,
      unseen: 1,
      routines: [],
    });
  }
  if (pathname === "/api/feed/unseen") return json({ count: 1 });
  if (pathname === "/api/goals") {
    return json({
      goals: [
        goal("g-1", "토익 800점", "active", {
          unit: "점",
          start: 600,
          goal: 800,
        }),
        goal("g-2", "매일 30분 걷기", "active"),
        goal("g-3", "끝낸 목표", "done"),
      ],
      active: 2,
    });
  }
  if (pathname === "/api/agents/bot-1/made") {
    return json({
      items: [made("m-1", "9월 매출 정리"), made("m-2", null)],
      next: null,
    });
  }
  return undefined;
};

type View = Awaited<ReturnType<typeof mountApp>>;

const widget = (view: View, name: string) =>
  view.host.querySelector(`[data-home-widget="${name}"]`) as HTMLElement | null;
const rowsOf = (view: View, name: string) =>
  [...(widget(view, name)?.querySelectorAll("[data-widget-row]") ?? [])].map(
    (row) => ({
      words: row.textContent ?? "",
      to: row.getAttribute("href"),
      press: row as HTMLElement,
    }),
  );
const seenPosts = (requests: ApiRequest[]) =>
  requests.filter(
    (request) =>
      request.method !== "GET" && request.pathname.startsWith("/api/feed"),
  );

describe("the home panel's widgets", () => {
  test("are the top of three screens under 오늘, in one order for everybody, each title the way to the whole of it", async () => {
    const view = await mountApp({ path: "/help", api: account(full) });
    await view.waitFor(
      () =>
        rowsOf(view, "updates").length > 0 && rowsOf(view, "made").length > 0,
      "the widgets' rows",
    );

    const drawn = [...view.host.querySelectorAll("[data-home-widget]")].map(
      (one) => [
        one.getAttribute("data-home-widget"),
        one.querySelector("h2 a")?.getAttribute("href"),
      ],
    );
    expect(drawn).toEqual([
      ["updates", "/feed"],
      ["goals", "/goals"],
      ["made", "/made"],
    ]);
    // 오늘 is the panel's own and comes first: the widgets are under it, in the same column.
    const column = view.host.querySelector("[data-home-content]");
    const headings = [...(column?.querySelectorAll("h2") ?? [])].map(
      (heading) => heading.textContent,
    );
    expect(headings[0]).toBe("Today");
    expect(
      headings.slice(1).map((words) => words?.replace(/\d.*$/, "")),
    ).toEqual(["Updates", "Goals", "Made"]);

    // 소식: three of the four, newest first, each leading to the page — and the one not yet seen
    // is the one that says so.
    expect(rowsOf(view, "updates").map((row) => [row.words, row.to])).toEqual([
      ["이번 주 배달 수수료가 바뀌어요", "/feed"],
      ["소상공인 정책자금 3차 접수", "/feed"],
      ["주말 비 소식", "/feed"],
    ]);
    expect(
      widget(view, "updates")?.querySelectorAll('[data-mark="unseen"]'),
    ).toHaveLength(1);
    expect(
      widget(view, "updates")?.querySelector("[data-unseen-count]")
        ?.textContent,
    ).toBe("11 new");

    // 목표: the two in progress and not the one that is finished, each opening itself on the page.
    await view.waitFor(() => rowsOf(view, "goals").length === 2, "the goals");
    expect(rowsOf(view, "goals").map((row) => row.to)).toEqual([
      "/goals?goal=g-1",
      "/goals?goal=g-2",
    ]);
    expect(rowsOf(view, "goals")[0]?.words).toContain("토익 800점");
    expect(rowsOf(view, "goals")[0]?.words).toContain("640");
    expect(
      widget(view, "goals")?.querySelector("[data-active-goals]")?.textContent,
    ).toBe("22 in progress");

    // 만든 것: a thing with no title is called by its kind, once.
    expect(rowsOf(view, "made").map((row) => row.words)).toEqual([
      "9월 매출 정리File",
      "File",
    ]);
    expect(ko.Updates).toBe("소식");
    expect(ko.Goals).toBe("목표");
    expect(ko.Made).toBe("만든 것");
  });

  test("read and never mark: no post is told to the server as seen, on any screen", async () => {
    const view = await mountApp({ path: "/help", api: account(full) });
    await view.waitFor(() => rowsOf(view, "updates").length > 0, "소식's rows");
    await view.navigate("/skills");
    await view.settle(120);
    expect(seenPosts(view.requests)).toEqual([]);
    // And the unseen one is still marked after all that.
    expect(
      widget(view, "updates")?.querySelectorAll('[data-mark="unseen"]'),
    ).toHaveLength(1);
  });

  test("a thing the Bot made opens the conversation it was made in", async () => {
    const view = await mountApp({ path: "/help", api: account(full) });
    await view.waitFor(
      () => rowsOf(view, "made").length === 2,
      "만든 것's rows",
    );
    await view.click(rowsOf(view, "made")[0]?.press as HTMLElement);
    await view.waitFor(
      () => view.router.state.location.pathname === "/channel/c-1",
      "the conversation to open",
    );
    // Asked for by the Bot's id, and never before there was one to name.
    const asked = view.requests
      .map((request) => request.pathname)
      .filter((path) => path.endsWith("/made"));
    expect(new Set(asked)).toEqual(new Set(["/api/agents/bot-1/made"]));
  });

  test("what a deployment does not have is not drawn; a read that failed says so; a list with nothing in it says what will be", async () => {
    const view = await mountApp({
      path: "/help",
      api: account(({ pathname }) => {
        // No feed on this deployment: nothing is mounted at the path.
        if (pathname.startsWith("/api/feed")) {
          return json({ error: "laf:not_found", code: "laf:not_found" }, 404);
        }
        if (pathname === "/api/goals") {
          return json({ error: "laf:internal", code: "laf:internal" }, 500);
        }
        if (pathname === "/api/agents/bot-1/made") {
          return json({ items: [], next: null });
        }
        return undefined;
      }),
    });
    await view.waitFor(
      () =>
        (widget(view, "goals")?.textContent ?? "").includes(
          "Goals could not be loaded.",
        ),
      "목표's failure",
    );
    await view.waitFor(
      () =>
        (widget(view, "made")?.textContent ?? "").includes("Nothing here yet."),
      "만든 것's empty line",
    );
    expect(widget(view, "updates")).toBeNull();
    expect(rowsOf(view, "goals")).toHaveLength(0);
  });
});
