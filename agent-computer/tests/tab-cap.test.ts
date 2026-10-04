import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { LOOK_HEADER, PERSONS_LOOK } from "../../shared/bots-look";
import type { Computer } from "../src/computer";
import { readConfig } from "../src/config";
import { createEgressGuard } from "../src/egress-guard";
import { liveScreen, type StreamData } from "../src/live-screen";
import { log } from "../src/log";
import { watchPage } from "../src/page-watch";
import { createProfiles } from "../src/profiles";
import { computerFetch } from "../src/routes";
import type { Screencast } from "../src/screencast";
import { createSessions } from "../src/sessions";
import { holdsTab } from "../src/tab-cap";
import { tabLost } from "../src/tab-loss";
import {
  createTabs,
  IDLE_CLOSE_MS,
  TAB_CAP,
  type TabLost,
  TabListError,
} from "../src/tabs";
import { createWorkspace } from "../src/workspace";
import { serveFixture, TO_HANG_PIN } from "./fixture-site";

/**
 * A BOT'S TABS HAVE A NUMBER.
 *
 * Measured 2026-10-05 (docs/laf/browser-limits.md §2), after one Bot driven through 57 browsing
 * tasks on Naver stopped opening anything: nothing counted a Bot's tabs and nothing closed one
 * while the Bot kept calling. Every `target=_blank` link and every window a site opens is adopted
 * as the Bot's, no route closes a tab, and the ten-minute idle close looks at the Bot's last call.
 * The first test below, run on `main` before the cap existed: one Bot, thirty opens, never idle —
 * its tabs after each were 2, 3, 4 … 31, and the browser's pages the same. And what one costs, in
 * the stable image on news.naver.com: 130–140 MiB and 13–14 processes for every tab after the
 * first, under a container limit of 3 GiB.
 *
 * So a Bot holds `TAB_CAP` tabs, and the one it used longest ago is closed to make room for a new
 * one — never the tab it is on, the tab that opened that one, or a tab a person or an ask is
 * holding. The Bot is not told it lost a tab, because it did not: what changed is the list its
 * `computer_switch_tab` index was read from, and an index from before is refused until it has
 * read the list again.
 *
 * IN THIS PROCESS, BEHIND THE REAL DOOR, as `crashed-tab.test.ts` is and for its reason: which tab
 * was closed can only be seen by whoever holds the tabs. Skipped where Playwright has no browser.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const TOKEN = "tab-cap-test-token";
/** Far above what a tab takes to open or close here, far below a test's own deadline. */
const SETTLE_MS = 5_000;

type Running = {
  url: string;
  profiles: ReturnType<typeof createProfiles>;
  sessions: ReturnType<typeof createSessions>;
  stop: () => Promise<void>;
};

let fixture: ReturnType<typeof serveFixture> | null = null;
let computer: Running | null = null;

