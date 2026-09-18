import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ko } from "../src/lib/i18n-ko";
import type { Routine } from "../src/lib/routines/queries";
import {
  pausedForUnread,
  UNREAD_PAUSE_SENTENCES,
  unreadPausesByBot,
} from "../src/lib/routines/unread";
import { stubFetch } from "./support/fetch";
import { json, mount, unmountAll } from "./support/mount";

/**
 * Routines the unread rule paused, on the routines page. 2026-09-18.
 *
 * The server pauses a Bot's routines when their results have piled up unread for a week
 * (`server/src/routines/unread.ts`). A pause nobody can see is a routine that silently stopped,
 * which is the complaint the rule exists to prevent in the other direction — so the page says it
 * twice: a line on each paused row, and a banner per Bot with the two answers, 다시 켜기 and
 * 계속 돌리기. Pressing either is one request for the whole Bot.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountAll();
  globalThis.fetch = realFetch;
});

const routine = (overrides: Partial<Routine> = {}): Routine => ({
  id: "routine_1",
  agentId: "bot-1",
  name: "아침 리뷰 요약",
  instruction: "새 리뷰를 요약해줘",
  scheduleKind: "daily",
  intervalMinutes: null,
  dailyLocal: "07:30",
  dailyTimeZone: "Asia/Seoul",
  dailyDays: [],
  enabled: true,
  lastRunAt: null,
  nextRunAt: "2026-09-18T22:30:00.000Z",
  pausedReason: null,
  pausedAt: null,
  keepRunning: false,
  ...overrides,
});

const pausedRoutine = (id: string, agentId = "bot-1") =>
  routine({
    id,
    agentId,
    enabled: false,
    pausedReason: "unread",
    pausedAt: "2026-09-18T06:00:00.000Z",
  });

describe("which routines the banner is about", () => {
  test("off because the rule paused them — not off because the person switched them off", () => {
    expect(pausedForUnread(pausedRoutine("a"))).toBe(true);
    expect(pausedForUnread(routine({ enabled: false }))).toBe(false);
    // Back on, whatever the column still says, is not paused.
    expect(pausedForUnread(routine({ pausedReason: "unread" }))).toBe(false);
  });

  test("one banner per Bot, in the order the list has them", () => {
    const groups = unreadPausesByBot([
      pausedRoutine("a", "bot-2"),
      routine({ id: "b" }),
      pausedRoutine("c", "bot-1"),
      pausedRoutine("d", "bot-2"),
      routine({ id: "e", enabled: false }),
    ]);
    expect(
      groups.map((group) => [
        group.agentId,
        group.routines.map((one) => one.id),
      ]),
    ).toEqual([
      ["bot-2", ["a", "d"]],
      ["bot-1", ["c"]],
    ]);
  });

  test("every sentence the banner, the row and the notice say has Korean", () => {
    const missing = Object.values(UNREAD_PAUSE_SENTENCES).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
    // The two answers, by the names the person is told to look for.
    expect(ko[UNREAD_PAUSE_SENTENCES.turnBackOn]).toBe("다시 켜기");
    expect(ko[UNREAD_PAUSE_SENTENCES.keepRunning]).toBe("계속 돌리기");
  });
});

type Sent = { method: string; url: string; body?: unknown };

function server(routines: Routine[]) {
  const sent: Sent[] = [];
  let list = routines;
  globalThis.fetch = stubFetch(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    sent.push({
      method,
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url === "/api/routines" && method === "GET") {
      return json({ routines: list });
    }
    if (url === "/api/agents") {
      return json({ agents: [{ id: "bot-1", name: "리뷰봇" }] });
    }
    if (url === "/api/routines/resume" && method === "POST") {
      list = list.map((one) =>
        one.pausedReason === "unread"
          ? { ...one, enabled: true, pausedReason: null, pausedAt: null }
          : one,
      );
      return json({ routines: list });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  return sent;
}

async function mountedBanners() {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { UnreadPauseBanners } = await import(
    "../src/components/routines/unread-pause-banner"
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = await mount(
    <QueryClientProvider client={client}>
      <UnreadPauseBanners />
    </QueryClientProvider>,
  );
  await view.settle();
  return view;
}

const buttonNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll("button")].find(
    (button) => button.textContent === name,
  );

describe("the banner", () => {
  test("names the Bot and how many of its routines stopped", async () => {
    server([pausedRoutine("a"), pausedRoutine("b"), routine({ id: "c" })]);
    const view = await mountedBanners();

    // The runner reads English; the Korean is the dictionary's, checked above.
    expect(view.host.textContent).toContain("Paused 2 routines on 리뷰봇");
    expect(buttonNamed(view.host, "Turn back on")).toBeDefined();
    expect(buttonNamed(view.host, "Keep running")).toBeDefined();
  });

  test("draws nothing when nothing is paused for going unread", async () => {
    server([routine({ id: "c" }), routine({ id: "d", enabled: false })]);
    const view = await mountedBanners();

    expect(view.host.textContent).toBe("");
  });

  test("다시 켜기 is one request for the Bot, and the banner goes with the pause", async () => {
    const sent = server([pausedRoutine("a"), pausedRoutine("b")]);
    const view = await mountedBanners();

    const press = buttonNamed(view.host, "Turn back on");
    if (!press) throw new Error("no 다시 켜기");
    await view.press(press);
    await view.settle(60);

    expect(sent.filter((request) => request.method === "POST")).toEqual([
      {
        method: "POST",
        url: "/api/routines/resume",
        body: { agentId: "bot-1", keepRunning: false },
      },
    ]);
    expect(view.host.textContent).not.toContain("Paused 2 routines");
  });

  test("what 다시 켜기 did is said in a line that was there before, and outlives the banner", async () => {
    server([pausedRoutine("a"), pausedRoutine("b")]);
    const view = await mountedBanners();
    // Mounted with the list, empty: a line that arrived with its words would not be announced.
    const region = view.host.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("");

    const press = buttonNamed(view.host, "Turn back on");
    if (!press) throw new Error("no 다시 켜기");
    await view.press(press);
    await view.settle(60);

    // The banner went with the pause; the sentence is in the region that did not.
    expect(view.host.querySelector('[role="status"]')).toBe(region);
    expect(region?.textContent).toBe("Turned 리뷰봇's routines back on.");
    expect(ko["Turned {name}'s routines back on."]).toBe(
      "{name}의 루틴을 다시 켰어요.",
    );
  });

  test("계속 돌리기 says to keep them running from now on", async () => {
    const sent = server([pausedRoutine("a")]);
    const view = await mountedBanners();

    const press = buttonNamed(view.host, "Keep running");
    if (!press) throw new Error("no 계속 돌리기");
    await view.press(press);

    expect(sent.filter((request) => request.method === "POST")).toEqual([
      {
        method: "POST",
        url: "/api/routines/resume",
        body: { agentId: "bot-1", keepRunning: true },
      },
    ]);
  });
});

describe("the row and its menu", () => {
  const page = readFileSync(
    join(import.meta.dir, "../src/routes/_authed/_app/routines.tsx"),
    "utf8",
  );

  test("a paused row says why, and the banner sits above the list", () => {
    expect(page).toContain("pausedForUnread(routine)");
    expect(page).toContain("t(UNREAD_PAUSE_SENTENCES.row)");
    expect(page.indexOf("<UnreadPauseBanners />")).toBeGreaterThan(0);
    expect(page.indexOf("<UnreadPauseBanners />")).toBeLessThan(
      page.indexOf("<RoutineRow key={routine.id}"),
    );
  });

  test("the ⋯ menu holds the keep-running switch, on its own door", () => {
    expect(page).toContain("<DropdownMenuCheckboxItem");
    expect(page).toContain("checked={routine.keepRunning === true}");
    expect(page).toContain("/keep-running`");
    expect(page).toContain("t(UNREAD_PAUSE_SENTENCES.menu)");
  });
});
