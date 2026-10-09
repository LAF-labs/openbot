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
  STRAY_GRACE_MS,
  TAB_CAP,
  TAB_CEILING,
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
 * The first test below, run against `main`'s source (39341c2f, unpacked beside this file, with the
 * three names this file imports that `main` does not have stood in for by a constant and two
 * stubs — as it stands the file fails there at import): one Bot, thirty opens, never idle — its
 * tabs after each were 2, 3, 4 … 31, and the browser's pages the same. And what one costs, in
 * the stable image on news.naver.com: 130–140 MiB and 13–14 processes for every tab after the
 * first, under a container limit of 3 GiB.
 *
 * So a Bot holds `TAB_CAP` tabs, and one it has not used for longest is closed to make room for a
 * new one — never the tab it is on, a tab an open window reports to, or a tab a person or an ask
 * is holding. The Bot is not told it lost a tab, because it did not: what changed is the list its
 * `computer_switch_tab` index was read from, and an index from before is refused until it has
 * read the list again. And a tab that is nobody's, which no count reaches, is closed by the idle
 * sweep once it has been nobody's for a minute.
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

/**
 * A tab is adopted, then the browser is asked whether it reports to its opener, and only then is
 * the Bot kept to its number: a moment behind the adoption, and waited for here.
 */