/** The computer as `index.ts` builds it: the same routes, socket, profiles and sessions. */
async function startComputer(): Promise<Running> {
  const base = await mkdtemp(join(tmpdir(), "laf-tab-cap-"));
  const config = readConfig({
    COMPUTER_TOKEN: TOKEN,
    // The fixture is on 127.0.0.1, and a laptop has no host holding the egress rules.
    AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
    AGENT_COMPUTER_EGRESS_FIREWALL: "off",
    PROFILES_DIR: join(base, "profiles"),
    WORKSPACE_DIR: join(base, "workspace"),
  });
  if (!config) throw new Error("no config");
  await mkdir(config.profilesDir, { recursive: true });
  await mkdir(config.workspaceDir, { recursive: true });
  const workspace = createWorkspace(config.workspaceDir);
  const sessions = createSessions({
    stateDirectoryFor: (botId) => profiles.stateDirectoryFor(botId),
  });
  const profiles = createProfiles(config.profilesDir, {
    // No sweep: the idle close has a test of its own, with its own clock.
    idleCloseMs: 0,
    onPage: (botId, page) =>
      watchPage(sessions.sessionFor(botId), botId, page, workspace),
    onTabLost: (botId, lost) =>
      tabLost(sessions.sessionFor(botId), botId, lost),
    holdsTab: (botId, page) => holdsTab(sessions.existing(botId), page),
  });
  const built: Computer = {
    config,
    profiles,
    workspace,
    sessions,
    egress: createEgressGuard({
      enforce: false,
      allowPrivateHosts: true,
      log,
    }),
  };
  const server = Bun.serve<StreamData>({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    websocket: liveScreen(built),
    fetch: computerFetch(built),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    profiles,
    sessions,
    stop: async () => {
      await server.stop(true);
      await profiles.closeAll();
      await rm(base, { recursive: true, force: true });
    },
  };
}

type Answer = { status: number; body: Record<string, unknown>; text: string };

async function call(
  method: "GET" | "POST",
  path: string,
  bot: string,
  payload?: unknown,
  /** Whose look it is, as the server says it. Unsaid is the Bot's. */
  look?: typeof PERSONS_LOOK,
): Promise<Answer> {
  const response = await fetch(`${computer?.url}${path}`, {
    method,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": bot,
      ...(look ? { [LOOK_HEADER]: look } : {}),
    },
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {}
  return { status: response.status, body, text };
}

const post = (path: string, bot: string, payload: unknown = {}) =>
  call("POST", path, bot, payload);

const until = async (
  holds: () => boolean | Promise<boolean>,
  ms = SETTLE_MS,
) => {
  const deadline = Date.now() + ms;
  while (!(await holds()) && Date.now() < deadline) await Bun.sleep(20);
  return holds();
};

/** The tab this Bot's next call would be handed. */
const tabOf = (bot: string): Promise<Page> => {
  if (!computer) throw new Error("no computer");
  return computer.profiles.page(bot);
};

type Element = { ref: string; name: string };
type Tab = { index: number; url: string; active: boolean };

const tabsOf = (answer: Answer): Tab[] => (answer.body.tabs as Tab[]) ?? [];
const elementsOf = (answer: Answer): Element[] =>
  (answer.body.elements as Element[]) ?? [];

/** The `/` page's link to a new tab, and the `/to-hang` page's link to itself in one. */
const NEW_TAB = "주문 상세 보기";
const SAME_IN_NEW_TAB = "이 화면 새 탭";

/** Press a link on the tab the Bot is on, by a look just taken, and hand back the tab it opened. */
async function pressForTab(bot: string, link: string): Promise<Page> {
  const from = await tabOf(bot);
  const look = await post("/snapshot", bot);
  const found = elementsOf(look).find((element) => element.name === link);
  if (!found) throw new Error(`no ${link} link on the Bot's tab`);
  const clicked = await post("/click", bot, {
    ref: found.ref,
    snapshotId: look.body.snapshotId,
    element: { role: "link", name: found.name },
  });
  expect([clicked.status, clicked.body.code]).toEqual([200, undefined]);
  // The click waits for its tab; the adoption is a question to the browser, a moment behind it.
  if (!(await until(async () => (await tabOf(bot)) !== from))) {
    throw new Error(`the tab ${link} opened was not adopted`);
  }
  return tabOf(bot);
}

/**
 * Go back to the page every tab is opened from — by a list just read, as a Bot must — and press
 * its link. Hands back the tab that opened.
 */
async function openFromHub(bot: string, hub: string): Promise<Page> {
  const look = await post("/snapshot", bot);
  const at = tabsOf(look).find((tab) => tab.url === hub);
  if (!at) throw new Error("the hub is not among the Bot's tabs");
  if (!at.active) {
    const moved = await post("/tabs/switch", bot, { index: at.index });
    expect([moved.status, moved.body.code]).toEqual([200, undefined]);
  }
  return pressForTab(bot, NEW_TAB);
}

/** A window the page opens by itself, as a sign-in or a payment window is. Hands it back. */
async function opensItself(bot: string, address: string): Promise<Page> {
  const from = await tabOf(bot);
  await from.evaluate((to) => {
    window.open(to);
  }, address);
  if (!(await until(async () => (await tabOf(bot)) !== from))) {
    throw new Error("the window the page opened was not adopted");
  }
  return tabOf(bot);
}

/** The hub, and a Bot at its number of tabs: the hub and one short of `TAB_CAP` opened from it. */
async function atTheCap(bot: string) {
  const hub = fixture?.url ?? "";
  expect((await post("/navigate", bot, { url: hub })).status).toBe(200);
  const first = await tabOf(bot);
  const opened: Page[] = [];
  for (let open = 1; open < TAB_CAP; open += 1) {
    opened.push(await openFromHub(bot, hub));
  }
  return { hub, first, opened };
}

/** Every warn line written while `work` runs, parsed. */
function warnLines(spy: ReturnType<typeof spyOn<Console, "warn">>) {
  return spy.mock.calls.map(
    ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
  );
}

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  fixture = serveFixture();
  computer = await startComputer();
});

// Closing a browser waits for it to be gone (`closeAndWait`), which is seconds, not the hook's five.
afterAll(async () => {
  await computer?.stop();
  fixture?.stop();
}, 30_000);

/**
 * The bookkeeping on its own, with tabs that are nothing but what it asks of one. No browser, so
 * which tab was used when is exactly what the test says it was.
 */
