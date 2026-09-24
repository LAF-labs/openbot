import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { routineSavedText } from "../../shared/prompt/tool-results.ko";
import {
  editDraft,
  editInChatHref,
} from "../src/components/routines/edit-in-chat";
import { routineFor } from "../src/components/routines/routine-card";
import { routineCallLanded } from "../src/lib/copilot/self-tools";
import { ko } from "../src/lib/i18n-ko";
import { type Routine, scheduleLabel } from "../src/lib/routines/queries";
import {
  agentFixture,
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { stubFetch } from "./support/fetch";
import { mount, unmountAll } from "./support/mount";

/**
 * A ROUTINE MADE IN CONVERSATION SHOWS AS A ROUTINE, AND IS CHANGED BY SAYING SO.
 *
 * Measured 2026-09-24 (UI/UX audit 0.5.3, item 8): "매주 월요일 9시에 매출 요약 알려줘" left three
 * lines in the conversation and what had been saved, for when, only in the Bot's prose; the
 * Routines screen showed the Bot's instruction to itself as the row's body, cut at 375 to "주…";
 * and 수정 opened a four-field form. Here: the card finds its routine by id or by the Bot's own
 * words after a reload, the schedule reads "Every Mon at …", the screen leads with the person's
 * line and folds the instruction, and 고치기 goes to the Bot's conversation with the sentence
 * started.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountApps();
  await unmountAll();
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  await removeAppDom();
});

const BOT = "agent_4b9d2c1e-0000-4000-8000-0000000c0de1";

const routine = (overrides: Partial<Routine> = {}): Routine => ({
  id: "routine_weekly",
  agentId: BOT,
  name: "주간 매출 요약",
  instruction:
    "매주 월요일 아침이다. 사용자에게 지난주 매출 요약을 요청하는 인사와 함께 …",
  summary: "지난주 매출을 정리해 드려요",
  scheduleKind: "daily",
  intervalMinutes: null,
  dailyLocal: "09:00",
  dailyTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dailyDays: [1],
  enabled: true,
  lastRunAt: null,
  nextRunAt: "2026-09-28T00:00:00.000Z",
  ...overrides,
});

describe("which routine a line is about", () => {
  const list = [
    routine(),
    routine({ id: "routine_twin_a", name: "리뷰 확인" }),
    routine({ id: "routine_twin_b", name: "리뷰 확인" }),
    routine({ id: "routine_other", name: "주간 매출 요약", agentId: "bot-2" }),
  ];

  test("by the id this tab saw, else by the Bot's own words, on this Bot only", () => {
    expect(
      routineFor(list, { routineId: "routine_weekly", names: [] }, BOT)?.id,
    ).toBe("routine_weekly");
    expect(routineFor(list, { names: ["  주간 매출 요약 "] }, BOT)?.id).toBe(
      "routine_weekly",
    );
    // An edit names the routine by id or by its current name, in `routineId`.
    expect(routineFor(list, { names: ["", "routine_weekly"] }, BOT)?.id).toBe(
      "routine_weekly",
    );
    // Two with one name are two candidates, and the line does not guess.
    expect(routineFor(list, { names: ["리뷰 확인"] }, BOT)).toBeUndefined();
    expect(
      routineFor(list, { routineId: "routine_other", names: [] }, BOT),
    ).toBeUndefined();
    expect(routineFor(undefined, { names: ["주간 매출 요약"] }, BOT)).toBe(
      undefined,
    );
  });

  test("is drawn as a routine only when the save or the edit went through", () => {
    const saved = { done: "Saved a routine", doing: "Saving a routine" };
    expect(
      routineCallLanded(
        "create",
        { ...saved, routineId: "routine_weekly" },
        undefined,
      ),
    ).toBe(true);
    expect(
      routineCallLanded(
        "create",
        { ...saved, routineId: "routine_weekly", failed: true },
        undefined,
      ),
    ).toBe(false);
    // A pause is a line of its own, not the routine's card.
    expect(
      routineCallLanded(
        "update",
        { done: "Paused a routine", doing: "Pausing a routine" },
        undefined,
      ),
    ).toBe(false);
    expect(routineCallLanded("list", undefined, "anything")).toBe(false);

    // After a reload only the Bot's answer is left: the sentence a success hands it.
    const answer = routineSavedText(
      routine({ dailyTimeZone: "Asia/Seoul" }) as unknown,
    );
    expect(routineCallLanded("create", undefined, answer)).toBe(true);
    expect(routineCallLanded("create", undefined, JSON.stringify(answer))).toBe(
      true,
    );
    expect(
      routineCallLanded("create", undefined, "시각은 07:30처럼 HH:MM으로"),
    ).toBe(false);
  });
});

describe("the words", () => {
  test("a weekly schedule says it comes round every week", () => {
    expect(scheduleLabel(routine())).toMatch(/^Every Mon at 9:00/);
    expect(ko["Every {days} at {time}"]).toBe("매주 {days} {time}");
  });

  test("고치기 goes to the Bot's conversation with the sentence started", () => {
    expect(editDraft("주간 매출 요약")).toBe(
      "Change “주간 매출 요약” like this: ",
    );
    expect(ko["Change “{name}” like this: "]).toBe(
      "‘{name}’{josa} 이렇게 바꿔 줘: ",
    );
    const href = editInChatHref("channel_1", "주간 매출 요약");
    const url = new URL(href, "http://laf.test");
    expect(url.pathname).toBe("/channel/channel_1");
    expect(url.searchParams.get("draft")).toBe(
      "Change “주간 매출 요약” like this: ",
    );
  });
});

/** A router with one screen that draws the card, and the conversation it can go to. */
async function cardScreen(
  props: Partial<
    Parameters<
      typeof import("../src/components/routines/routine-card").RoutineCard
    >[0]
  >,
  routines: Routine[],
) {
  const { act, createElement } = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
  } = await import("@tanstack/react-router");
  const { RoutineCard } = await import(
    "../src/components/routines/routine-card"
  );
  const posts: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = stubFetch(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body ?? "null")) });
      return json({ routine: routines[0] });
    }
    if (url === "/api/routines") return json({ routines });
    if (url === "/api/channels") {
      return json({
        channels: [
          {
            id: "channel_1",
            agentIds: [BOT],
            createdAt: "2026-09-01T00:00:00.000Z",
            lastMessageAt: null,
          },
        ],
      });
    }
    return json({ error: "laf:not_stubbed" }, 404);
  });

  const root = createRootRoute();
  const card = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () =>
      createElement(RoutineCard, {
        agentId: BOT,
        names: [],
        fallback: createElement("p", null, "the line"),
        ...props,
      }),
  });
  const channel = createRoute({
    getParentRoute: () => root,
    path: "/channel/$channelId",
    component: () => createElement("p", null, "the conversation"),
  });
  const router = createRouter({
    routeTree: root.addChildren([card, channel]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = await mount();
  await act(async () => {
    await view.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router }),
      ),
    );
  });
  const button = (name: string) =>
    [...view.host.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
  // Two lists answer the card — the routines and the conversations — and in a full run either can
  // land after a fixed pause. Waited for by what they draw, a second at most.
  for (let waited = 0; waited < 1000; waited += 50) {
    const drawn = view.host.textContent ?? "";
    if (drawn === "the line" && props.routineId === "routine_gone") break;
    if (button("Change it") || (props.compact && drawn.includes("·"))) break;
    await view.settle(50);
  }
  return { ...view, router, posts, button };
}