async function keptToItsNumber(bot: string): Promise<void> {
  const kept = await until(
    async () => ((await computer?.profiles.tabs(bot)) ?? []).length <= TAB_CAP,
  );
  if (!kept) throw new Error("the Bot was not brought back to its number");
}

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
  await keptToItsNumber(bot);
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
  await keptToItsNumber(bot);
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
    /** The tabs that can reach the one that opened them, as the browser says of a real one. */
    const reporting = new WeakSet<Page>();
    /** A browser that does not answer the question at all: short of memory, or wedged. */
    const silent = { browser: false };
    const tabs = createTabs({
      pages: () => open,
      now: () => clock.now,
      onPage: () => undefined,
      onLost: (botId, how) => lost.push([botId, how]),
      holds: (_botId, page) => holds(page),
      reportsToOpener: async (page) => {
        if (silent.browser) throw new Error("Target.getTargetInfo: no answer");
        return reporting.has(page);
      },
    });
    /** A Bot's first tab, as `profiles.page` hands one. */
    const first = (botId: string, address: string): FakeTab => {
      const made = tab(address);
      open.push(made);
      tabs.own(botId, made);
      tabs.touch(botId, made);
      return made;
    };
    /**
     * A tab a plain link opened — a result off a list — adopted as the browser's `page` event has
     * it adopted. It cannot reach the page it came from.
     */
    const opens = async (from: FakeTab, address: string): Promise<FakeTab> => {
      const made = tab(address, from);
      open.push(made);
      tabs.adoptOpened(made);
      await Bun.sleep(0);
      return made;
    };
    /** A window a page opened to hear back from — a sign-in, a payment — which reports to it. */
    const opensWindow = async (
      from: FakeTab,
      address: string,
    ): Promise<FakeTab> => {
      const made = tab(address, from);
      reporting.add(made);
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
    return {
      tabs,
      open,
      lost,
      clock,
      silent,
      first,
      opens,
      opensWindow,
      full,
      tab,
    };
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

    // And the other Bot's own seventh, pressed on its own list, closes one of its own.
    tabs.touch("other-bot", theirs.hub);
    await opens(theirs.hub, "https://bank.example/item/new");
    expect(theirs.opened[0]?.isClosed()).toBe(true);
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CAP);
    expect(tabs.pagesOf("other-bot")).toHaveLength(TAB_CAP);
    expect(lost).toEqual([]);
  });

  /*
   * A WINDOW REPORTS TO THE PAGE THAT OPENED IT, AND THAT PAGE IS KEPT BY RULE. The first version
   * kept only the tab that opened the one the Bot was on. With a page, its sign-in window and two
   * windows above that, the page — used longest ago — was closed under three open windows, and the
   * sign-in had nowhere to hand its result (`d441b042`).
   */
  test("never a tab an open window reports to, all the way up a chain of them and whichever tab the Bot is on — while a tab a plain link opened keeps nothing", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const { tabs, first, opens, opensWindow } = counting();
    // Three pages, a fourth, and a sign-in window the fourth opened.
    const one = first("bot", "https://shop.example/list?q=1");
    const two = await opens(one, "https://shop.example/item/2");
    const three = await opens(one, "https://shop.example/item/3");
    const page = await opens(one, "https://shop.example/checkout");
    const signIn = await opensWindow(page, "https://id.example/sign-in");
    // The Bot goes round the three and comes back to the window: the page under it is now the
    // tab it used longest ago.
    for (const visited of [one, two, three, signIn]) tabs.touch("bot", visited);

    // The window opens a 본인인증 window, and that one opens another: seven.
    const verify = await opensWindow(signIn, "https://cert.example/verify");
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CAP);
    const app = await opensWindow(verify, "https://cert.example/app");
    // Each window reports to the one before it and the first to the page: none of them goes.
    // The one that does is the oldest of the rest.
    expect(one.isClosed()).toBe(true);
    expect(tabs.pagesOf("bot")).toEqual([
      two,
      three,
      page,
      signIn,
      verify,
      app,
    ]);

    // Whichever tab the Bot is on: on a result a plain link opened from another page, the page
    // under the sign-in window still stays — and the page that link was on goes, though the tab
    // it opened is open and the Bot is on it. A result has nothing to say to its list.
    const more = await opens(two, "https://shop.example/item/more");
    expect(two.isClosed()).toBe(true);
    expect(tabs.pagesOf("bot")).toEqual([
      three,
      page,
      signIn,
      verify,
      app,
      more,
    ]);

    // Only for as long as the window is open. Its site closes the sign-in window; the page is
    // then the tab used longest ago and nothing more, and goes when the Bot is over its number.
    await signIn.close();
    await opens(more, "https://shop.example/item/a");
    expect(page.isClosed()).toBe(false);
    await opens(more, "https://shop.example/item/b");
    expect(page.isClosed()).toBe(true);
    // The window above still has one reporting to it, and stays.
    expect(verify.isClosed()).toBe(false);
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CAP);
  });

  test("never a tab that is held, and when nothing may go the Bot is over its number and a line says so", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const held = new Set<Page>();
    const every = { tab: false };
    const { tabs, clock, full, opens } = counting(
      (page) => every.tab || held.has(page),
    );
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
    every.tab = true;
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
    every.tab = false;
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
    const { tabs, clock, full, opens } = counting();
    const { hub } = await full("loop-bot", "https://shop.example");
    const other = await full("other-bot", "https://bank.example");

    // A Bot working down a list: back to the list, the next result is a tab, and a tab is closed.
    for (let item = 0; item < 3; item += 1) {
      tabs.touch("loop-bot", hub);
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
    tabs.touch("other-bot", other.hub);
    await opens(other.hub, "https://bank.example/item/more");
    other.hub.emit("crash");
    expect(linesOf("tab_capped").map((line) => line.bot)).toEqual([
      "loop-bot",
      "other-bot",
    ]);
    expect(linesOf("tab_crashed")).toHaveLength(1);

    clock.now += 60_000;
    tabs.touch("loop-bot", hub);
    await opens(hub, "https://shop.example/item/later");
    expect(linesOf("tab_capped").at(-1)).toMatchObject({
      bot: "loop-bot",
      unsaid: 2,
    });
    // Every line as it was written: no path, no query.
    expect(JSON.stringify(warned.mock.calls)).not.toMatch(/item|list|from|q=/);
  });

  test("an index read before a tab was closed is refused until the list is read again, and every tab that went is handed over once — how many, and their sites", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const { tabs, first, opens } = counting();
    const hub = first("bot", "https://shop.example/list?q=1");
    await opens(hub, "https://news.example/story?id=1");
    await opens(hub, "https://pay.example/window?order=7");
    await opens(hub, "https://shop.example/item/3");
    await opens(hub, "https://shop.example/item/4");
    const fifth = await opens(hub, "https://shop.example/item/5");
    // The list as the Bot reads it now: nothing closed, and an index is taken.
    const read = tabs.cappedOf("bot");
    expect(read).toBe(0);
    expect(tabs.listRead("bot", read)).toBeUndefined();
    expect(tabs.pagesOf("bot")[5]).toBe(fifth);
    await tabs.switchTab("bot", 0);
    expect(tabs.live.get("bot")?.page).toBe(hub);

    // Two more open before the Bot looks again, and two tabs go. `fifth` was index 5 and is
    // index 3 of what is left: index 5 is another tab now.
    const seventh = await opens(hub, "https://shop.example/item/7");
    const eighth = await opens(seventh, "https://shop.example/item/8");
    expect(tabs.pagesOf("bot")[3]).toBe(fifth);
    expect(tabs.pagesOf("bot")[5]).toBe(eighth);

    await expect(tabs.switchTab("bot", 5)).rejects.toBeInstanceOf(TabListError);
    // Refused, not moved: the Bot is on the tab it was on.
    expect(tabs.live.get("bot")?.page).toBe(eighth);
    // A list read before the close is not the list: it lets nothing through and says nothing.
    expect(tabs.listRead("bot", read)).toBeUndefined();
    await expect(tabs.switchTab("bot", 5)).rejects.toBeInstanceOf(TabListError);

    // The list is read, and a third tab goes before its answer is written.
    const again = tabs.cappedOf("bot");
    await opens(eighth, "https://shop.example/item/9");
    // BOTH tabs that list no longer shows, by their sites — not the last one alone. The first
    // version said `closed: 2` beside one origin, and its sentence spoke of one tab.
    expect(tabs.listRead("bot", again)).toEqual({
      closed: 2,
      origins: ["https://news.example", "https://pay.example"],
    });
    expect(tabs.listRead("bot", again)).toBeUndefined();
    // The third is not in that list: it is the next one's to say, and the index is still stale.
    await expect(tabs.switchTab("bot", 2)).rejects.toBeInstanceOf(TabListError);
    const latest = tabs.cappedOf("bot");
    expect(tabs.listRead("bot", latest)).toEqual({
      closed: 1,
      origins: ["https://shop.example"],
    });
    expect(tabs.listRead("bot", latest)).toBeUndefined();
    await tabs.switchTab("bot", 2);
    expect(tabs.live.get("bot")?.page).toBe(fifth);

    // Two tabs of one site: the site is said once, the count is still two.
    const tenth = await opens(fifth, "https://shop.example/item/10");
    await opens(tenth, "https://shop.example/item/11");
    expect(tabs.listRead("bot", tabs.cappedOf("bot"))).toEqual({
      closed: 2,
      origins: ["https://shop.example"],
    });

    // What became of a list ends with it: every tab closed, and the Bot's next tab starts clean.
    await opens(fifth, "https://shop.example/item/12");
    expect(tabs.cappedOf("bot")).toBe(6);
    await tabs.closeTabsOf("bot");
    expect(tabs.cappedOf("bot")).toBe(0);
    expect(tabs.listRead("bot", 6)).toBeUndefined();
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

  /*
   * A CHAIN OF WINDOWS HAS A CEILING. A window that opens a window that opens a window: every tab
   * but the newest is reported to, and the Bot is moved onto each as it opens, so the cap finds
   * nothing to close. On `1b230f33` that was one more tab for every window, with a line saying so
   * and no end. No Bot presses anything for it — a page's script and each window's `onload` do.
   */
  test("a chain of windows, each opened by the last, stops growing at the ceiling: the tab used longest ago goes whatever reports to it — never the one the Bot is on, never a held one", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const held = new Set<Page>();
    const { tabs, lost, first, opensWindow } = counting((page) =>
      held.has(page),
    );
    const page = first("bot", "https://shop.example/pay?order=7");
    const chain: FakeTab[] = [];
    let newest = page;
    const next = async () => {
      newest = await opensWindow(
        newest,
        `https://pop.example/w/${chain.length + 1}?k=1`,
      );
      chain.push(newest);
      return tabs.pagesOf("bot").length;
    };
    for (let nth = 1; nth < TAB_CEILING; nth += 1) await next();
    // Twelve tabs, each reported to by the next: none went for the cap, and a line says so.
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CEILING);
    expect(tabs.cappedOf("bot")).toBe(0);
    expect(linesOf("tab_cap_exceeded")).toHaveLength(1);

    // The thirteenth is past the ceiling: the tab used longest ago goes, though a window
    // reports to it — the page the chain began on.
    const counts = [await next()];
    expect(page.isClosed()).toBe(true);
    expect(chain.map((opened) => opened.isClosed())).not.toContain(true);
    // The next oldest is held — a person's hands, an ask standing: it stays, and the one after
    // it goes in its place.
    const [kept, second] = chain;
    if (!kept || !second) throw new Error("no windows were opened");
    held.add(kept);
    counts.push(await next());
    expect([kept.isClosed(), second.isClosed()]).toEqual([false, true]);

    // However many more open, the Bot holds the ceiling and no more.
    for (let more = 0; more < 10; more += 1) counts.push(await next());
    expect(Math.max(...counts)).toBe(TAB_CEILING);
    expect(Math.min(...counts)).toBe(TAB_CEILING);
    // Never the tab the Bot is on, and so never a loss: it is where the last window put it.
    expect(tabs.live.get("bot")?.page).toBe(newest);
    expect(newest.isClosed()).toBe(false);
    expect(kept.isClosed()).toBe(false);
    expect(lost).toEqual([]);
    // Said to the Bot as any tab closed for its number is: how many, and the sites of the last.
    expect(tabs.listRead("bot", tabs.cappedOf("bot"))).toEqual({
      closed: 12,
      origins: ["https://pop.example"],
    });
    // And in a line of its own, one a minute, with the ceiling and an origin and nothing else.
    expect(linesOf("tab_ceiling_closed")).toEqual([
      expect.objectContaining({
        bot: "bot",
        origin: "https://shop.example",
        tabs: TAB_CEILING + 1,
        ceiling: TAB_CEILING,
      }),
    ]);
    expect(linesOf("tab_capped")).toEqual([]);
    expect(JSON.stringify(warned.mock.calls)).not.toMatch(/order|k=1|\/w\//);
  });

  test("at the ceiling with every other tab held, a tab that opens is not taken: the Bot stays where it was, holds no more than the ceiling, and is told a tab was closed", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const every = { tab: false };
    const { tabs, lost, first, opens, opensWindow } = counting(() => every.tab);
    let newest = first("bot", "https://shop.example/pay?order=7");
    for (let nth = 1; nth < TAB_CEILING; nth += 1) {
      newest = await opensWindow(newest, `https://pop.example/w/${nth}`);
    }
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CEILING);
    const on = newest;

    // Everything held: nothing may go, whatever the number.
    every.tab = true;
    const refused = await opens(on, "https://ads.example/promo?id=9");
    // Closed before it was ever the Bot's: not in its list, and the Bot is where it was.
    expect(refused.isClosed()).toBe(true);
    expect(tabs.owners.has(refused)).toBe(false);
    expect(tabs.live.get("bot")?.page).toBe(on);
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CEILING);
    expect(lost).toEqual([]);
    expect(linesOf("tab_open_refused")).toEqual([
      expect.objectContaining({
        bot: "bot",
        origin: "https://ads.example",
        tabs: TAB_CEILING,
        ceiling: TAB_CEILING,
      }),
    ]);
    expect(JSON.stringify(warned.mock.calls)).not.toMatch(/promo|id=9/);
    // The Bot's next list says a tab was closed, and whose site.
    expect(tabs.listRead("bot", tabs.cappedOf("bot"))).toEqual({
      closed: 1,
      origins: ["https://ads.example"],
    });

    // Let go of: the next tab is taken, and the oldest goes for it.
    every.tab = false;
    const taken = await opensWindow(on, "https://pop.example/w/next");
    expect(taken.isClosed()).toBe(false);
    expect(tabs.live.get("bot")?.page).toBe(taken);
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CEILING);
  });

  /*
   * AN ANSWER THAT NEVER CAME. The browser is asked whether a new tab can reach its opener, and
   * a browser short of memory — when the cap matters most — is the one that does not answer. On
   * `1b230f33` no answer kept the opener for the tab's life and was never asked for again: a
   * chain of plain `_blank` results, which report to nothing, became a chain nothing could be
   * closed from.
   */
  test("a tab the browser never answered about keeps its opener only until it is asked again — each time the Bot is over its number — and never past the ceiling", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const { tabs, first, opens, silent } = counting();
    // Plain links, one page to the next, and a browser that answers nothing about any of them.
    silent.browser = true;
    const chain = [first("bot", "https://news.example/story/1")];
    const next = async () => {
      const from = chain.at(-1) as FakeTab;
      chain.push(
        await opens(from, `https://news.example/story/${chain.length + 1}`),
      );
    };
    for (let story = 2; story <= TAB_CEILING + 2; story += 1) await next();
    // Unknown, so kept — but not past the ceiling: twelve, and the two oldest gone.
    expect(tabs.pagesOf("bot")).toEqual(chain.slice(2));
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CEILING);

    // The browser answers again. The next tab that opens has every unanswered tab asked about
    // once more; none of them reports to anything, and the Bot is back at its number.
    silent.browser = false;
    await next();
    expect(tabs.pagesOf("bot")).toEqual(chain.slice(-TAB_CAP));
    expect(tabs.pagesOf("bot")).toHaveLength(TAB_CAP);
  });

  /*
   * A TAB THAT IS NOBODY'S. One whose opener was gone before the browser said who opened it, one
   * the browser opened itself, and whatever such a tab opens: in no Bot's list and no Bot's
   * count, and open for as long as any Bot had a tab (on `d441b042`, and on main).
   */
  test("a tab that is nobody's is closed by the sweep once it has been nobody's for a minute — not sooner, not one a Bot took meanwhile, and not the browser's last tab", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const { tabs, open, clock, first, opens, tab } = counting();
    const mine = first("bot", "https://shop.example/list?q=1");
    // Nobody's: no Bot's page opened it. And the tab it opens is nobody's too.
    const stray = tab("https://ads.example/landing?campaign=77");
    open.push(stray);
    tabs.adoptOpened(stray);
    const child = await opens(stray, "https://ads.example/more?x=1");
    // And one that is nobody's only on its way to being somebody's.
    const taken = tab("about:blank");
    open.push(taken);
    expect([stray, child, taken].map((page) => tabs.owners.has(page))).toEqual([
      false,
      false,
      false,
    ]);

    // The sweep that first finds them: seen, and left.
    expect(tabs.closeStrays()).toBe(0);
    tabs.own("other-bot", taken);
    tabs.touch("other-bot", taken);
    clock.now += STRAY_GRACE_MS - 1;
    expect(tabs.closeStrays()).toBe(0);
    expect([stray, child].map((page) => page.isClosed())).toEqual([
      false,
      false,
    ]);

    clock.now += 1;
    expect(tabs.closeStrays()).toBe(2);
    expect([stray, child].map((page) => page.isClosed())).toEqual([true, true]);
    // A Bot's tab is untouched, and so is the one a Bot took before the minute was out.
    expect([mine, taken].map((page) => page.isClosed())).toEqual([
      false,
      false,
    ]);
    // One line for the two, by the site's origin only, and about no Bot.
    expect(linesOf("tab_stray_closed")).toEqual([
      expect.objectContaining({ origin: "https://ads.example", pages: 4 }),
    ]);
    expect(linesOf("tab_stray_closed")[0]).not.toHaveProperty("bot");
    // Read with each line's timestamp taken out: `77` is two digits a stamp can hold, and read
    // whole this failed on a pull request that changed only a document (CI run 37446578184,
    // 2026-10-06) — the same thing `crashed-tab.test.ts` had, found the same afternoon.
    expect(
      JSON.stringify(warned.mock.calls).replace(
        /\d{4}-\d{2}-\d{2}T[\d:.]+Z/g,
        "",
      ),
    ).not.toMatch(/landing|campaign|77|more|x=1/);

    // THE LAST TAB IS THE SPARE. Every Bot's tab gone and one tab left that is nobody's: it is
    // what the next Bot with no tab is handed, and the sweep does not take it.
    await tabs.closeTabsOf("bot");
    await tabs.closeTabsOf("other-bot");
    const spare = tab("about:blank");
    open.push(spare);
    expect(tabs.closeStrays()).toBe(0);
    clock.now += 2 * STRAY_GRACE_MS;
    expect(tabs.closeStrays()).toBe(0);
    expect(spare.isClosed()).toBe(false);
    expect(tabs.isSpare(spare)).toBe(true);
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

      // A hand asked for on a tab, held for as long as the ask stands.
      session.helpTab = handed;
      expect(held()).toEqual([false, false, false, false]);
      session.control.requestHelp("휴대폰에서 승인해 주세요");
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
    // Against `main`'s source, before the cap: [[2,2],[3,3],[4,4] … [31,31]].
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

  test("is told once, on its own next list, how many tabs were closed and whose sites — not on a person's, and never that its own tab went", async () => {
    const bot = "cap-told-bot";
    await atTheCap(bot);
    await post("/snapshot", bot);
    // Two windows open before the Bot looks again — a page that opens a window which opens
    // another — and two tabs go.
    await opensItself(bot, "/other?one");
    await opensItself(bot, "/other?two");

    // A person's screen takes a snapshot too. It is not the Bot reading its list, and the fact
    // is not carried off in an answer the Bot never sees.
    const theirs = await call("POST", "/snapshot", bot, {}, PERSONS_LOOK);
    expect(theirs.status).toBe(200);
    expect(theirs.body.notes).toBeUndefined();
    expect((await post("/tabs/switch", bot, { index: 0 })).status).toBe(409);
    // Nor does it ride on a look that carries no list.
    expect((await call("GET", "/read", bot)).body.notes).toBeUndefined();

    const own = await post("/snapshot", bot);
    // Both of them, and the site they showed once: not `closed: 2` beside one tab's sentence.
    expect(own.body.notes).toEqual([
      {
        code: "laf:old_tab_closed",
        closed: 2,
        origins: [new URL(fixture?.url ?? "").origin],
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
   * A WINDOW REPORTS TO THE PAGE THAT OPENED IT. `window.open` is how a sign-in or a payment window
   * is opened, and the new window can reach the one behind it (`window.opener`); a plain
   * `target=_blank` link cannot. The first version kept only the tab that opened the tab the Bot
   * was on: here the page went, used longest ago, with its sign-in window and two more above it
   * still open (`d441b042`: `page.isClosed()` true).
   */
  test("keeps the page a sign-in window reports to, and every window above it, though it is the tab used longest ago", async () => {
    const bot = "cap-chain-bot";
    const hub = fixture?.url ?? "";
    await post("/navigate", bot, { url: hub });
    const list = await tabOf(bot);
    const two = await openFromHub(bot, hub);
    const three = await openFromHub(bot, hub);
    const page = await openFromHub(bot, hub);
    // The page opens a sign-in window, and the Bot is on it.
    const signIn = await opensItself(bot, "/other?sign-in");
    // The Bot goes round the other three and comes back to the window: the page under it is
    // now the tab it used longest ago.
    for (const [index, there] of [
      [0, list],
      [1, two],
      [2, three],
      [4, signIn],
    ] as const) {
      expect((await post("/tabs/switch", bot, { index })).status).toBe(200);
      expect(await tabOf(bot)).toBe(there);
    }

    // The window opens a 본인인증 window, and that one opens another: seven.
    const verify = await opensItself(bot, "/other?verify");
    const app = await opensItself(bot, "/other?app");

    // The oldest of the tabs that may go is the list. The page, the sign-in window and the
    // window above it each have an open window reporting to them, and stay.
    expect(await until(() => list.isClosed())).toBe(true);
    for (const kept of [two, three, page, signIn, verify, app]) {
      expect(kept.isClosed()).toBe(false);
    }
    expect(tabsOf(await post("/snapshot", bot))).toHaveLength(TAB_CAP);
    // And the sign-in window can still reach the page it hands its result to.
    expect(
      await signIn.evaluate(
        () => window.opener !== null && window.opener.closed === false,
      ),
    ).toBe(true);
    // A plain link's tab cannot reach its page, which is why a list is not kept for its results.
    expect(await two.evaluate(() => window.opener === null)).toBe(true);
  }, 60_000);

  /*
   * AND A CHAIN OF THEM HAS A CEILING. Each window opens the next, so every tab but the newest is
   * reported to and none may go for the cap. On `1b230f33` this Bot's tabs went 2, 3, 4 … 19,
   * one for every window.
   */
  describe("whose windows open windows", () => {
    let warned: ReturnType<typeof spyOn<Console, "warn">> | undefined;

    afterEach(() => {
      warned?.mockRestore();
      warned = undefined;
    });

    test("stops at twice its number: the page furthest back goes, the Bot stays on the newest window and is told on its own list", async () => {
      const bot = "cap-ceiling-bot";
      await post("/navigate", bot, { url: `${fixture?.url}other?root=1` });
      const root = await tabOf(bot);
      const OPENS = TAB_CEILING + 6;
      const tabsNow = async () =>
        ((await computer?.profiles.tabs(bot)) ?? []).length;
      warned = spyOn(console, "warn").mockImplementation(() => undefined);
      const counts: number[] = [];
      const windows: Page[] = [];
      for (let nth = 1; nth <= OPENS; nth += 1) {
        const from = await tabOf(bot);
        await from.evaluate((to) => {
          window.open(to);
        }, `/other?window=${nth}`);
        expect(await until(async () => (await tabOf(bot)) !== from)).toBe(true);
        // The ceiling is applied a question to the browser behind the adoption.
        await until(async () => (await tabsNow()) <= TAB_CEILING);
        windows.push(await tabOf(bot));
        counts.push(await tabsNow());
      }
      console.info(
        `one Bot, ${OPENS} windows each opened by the last — its tabs after each: ${JSON.stringify(counts)}`,
      );
      expect(Math.max(...counts)).toBe(TAB_CEILING);
      expect(counts.at(-1)).toBe(TAB_CEILING);

      // Trimmed from the root: the page and the six windows nearest it, and nothing newer.
      expect(root.isClosed()).toBe(true);
      expect(windows.map((opened) => opened.isClosed())).toEqual([
        ...Array.from({ length: 6 }, () => true),
        ...Array.from({ length: TAB_CEILING }, () => false),
      ]);
      // Never the tab the Bot is on: it is on the newest, and acts there.
      expect(await tabOf(bot)).toBe(windows.at(-1) as Page);
      expect((await post("/scroll", bot, { deltaY: 100 })).status).toBe(200);
      const look = await post("/snapshot", bot);
      expect(look.body.notes).toEqual([
        {
          code: "laf:old_tab_closed",
          closed: 7,
          origins: [new URL(fixture?.url ?? "").origin],
        },
      ]);
      expect(tabsOf(look)).toHaveLength(TAB_CEILING);

      // One line for the seven, saying it was the ceiling, with an origin and nothing else.
      const lines = warned.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("tab_ceiling_closed"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        event: "tab_ceiling_closed",
        bot,
        origin: new URL(fixture?.url ?? "").origin,
        tabs: TAB_CEILING + 1,
        ceiling: TAB_CEILING,
      });
      for (const kept of ["other", "root", "window="]) {
        expect({ kept, logged: (lines[0] ?? "").includes(kept) }).toEqual({
          kept,
          logged: false,
        });
      }
    }, 120_000);
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

  test("keeps the tab it asked a person for a hand on while the ask stands, and not after it is answered", async () => {
    const bot = "cap-help-bot";
    await post("/navigate", bot, { url: `${fixture?.url}to-hang` });
    const handed = await tabOf(bot);
    const asked = await post("/control/request", bot, {
      reason: "휴대폰에서 승인해 주세요",
    });
    expect(asked.body.requested).toBe(true);

    // While it waits, the Bot opens tab after tab from the one it is on: two more than it may hold.
    const chain: Page[] = [];
    for (let open = 0; open <= TAB_CAP; open += 1) {
      chain.push(await pressForTab(bot, SAME_IN_NEW_TAB));
    }
    const [second, third, ...rest] = chain;
    if (!second || !third) throw new Error("no tabs were opened");

    expect(await until(() => second.isClosed() && third.isClosed())).toBe(true);
    expect(handed.isClosed()).toBe(false);
    for (const kept of rest) expect(kept.isClosed()).toBe(false);
    expect(tabsOf(await post("/snapshot", bot))).toHaveLength(TAB_CAP);

    // Answered: it is the tab used longest ago and nothing more, and goes when the next opens.
    expect((await post("/control/release", bot)).body.requested).toBe(false);
    const last = rest.at(-1);
    if (!last) throw new Error("no tab was kept");
    await pressForTab(bot, SAME_IN_NEW_TAB);
    expect(await until(() => handed.isClosed())).toBe(true);
    expect(last.isClosed()).toBe(false);
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
        expect(
          await until(
            async () => (await profiles.tabs(bot)).length === TAB_CAP,
          ),
        ).toBe(true);
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

/*
 * A TAB THAT IS NOBODY'S, IN A REAL BROWSER. A page nothing of a Bot's opened is in no Bot's list:
 * the cap does not count it, the idle close does not reach it, and anything it opens is nobody's
 * too. A browser of its own, so the clock can be this test's.
 */
describe.skipIf(!HAS_BROWSER)("a tab that is nobody's", () => {
  test("is closed by the sweep after a minute, with the tab it opened — a Bot's tabs are left, and the browser's last tab is the spare the next Bot is handed", async () => {
    const bot = "stray-owner-bot";
    const base = await mkdtemp(join(tmpdir(), "laf-tab-stray-"));
    const clock = { now: 1_000_000 };
    await mkdir(join(base, "profiles"), { recursive: true });
    const profiles = createProfiles(join(base, "profiles"), {
      idleCloseMs: IDLE_CLOSE_MS,
      now: () => clock.now,
    });
    const warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const strayLines = () =>
      warned.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("tab_stray_closed"));
    try {
      const mine = await profiles.page(bot);
      await mine.goto(fixture?.url ?? "");
      // A window of the Bot's own, adopted: it is the Bot's, and must be left.
      await mine.evaluate(() => {
        window.open("/other");
      });
      expect(await until(async () => (await profiles.page(bot)) !== mine)).toBe(
        true,
      );
      const adopted = await profiles.page(bot);
      const context = mine.context();
      // Nobody's: no page of a Bot's opened it. And it opens a window, which is nobody's too.
      const stray = await context.newPage();
      await stray.goto(`${fixture?.url}other?orderno=20261005-7788`);
      await stray.evaluate(() => {
        window.open("/other?from=stray");
      });
      expect(await until(() => context.pages().length === 4)).toBe(true);
      const child = context
        .pages()
        .find((page) => ![mine, adopted, stray].includes(page));
      if (!child) throw new Error("the stray's window did not open");
      await child.waitForLoadState("domcontentloaded");
      // In no Bot's list, before or after.
      expect(await profiles.tabs(bot)).toHaveLength(2);

      // The sweep that first finds them, and one a millisecond short of the minute: all four open.
      expect(await profiles.closeIdle()).toEqual([]);
      clock.now += STRAY_GRACE_MS - 1;
      expect(await profiles.closeIdle()).toEqual([]);
      expect(context.pages().filter((page) => !page.isClosed())).toHaveLength(
        4,
      );
      expect(strayLines()).toEqual([]);

      clock.now += 1;
      expect(await profiles.closeIdle()).toEqual([]);
      expect(await until(() => stray.isClosed() && child.isClosed())).toBe(
        true,
      );
      expect([mine, adopted].map((page) => page.isClosed())).toEqual([
        false,
        false,
      ]);
      expect(await profiles.tabs(bot)).toHaveLength(2);
      // One line for the two, with an origin and nothing else of either page.
      expect(strayLines()).toHaveLength(1);
      const line = strayLines()[0] ?? "";
      expect(JSON.parse(line)).toMatchObject({
        level: "warn",
        event: "tab_stray_closed",
        origin: new URL(fixture?.url ?? "").origin,
        pages: 4,
      });
      for (const kept of ["other", "orderno", "20261005", "stray-owner"]) {
        expect({ kept, logged: line.includes(kept) }).toEqual({
          kept,
          logged: false,
        });
      }

      // THE LAST TAB. The Bot's own tabs go, and the one tab left is nobody's: the sweep leaves
      // it, and it is what the Bot is handed when it next asks for a tab.
      await adopted.close();
      await mine.close();
      const spare = await context.newPage();
      expect(await profiles.closeIdle()).toEqual([]);
      clock.now += 2 * STRAY_GRACE_MS;
      expect(await profiles.closeIdle()).toEqual([]);
      expect(spare.isClosed()).toBe(false);
      expect(await profiles.page(bot)).toBe(spare);
    } finally {
      warned.mockRestore();
      await profiles.closeAll();
      await rm(base, { recursive: true, force: true });
    }
  }, 60_000);
});