describe("a Bot's tabs, counted without a browser", () => {
  type FakeTab = Page & EventEmitter;

  function tab(address: string, openedBy?: FakeTab): FakeTab {
    const made = new EventEmitter();
    let closed = false;
    return Object.assign(made, {
      url: () => address,
      isClosed: () => closed,
      close: async () => {
        closed = true;
        made.emit("close");
      },
      opener: async () => openedBy ?? null,
      bringToFront: async () => undefined,
      // What a tab's title is asked with (`titleOf`).
      evaluate: async () => "",
    }) as unknown as FakeTab;
  }

  function counting(holds: (page: Page) => boolean = () => false) {
    const open: FakeTab[] = [];
    const lost: [string, TabLost][] = [];
    const clock = { now: 0 };
    const tabs = createTabs({
      pages: () => open,
      now: () => clock.now,
      onPage: () => undefined,
      onLost: (botId, how) => lost.push([botId, how]),
      holds: (_botId, page) => holds(page),
    });
    /** A Bot's first tab, as `profiles.page` hands one. */
    const first = (botId: string, address: string): FakeTab => {
      const made = tab(address);
      open.push(made);
      tabs.own(botId, made);
      tabs.touch(botId, made);
      return made;
    };
    /** A tab a page opened, adopted as the browser's `page` event has it adopted. */
    const opens = async (from: FakeTab, address: string): Promise<FakeTab> => {
      const made = tab(address, from);
      open.push(made);
      tabs.adoptOpened(made);
      await Bun.sleep(0);
      return made;
    };
    /** A Bot with a hub and as many tabs opened from it as make `TAB_CAP`. */
    const full = async (botId: string, site: string) => {
      const hub = first(botId, `${site}/list?q=1`);
      const opened: FakeTab[] = [];
      for (let item = 1; item < TAB_CAP; item += 1) {
        opened.push(await opens(hub, `${site}/item/${item}?from=list`));
      }
      return { hub, opened };
    };
    return { tabs, open, lost, clock, first, opens, full };
  }

  let warned: ReturnType<typeof spyOn<Console, "warn">> | undefined;

  afterEach(() => {
    warned?.mockRestore();
    warned = undefined;
  });

  const linesOf = (event: string) =>
    (warned ? warnLines(warned) : []).filter((line) => line.event === event);

  test("the tab used longest ago is the one closed, a Bot's number is its own, and nobody is told a tab was lost", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const { tabs, lost, full, opens } = counting();
    const mine = await full("bot", "https://shop.example");
    const theirs = await full("other-bot", "https://bank.example");
    // At the number, nothing has gone.
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CAP);
    expect(linesOf("tab_capped")).toEqual([]);

    // The Bot goes back to the first tab it opened, and then to the hub: both used again.
    const [revisited, oldest, ...rest] = mine.opened;
    if (!revisited || !oldest) throw new Error("no tabs were opened");
    tabs.touch("bot", revisited);
    tabs.touch("bot", mine.hub);
    const one = await opens(mine.hub, "https://shop.example/item/new");

    // The one it has not been on since it opened, longest ago — not the oldest tab, which it used.
    expect(oldest.isClosed()).toBe(true);
    expect(tabs.pagesOf("bot")).toEqual([mine.hub, revisited, ...rest, one]);
    // The Bot is on the tab that opened, and was told of no loss: it is where a click put it.
    expect(tabs.live.get("bot")?.page).toBe(one);
    expect(lost).toEqual([]);
    // The other Bot holds what it held: its tabs are not in this Bot's count.
    expect(tabs.pagesOf("other-bot")).toEqual([theirs.hub, ...theirs.opened]);
    for (const page of theirs.opened) expect(page.isClosed()).toBe(false);

    // And the other Bot's own seventh closes one of its own, not one of this Bot's.
    await opens(theirs.hub, "https://bank.example/item/new");
    expect(theirs.opened[0]?.isClosed()).toBe(true);
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CAP);
    expect(tabs.pagesOf("other-bot")).toHaveLength(TAB_CAP);
    expect(lost).toEqual([]);
  });

  test("never the tab that opened the one the Bot is on, however long ago it was used — and only for as long as the Bot is on that one", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const { tabs, full, opens } = counting();
    // The hub was used once, before everything it opened: the oldest of all.
    const { hub, opened } = await full("bot", "https://shop.example");
    const [second, third] = opened;
    if (!second || !third) throw new Error("no tabs were opened");

    // A sign-in window opened from the hub. It reports to the hub, so the hub stays.
    const signIn = await opens(hub, "https://id.example/sign-in");
    expect(hub.isClosed()).toBe(false);
    expect(second.isClosed()).toBe(true);
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CAP);

    // A tab opened from another page: the Bot is on that one now, and the hub is only the oldest.
    await opens(third, "https://shop.example/item/more");
    expect(hub.isClosed()).toBe(true);
    expect(signIn.isClosed()).toBe(false);
    expect(third.isClosed()).toBe(false);
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CAP);
  });

  test("never a tab that is held, and when nothing may go the Bot is over its number and a line says so", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const held = new Set<Page>();
    const { tabs, clock, full, opens } = counting((page) => held.has(page));
    const { hub, opened } = await full("bot", "https://shop.example");
    const [second, third] = opened;
    if (!second || !third) throw new Error("no tabs were opened");

    // One tab held — a person's hands, a cast, an ask: the next oldest goes in its place.
    held.add(second);
    tabs.touch("bot", hub);
    const seventh = await opens(hub, "https://shop.example/item/7");
    expect(second.isClosed()).toBe(false);
    expect(third.isClosed()).toBe(true);
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CAP);

    // Every tab held: nothing is closed, the tab the Bot is on least of all.
    for (const page of tabs.pagesOf("bot")) held.add(page);
    const eighth = await opens(seventh, "https://shop.example/item/8");
    const ninth = await opens(eighth, "https://shop.example/item/9");
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CAP + 2);
    expect(tabs.live.get("bot")?.page).toBe(ninth);
    // Said once in the minute, with the number it holds and the number it may.
    expect(linesOf("tab_cap_exceeded")).toEqual([
      expect.objectContaining({ bot: "bot", tabs: TAB_CAP + 1, cap: TAB_CAP }),
    ]);

    // Let go of: the next tab that opens brings the Bot back to its number, oldest first — the
    // three it opened first and has not been on since, and not the hub it went back to.
    held.clear();
    clock.now += 60_000;
    const tenth = await opens(ninth, "https://shop.example/item/10");
    expect(tabs.pagesOf("bot")).toEqual([
      hub,
      opened[4] as FakeTab,
      seventh,
      eighth,
      ninth,
      tenth,
    ]);
    expect(second.isClosed()).toBe(true);
  });

  test("the line a closed tab leaves is one a minute for a Bot, by its site's origin only, and a crash's line is its own", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const { clock, full, opens } = counting();
    const { hub } = await full("loop-bot", "https://shop.example");
    const other = await full("other-bot", "https://bank.example");

    // A Bot working down a list: every result is a tab, and every tab closes one.
    for (let item = 0; item < 3; item += 1) {
      await opens(hub, `https://shop.example/item/more-${item}`);
      clock.now += 1_000;
    }
    expect(linesOf("tab_capped")).toEqual([
      expect.objectContaining({
        level: "warn",
        svc: "agent-computer",
        bot: "loop-bot",
        origin: "https://shop.example",
        // Counted with the closed one still in it.
        tabs: TAB_CAP + 1,
      }),
    ]);
    expect(linesOf("tab_capped")[0]).not.toHaveProperty("unsaid");
    // Another Bot's is its own line, and a renderer that dies is said beside it, not instead.
    await opens(other.hub, "https://bank.example/item/more");
    other.hub.emit("crash");
    expect(linesOf("tab_capped").map((line) => line.bot)).toEqual([
      "loop-bot",
      "other-bot",
    ]);
    expect(linesOf("tab_crashed")).toHaveLength(1);

    clock.now += 60_000;
    await opens(hub, "https://shop.example/item/later");
    expect(linesOf("tab_capped").at(-1)).toMatchObject({
      bot: "loop-bot",
      unsaid: 2,
    });
    // Every line as it was written: no path, no query.
    expect(JSON.stringify(warned.mock.calls)).not.toMatch(/item|list|from|q=/);
  });

  test("an index read before a tab was closed is refused until the list is read again, and what was closed is handed over once", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const { tabs, first, full, opens } = counting();
    const { hub, opened } = await full("bot", "https://shop.example");
    const fourth = opened[2];
    if (!fourth) throw new Error("no tabs were opened");
    // The list as the Bot reads it now: nothing closed, and an index is taken.
    const read = tabs.cappedOf("bot");
    expect(read).toBe(0);
    expect(tabs.listRead("bot", read)).toBeUndefined();
    expect(tabs.pagesOf("bot")[3]).toBe(fourth);
    await tabs.switchTab("bot", 0);
    expect(tabs.live.get("bot")?.page).toBe(hub);

    // Two more open, and the two oldest go. `fourth` was index 3, and is index 1 of what is left:
    // index 3 is another tab now.
    const seventh = await opens(hub, "https://pay.example/window?order=7");
    const eighth = await opens(seventh, "https://id.example/sign-in?next=8");
    expect(tabs.pagesOf("bot")[1]).toBe(fourth);
    expect(tabs.pagesOf("bot")[3]).not.toBe(fourth);

    await expect(tabs.switchTab("bot", 3)).rejects.toBeInstanceOf(TabListError);
    // Refused, not moved: the Bot is on the tab it was on.
    expect(tabs.live.get("bot")?.page).toBe(eighth);
    // A list read before the close is not the list: it lets nothing through and says nothing.
    expect(tabs.listRead("bot", read)).toBeUndefined();
    await expect(tabs.switchTab("bot", 3)).rejects.toBeInstanceOf(TabListError);

    // The list as it is now: how many went, the last one's site, and only once.
    const again = tabs.cappedOf("bot");
    expect(tabs.listRead("bot", again)).toEqual({
      origin: "https://shop.example",
      closed: 2,
    });
    expect(tabs.listRead("bot", again)).toBeUndefined();
    await tabs.switchTab("bot", 1);
    expect(tabs.live.get("bot")?.page).toBe(fourth);

    // What became of a list ends with it: every tab closed, and the Bot's next tab starts clean.
    await opens(fourth, "https://shop.example/item/9");
    expect(tabs.cappedOf("bot")).toBe(3);
    await tabs.closeTabsOf("bot");
    expect(tabs.cappedOf("bot")).toBe(0);
    expect(tabs.listRead("bot", 3)).toBeUndefined();
    const fresh = first("bot", "about:blank");
    await tabs.switchTab("bot", 0);
    expect(tabs.live.get("bot")?.page).toBe(fresh);
  });

  test("a tab closed for the cap is nobody's until the browser has closed it, and is not the spare a Bot is handed", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const { tabs, full, opens } = counting();
    const { hub, opened } = await full("bot", "https://shop.example");
    const oldest = opened[0];
    if (!oldest) throw new Error("no tabs were opened");
    // A close that never comes back: what a wedged browser does with the tab it is asked to drop.
    oldest.close = () => new Promise<void>(() => undefined);
    tabs.touch("bot", hub);
    await opens(hub, "https://shop.example/item/new");

    expect(oldest.isClosed()).toBe(false);
    expect(tabs.owners.has(oldest)).toBe(false);
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CAP);
    expect(tabs.isSpare(oldest)).toBe(false);
  });
});