describe("the card in the conversation", () => {
  test("says what, when, when next and the person's line — never the instruction", async () => {
    const view = await cardScreen({ routineId: "routine_weekly" }, [routine()]);
    const text = view.host.textContent ?? "";
    expect(text).toContain("주간 매출 요약");
    expect(text).toMatch(/Every Mon at 9:00/);
    expect(text).toContain("Next ");
    expect(text).toContain("지난주 매출을 정리해 드려요");
    expect(text).not.toContain("매주 월요일 아침이다");
    expect(view.button("Turn off")).toBeDefined();
  });

  test("끄기 is the routine's own switch", async () => {
    const view = await cardScreen({ routineId: "routine_weekly" }, [routine()]);
    const off = view.button("Turn off");
    if (!off) throw new Error("the card drew no Turn off");
    await view.press(off);
    await view.settle(50);
    expect(view.posts).toEqual([
      { url: "/api/routines/routine_weekly/enabled", body: { enabled: false } },
    ]);
  });

  test("고치기 opens the conversation with the sentence in its address", async () => {
    const view = await cardScreen({ routineId: "routine_weekly" }, [routine()]);
    const change = view.button("Change it");
    if (!change) throw new Error("the card drew no Change it");
    await view.press(change);
    await view.settle(80);
    expect(view.router.state.location.pathname).toBe("/channel/channel_1");
    expect(
      new URLSearchParams(view.router.state.location.searchStr).get("draft"),
    ).toBe("Change “주간 매출 요약” like this: ");
  });

  test("an edit is one line, saying the schedule it has now as now", async () => {
    const view = await cardScreen(
      { routineId: "routine_weekly", compact: true },
      [routine({ dailyDays: [2], dailyLocal: "08:30" })],
    );
    expect(view.host.textContent).toMatch(
      /^Changed a routine · 주간 매출 요약 · now Every Tue at 8:30/,
    );
    expect(view.button("Turn off")).toBeUndefined();
  });

  test("a routine the list no longer holds leaves the line it always drew", async () => {
    const view = await cardScreen({ routineId: "routine_gone" }, [routine()]);
    expect(view.host.textContent).toBe("the line");
  });
});

describe("the Routines screen", () => {
  test("leads with the name, the schedule and the person's line, and folds the instruction", async () => {
    const app = await mountApp({
      path: "/routines",
      api: (request) => {
        if (request.pathname === "/api/routines") {
          return json({ routines: [routine()] });
        }
        if (request.pathname === "/api/agents") {
          return json({ agents: [agentFixture({ id: BOT, name: "연남이" })] });
        }
        if (request.pathname === "/api/routines/suggestions") {
          return json({ suggestions: [] });
        }
        return undefined;
      },
    });
    await app.waitFor(
      () => (app.main()?.textContent ?? "").includes("주간 매출 요약"),
      "the routine row",
    );
    const text = app.main()?.textContent ?? "";
    expect(text).toContain("지난주 매출을 정리해 드려요");
    expect(text).not.toContain("매주 월요일 아침이다");
    // One Bot: its name is not on the row.
    expect(text).not.toContain("연남이 ·");

    const details = [...(app.main()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("Details"),
    );
    if (!details) throw new Error("the row offered no Details");
    await app.click(details);
    expect(app.main()?.textContent).toContain("매주 월요일 아침이다");
    expect(app.main()?.textContent).toContain("What the Bot is told each time");
  });
});