/** What a session holds open, with tabs that are nothing but themselves. */
describe("a Bot's session", () => {
  test("holds the tab being cast, the tab a value is wanted on, and the tab a hand was asked for or the wheel taken on — each only for as long as that lasts", async () => {
    const base = await mkdtemp(join(tmpdir(), "laf-tab-held-"));
    try {
      const sessions = createSessions({
        stateDirectoryFor: (botId) => join(base, botId),
      });
      const session = sessions.sessionFor("held-bot");
      const page = (name: string) => ({ name }) as unknown as Page;
      const [cast, asked, handed, other] = [
        page("cast"),
        page("asked"),
        page("handed"),
        page("other"),
      ];
      const held = () =>
        [cast, asked, handed, other].map((tab) => holdsTab(session, tab));
      // A session this process never made holds nothing.
      expect(holdsTab(undefined, cast)).toBe(false);
      expect(held()).toEqual([false, false, false, false]);

      // A person watching: the picture is of that tab, and their hands would land on it.
      session.viewer = {
        socket: {},
        cast: {} as unknown as Screencast,
        page: cast,
      };
      expect(held()).toEqual([true, false, false, false]);
      session.viewer = undefined;
      expect(held()).toEqual([false, false, false, false]);

      // A value asked for into a box on a tab, until it is typed.
      session.control.requestSecret({ ref: "e7", snapshotId: 1 });
      session.secretTab = asked;
      expect(held()).toEqual([false, true, false, false]);
      session.control.secretSupplied();
      expect(held()).toEqual([false, false, false, false]);

      // A hand asked for on a tab, and the person who came keeping the wheel on it.
      session.wheelTab = handed;
      expect(held()).toEqual([false, false, false, false]);
      session.control.requestHelp("로그인이 필요합니다");
      expect(held()).toEqual([false, false, true, false]);
      session.control.take();
      expect(held()).toEqual([false, false, true, false]);
      session.control.release();
      expect(held()).toEqual([false, false, false, false]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!HAS_BROWSER)("a Bot that keeps opening tabs", () => {
  test("holds a number of them that stops growing", async () => {
    const bot = "cap-count-bot";
    const hub = fixture?.url ?? "";
    expect((await post("/navigate", bot, { url: hub })).status).toBe(200);
    const context = (await tabOf(bot)).context();
    const OPENS = 30;
    /** After each open: the tabs the Bot is told it has, and the pages the browser has. */
    const counts: [number, number][] = [];
    for (let open = 1; open <= OPENS; open += 1) {
      if (open % 10 === 0) await opensItself(bot, "/other");
      else await openFromHub(bot, hub);
      const listed = tabsOf(await post("/snapshot", bot)).length;
      // A closed tab is asked to close and not waited for: counted once the browser has done it.
      await until(
        () =>
          context.pages().filter((page) => !page.isClosed()).length <= listed,
      );
      counts.push([
        listed,
        context.pages().filter((page) => !page.isClosed()).length,
      ]);
    }
    // On `main`, before the cap: [[2,2],[3,3],[4,4] … [31,31]].
    console.info(
      `one Bot, ${OPENS} opens, never idle — [its tabs, the browser's pages] after each: ${JSON.stringify(counts)}`,
    );
    expect(Math.max(...counts.map(([tabs]) => tabs))).toBe(TAB_CAP);
    expect(Math.max(...counts.map(([, pages]) => pages))).toBe(TAB_CAP);
    expect(counts.at(-1)).toEqual([TAB_CAP, TAB_CAP]);
  }, 120_000);

  test("loses the tab it used longest ago, keeps the one it went back to, and leaves another Bot's tabs alone", async () => {
    const [bot, otherBot] = ["cap-oldest-bot", "cap-neighbour-bot"];
    // Another Bot with tabs of its own in the same browser, opened first: older than all of these.
    await post("/navigate", otherBot, { url: fixture?.url });
    const theirs = [await tabOf(otherBot)];
    theirs.push(await pressForTab(otherBot, NEW_TAB));
    const { hub, first, opened } = await atTheCap(bot);
    const [revisited, oldest] = opened;
    if (!revisited || !oldest) throw new Error("no tabs were opened");

    // Back to the first tab it opened — by its place in a list just read — and then on.
    const list = tabsOf(await post("/snapshot", bot));
    expect(list).toHaveLength(TAB_CAP);
    expect((await post("/tabs/switch", bot, { index: 1 })).status).toBe(200);
    expect(await tabOf(bot)).toBe(revisited);
    const newest = await openFromHub(bot, hub);

    expect(await until(() => oldest.isClosed())).toBe(true);
    for (const kept of [first, revisited, ...opened.slice(2), newest]) {
      expect(kept.isClosed()).toBe(false);
    }
    expect(tabsOf(await post("/snapshot", bot))).toHaveLength(TAB_CAP);
    // The other Bot's are open, and are all it is told it has.
    for (const page of theirs) expect(page.isClosed()).toBe(false);
    expect(tabsOf(await post("/snapshot", otherBot))).toHaveLength(2);
    expect(await tabOf(otherBot)).toBe(theirs[1] as Page);
  }, 60_000);

  test("is not frozen and is not told it lost a tab, and an index it read before the close does not land on another tab", async () => {
    const bot = "cap-index-bot";
    const { opened } = await atTheCap(bot);
    const [first, second, third] = opened;
    if (!first || !second || !third) throw new Error("no tabs were opened");
    // The list as the Bot last read it: `second` is index 2.
    const before = await post("/snapshot", bot);
    expect(tabsOf(before)).toHaveLength(TAB_CAP);
    // A window the page opens by itself: the Bot pressed nothing, and has read no list since.
    const window = await opensItself(bot, "/other");
    expect(await until(() => first.isClosed())).toBe(true);

    // Not the loss a crashed tab is: the Bot acts on the tab it is on.
    for (const [path, payload] of [
      ["/scroll", { deltaY: 100 }],
      ["/key", { key: "Escape" }],
    ] as const) {
      const acted = await post(path, bot, payload);
      expect({ path, status: acted.status }).toEqual({ path, status: 200 });
    }
    // `second` moved up to index 1, and index 2 is `third` now. With the cap in and this
    // refusal taken out, the call answered 200 — on `third`, for a Bot that meant `second`.
    const stale = await post("/tabs/switch", bot, { index: 2 });
    expect([stale.status, stale.body.code]).toEqual([409, "laf:stale_refs"]);
    expect(await tabOf(bot)).toBe(window);
    // A read is not the list: the index is still from before.
    const read = await call("GET", "/read", bot);
    expect(read.status).toBe(200);
    expect(read.body.notes).toBeUndefined();
    expect((await post("/tabs/switch", bot, { index: 2 })).status).toBe(409);

    // The list, read again: the same tab is found at its new place, and the old number is another.
    const after = await post("/snapshot", bot);
    expect(tabsOf(after)).toHaveLength(TAB_CAP);
    const moved = await post("/tabs/switch", bot, { index: 1 });
    expect([moved.status, moved.body.code]).toEqual([200, undefined]);
    expect(await tabOf(bot)).toBe(second);
    expect((await post("/tabs/switch", bot, { index: 2 })).status).toBe(200);
    expect(await tabOf(bot)).toBe(third);
  }, 60_000);

  test("is told once, on its own next list, that an old tab was closed — not on a person's, and never that its own tab went", async () => {
    const bot = "cap-told-bot";
    const { hub } = await atTheCap(bot);
    await post("/snapshot", bot);
    await openFromHub(bot, hub);

    // A person's screen takes a snapshot too. It is not the Bot reading its list, and the fact
    // is not carried off in an answer the Bot never sees.
    const theirs = await call("POST", "/snapshot", bot, {}, PERSONS_LOOK);
    expect(theirs.status).toBe(200);
    expect(theirs.body.notes).toBeUndefined();
    expect((await post("/tabs/switch", bot, { index: 0 })).status).toBe(409);
    // Nor does it ride on a look that carries no list.
    expect((await call("GET", "/read", bot)).body.notes).toBeUndefined();

    const own = await post("/snapshot", bot);
    expect(own.body.notes).toEqual([
      {
        code: "laf:old_tab_closed",
        origin: new URL(fixture?.url ?? "").origin,
        closed: 1,
      },
    ]);
    expect(tabsOf(own)).toHaveLength(TAB_CAP);
    // Once.
    expect((await post("/snapshot", bot)).body.notes).toBeUndefined();
    expect((await call("GET", "/read", bot)).body.notes).toBeUndefined();
    expect((await post("/tabs/switch", bot, { index: 0 })).status).toBe(200);
  }, 60_000);

  describe("in the log", () => {
    let warned: ReturnType<typeof spyOn<Console, "warn">> | undefined;

    afterEach(() => {
      warned?.mockRestore();
      warned = undefined;
    });

    test("leaves one line for a closed tab, with the Bot, the site's origin and how many it had — and nothing else of the page", async () => {
      const bot = "cap-log-bot";
      const hub = fixture?.url ?? "";
      await post("/navigate", bot, { url: hub });
      // The tab that will be the oldest: an address with a path and a query, a page with a title.
      await opensItself(bot, "/other?orderno=20261005-7788");
      for (let open = 2; open < TAB_CAP; open += 1) await openFromHub(bot, hub);
      warned = spyOn(console, "warn").mockImplementation(() => undefined);
      for (let more = 0; more < 3; more += 1) await openFromHub(bot, hub);

      const lines = warned.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("tab_cap"));
      // Three tabs went, inside one minute: one line.
      expect(lines).toHaveLength(1);
      const line = lines[0] ?? "";
      expect(JSON.parse(line)).toMatchObject({
        level: "warn",
        svc: "agent-computer",
        event: "tab_capped",
        bot,
        origin: new URL(hub).origin,
        tabs: TAB_CAP + 1,
      });
      // The whole line as it was written, the way a secret is tested: no path, no query, no title.
      for (const kept of ["other", "orderno", "20261005", "7788", "주문"]) {
        expect({ kept, logged: line.includes(kept) }).toEqual({
          kept,
          logged: false,
        });
      }
    }, 60_000);
  });

  /*
   * THE TABS THAT MAY NOT GO, THROUGH THE DOOR. `/to-hang` has a link that opens the same page in
   * a new tab, so a chain of them is pressed from one tab to the next: the first tab is then the
   * one used longest ago, and nothing but what is held on it keeps it.
   */
  test("keeps the tab it asked a person for a value on, however long ago it was used, and the value still goes into it", async () => {
    const bot = "cap-secret-bot";
    const TYPED = "PERSON-TYPED-ON-THE-OLDEST-TAB-6612";
    await post("/navigate", bot, { url: `${fixture?.url}to-hang` });
    const asked = await tabOf(bot);
    const look = await post("/snapshot", bot);
    const box = elementsOf(look).find(
      (element) => element.name === TO_HANG_PIN,
    );
    if (!box) throw new Error("the /to-hang fixture has no box");
    const wanted = await post("/control/secret", bot, {
      label: "간편 확인 값",
      ref: box.ref,
      snapshotId: look.body.snapshotId,
    });
    expect(wanted.body.secretWanted).toBe("간편 확인 값");

    // While it waits, tab after tab opens: two more than it may hold.
    const chain: Page[] = [];
    for (let open = 0; open <= TAB_CAP; open += 1) {
      chain.push(await pressForTab(bot, SAME_IN_NEW_TAB));
    }
    const [second, third, ...rest] = chain;
    if (!second || !third) throw new Error("no tabs were opened");

    expect(await until(() => second.isClosed() && third.isClosed())).toBe(true);
    expect(asked.isClosed()).toBe(false);
    for (const kept of rest) expect(kept.isClosed()).toBe(false);
    const list = tabsOf(await post("/snapshot", bot));
    expect(list).toHaveLength(TAB_CAP);
    // The ask stands, and the person's value goes into the box it was asked for.
    expect((await call("GET", "/control", bot)).body.secretWanted).toBe(
      "간편 확인 값",
    );
    expect((await post("/tabs/switch", bot, { index: 0 })).status).toBe(200);
    expect(await tabOf(bot)).toBe(asked);
    const typed = await post("/human/secret", bot, { text: TYPED });
    expect([typed.status, typed.body.supplied]).toEqual([200, true]);
    expect(
      await asked.evaluate(() => document.querySelector("input")?.value),
    ).toBe(TYPED);
  }, 60_000);

  test("keeps the tab a person was handed the wheel on while they hold it, and not after they give it back", async () => {
    const bot = "cap-wheel-bot";
    await post("/navigate", bot, { url: `${fixture?.url}to-hang` });
    const handed = await tabOf(bot);
    const asked = await post("/control/request", bot, {
      reason: "로그인이 필요합니다",
    });
    expect(asked.body.requested).toBe(true);
    expect((await post("/control/take", bot)).body.holder).toBe("human");

    // The person presses the link that opens this page in a new tab, on each tab in turn.
    const box = await handed.locator("#self-tab").boundingBox();
    if (!box) throw new Error("the /to-hang fixture has no link to a new tab");
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const chain: Page[] = [];
    for (let open = 0; open <= TAB_CAP; open += 1) {
      const from = await tabOf(bot);
      expect((await post("/human/click", bot, at)).status).toBe(200);
      expect(await until(async () => (await tabOf(bot)) !== from)).toBe(true);
      chain.push(await tabOf(bot));
    }
    const [second, third, fourth] = chain;
    if (!second || !third || !fourth) throw new Error("no tabs were opened");

    expect(await until(() => second.isClosed() && third.isClosed())).toBe(true);
    expect(handed.isClosed()).toBe(false);
    expect(fourth.isClosed()).toBe(false);
    expect(tabsOf(await post("/snapshot", bot))).toHaveLength(TAB_CAP);

    // Handed back: it is the tab used longest ago and nothing more, and goes when the next opens.
    expect((await post("/control/release", bot)).body.holder).toBe("bot");
    await pressForTab(bot, SAME_IN_NEW_TAB);
    expect(await until(() => handed.isClosed())).toBe(true);
    expect(fourth.isClosed()).toBe(false);
    expect(tabsOf(await post("/snapshot", bot))).toHaveLength(TAB_CAP);
  }, 60_000);
});

/*
 * TEN IDLE MINUTES STILL CLOSE EVERYTHING A BOT HOLDS, AND THE TWO DO NOT SPEAK FOR EACH OTHER.
 * The cap closes one tab when another opens; the idle sweep closes whatever is left once the Bot
 * has stopped calling. A browser of its own, so the clock can be this test's.
 */
describe.skipIf(!HAS_BROWSER)(
  "a Bot at its number of tabs that goes idle",
  () => {
    test("has every tab closed by the idle sweep, which reports no tab the cap closed — and the cap's fact ends with the list", async () => {
      const bot = "cap-idle-bot";
      const base = await mkdtemp(join(tmpdir(), "laf-tab-idle-"));
      const clock = { now: 1_000_000 };
      await mkdir(join(base, "profiles"), { recursive: true });
      const profiles = createProfiles(join(base, "profiles"), {
        idleCloseMs: IDLE_CLOSE_MS,
        now: () => clock.now,
      });
      const lines: Record<string, unknown>[] = [];
      const spies = (["log", "info", "warn"] as const).map((level) =>
        spyOn(console, level).mockImplementation((line: unknown) => {
          try {
            lines.push(JSON.parse(String(line)) as Record<string, unknown>);
          } catch {}
        }),
      );
      const said = (event: string) =>
        lines.filter((line) => line.event === event);
      try {
        const hub = await profiles.page(bot);
        await hub.goto(fixture?.url ?? "");
        const opened: Page[] = [];
        for (let open = 0; open <= TAB_CAP; open += 1) {
          const from = await profiles.page(bot);
          await hub.evaluate(() => {
            window.open("/other");
          });
          expect(
            await until(async () => (await profiles.page(bot)) !== from),
          ).toBe(true);
          opened.push(await profiles.page(bot));
        }
        // Two more than it may hold were opened, and the two oldest went for the cap.
        expect(await profiles.tabs(bot)).toHaveLength(TAB_CAP);
        expect(profiles.cappedOf(bot)).toBe(2);
        expect(said("tab_capped")).toHaveLength(1);
        const kept = [hub, ...opened.slice(2)];
        for (const page of kept) expect(page.isClosed()).toBe(false);

        // A second short of ten minutes: nothing goes.
        clock.now += IDLE_CLOSE_MS - 1;
        expect(await profiles.closeIdle()).toEqual([]);
        expect(await profiles.tabs(bot)).toHaveLength(TAB_CAP);

        // Ten minutes: everything the Bot holds, and the browser after it.
        clock.now += 1;
        expect(await profiles.closeIdle()).toEqual([bot]);
        for (const page of kept) expect(page.isClosed()).toBe(true);
        expect(profiles.liveBots()).toEqual([]);
        expect(said("computer_idle_closed")).toEqual([
          expect.objectContaining({ bots: [bot] }),
        ]);
        // The sweep closed six tabs and said nothing of the cap: still the one line from before.
        expect(said("tab_capped")).toHaveLength(1);
        expect(said("tab_cap_exceeded")).toEqual([]);

        // And what the cap closed is not said about a list that is gone: the Bot's next tab is one
        // tab, with nothing to be told and no index refused.
        expect(profiles.cappedOf(bot)).toBe(0);
        expect(profiles.listRead(bot, 2)).toBeUndefined();
        const fresh = await profiles.page(bot);
        expect(await profiles.tabs(bot)).toHaveLength(1);
        await profiles.switchTab(bot, 0);
        expect(await profiles.page(bot)).toBe(fresh);
      } finally {
        for (const spy of spies) spy.mockRestore();
        await profiles.closeAll();
        await rm(base, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
