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
import { decodeScreenFrame } from "../../shared/screen-frame";
import type { Computer } from "../src/computer";
import { readConfig } from "../src/config";
import { createEgressGuard } from "../src/egress-guard";
import { liveScreen, type StreamData } from "../src/live-screen";
import { log } from "../src/log";
import { diedUnder } from "../src/navigation";
import { guardNavigations } from "../src/navigation-guard";
import { watchPage } from "../src/page-watch";
import { createProfiles } from "../src/profiles";
import { saysRendererDied } from "../src/respond";
import { computerFetch } from "../src/routes";
import { createSessions } from "../src/sessions";
import { tabLost } from "../src/tab-loss";
import { createTabs, type TabLost } from "../src/tabs";
import { createWorkspace } from "../src/workspace";
import { serveFixture, TO_HANG_PIN, VISIBLE_TEXT } from "./fixture-site";

/**
 * A TAB WHOSE RENDERER DIED, AND THE BOT THAT HAS TO GO ON WORKING AFTERWARDS.
 *
 * Measured 2026-10-05 (docs/laf/browser-limits.md §2): one Bot driven through 57 browsing tasks on
 * heavy Korean pages stopped opening ANY address — nineteen `laf:navigation_failed` in a row and a
 * few `laf:browser_failed`, still dead ten minutes later — while the container stayed healthy,
 * logged nothing, and a Bot with another name worked at once. A renderer that crashes leaves its
 * tab neither closed nor detached, so the tab stayed that Bot's, every `goto` on it was refused by
 * Playwright in a millisecond (`Page crashed`), and the idle close never came because the Bot kept
 * asking.
 *
 * IN THIS PROCESS, BEHIND THE REAL DOOR. The other suites start `src/index.ts` as a child and
 * speak HTTP to it; which renderer is a tab's can only be found by whoever holds the tab, so this
 * one builds the computer the way `index.ts` does — the same routes, socket, profiles, sessions and
 * navigation guard — and keeps the `profiles` it was built from, to reach the tab a Bot was handed.
 * Every call below still goes in over HTTP with the token and the Bot's header.
 *
 * Skipped where Playwright has no browser downloaded, like hung-site.test.ts.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const TOKEN = "crashed-tab-test-token";
/** Long, so a call that waited out the deadline is told apart from one that answered. */
const NAVIGATION_TIMEOUT_MS = 20_000;
/** Far above what an answer about a dead tab takes, far below the deadline it must not wait out. */
const ANSWER_BOUND_MS = 5_000;
/** The same for opening a page, which is a new tab and a document on a machine that may be busy. */
const OPEN_BOUND_MS = 10_000;

type Running = {
  url: string;
  profiles: ReturnType<typeof createProfiles>;
  sessions: ReturnType<typeof createSessions>;
  stop: () => Promise<void>;
};

let fixture: ReturnType<typeof serveFixture> | null = null;
let computer: Running | null = null;
let unfinished: ReturnType<typeof serveUnfinished> | null = null;

/**
 * A page that starts arriving and never finishes.
 *
 * Its first bytes commit the navigation, so the tab has a document and a renderer to lose, and the
 * rest never comes, so `/navigate` is still waiting for it — the moment a heavy page dies in. Not
 * the fixture's `/hang`: a tab still waiting for a first byte answers nothing asked of its document
 * (page-arrival.ts), and finding its renderer is asked of its document (`crash`).
 */
function serveUnfinished() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>오는 중</title></head><body><p>아직 다 오지 않은 페이지</p>${" ".repeat(4096)}`,
              ),
            );
          },
        }),
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => server.stop(true),
  };
}

async function startComputer(): Promise<Running> {
  const base = await mkdtemp(join(tmpdir(), "laf-crashed-tab-"));
  const config = readConfig({
    COMPUTER_TOKEN: TOKEN,
    NAVIGATION_TIMEOUT_MS: String(NAVIGATION_TIMEOUT_MS),
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
    // No sweep: nothing here waits ten minutes, and a timer must not close a tab under a test.
    idleCloseMs: 0,
    onPage: (botId, page) =>
      watchPage(sessions.sessionFor(botId), botId, page, workspace),
    onTabLost: (botId, lost) =>
      tabLost(sessions.sessionFor(botId), botId, lost),
    // The guard itself, on every request the browser makes. Whose hop it stopped is `index.ts`'s
    // to work out, and nothing here is refused or held.
    onContext: async (context) => {
      await guardNavigations(context, {
        allowPrivateHosts: config.allowPrivateHosts,
        ownAddresses: config.ownAddresses,
        behindProxy: false,
        onRefused: () => undefined,
        holds: () => false,
      });
    },
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
): Promise<Answer> {
  const response = await fetch(`${computer?.url}${path}`, {
    method,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": bot,
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

const timed = async <T>(
  work: Promise<T>,
): Promise<{ result: T; ms: number }> => {
  const started = Date.now();
  const result = await work;
  return { result, ms: Date.now() - started };
};

const until = async (holds: () => boolean, ms = ANSWER_BOUND_MS) => {
  const deadline = Date.now() + ms;
  while (!holds() && Date.now() < deadline) await Bun.sleep(20);
  return holds();
};

/** The tab this Bot's next call would be handed. */
const tabOf = (bot: string): Promise<Page> => {
  if (!computer) throw new Error("no computer");
  return computer.profiles.page(bot);
};

/** How long a tab is made to spin, to be found by. */
const SPIN_MS = 400;

/**
 * Which process a tab's renderer is.
 *
 * The browser lists its renderers and the CPU time each has used (`SystemInfo.getProcessInfo`),
 * and not whose tab each is. So the tab is made to spin, and the renderer that spent the time is
 * its own — measured with three tabs open: 0.503 s, against 0.001 s and 0.000 s for the other two.
 * One renderer that spun and none beside it, or it is said rather than guessed at.
 */
async function rendererOf(page: Page): Promise<number> {
  const browser = page.context().browser();
  if (!browser) throw new Error("no browser");
  const session = await browser.newBrowserCDPSession();
  try {
    const spentBy = async () => {
      const { processInfo } = await session.send("SystemInfo.getProcessInfo");
      return new Map(
        processInfo
          .filter((entry) => entry.type === "renderer")
          .map((entry) => [entry.id, entry.cpuTime] as const),
      );
    };
    const before = await spentBy();
    await page.evaluate((ms) => {
      const end = performance.now() + ms;
      while (performance.now() < end);
    }, SPIN_MS);
    const [first, second] = [...(await spentBy())]
      .map(([pid, cpu]) => ({ pid, spent: cpu - (before.get(pid) ?? 0) }))
      .sort((one, other) => other.spent - one.spent);
    if (
      !first ||
      first.spent < SPIN_MS / 4_000 ||
      (second && second.spent > first.spent / 2)
    ) {
      throw new Error(
        `no one renderer spun: ${JSON.stringify([first, second])}`,
      );
    }
    return first.pid;
  } finally {
    void session.detach().catch(() => undefined);
  }
}

/**
 * End a tab's renderer the way running out of memory ends one on the machine this runs on: the
 * system ends the process, and nothing in the page had a say.
 *
 * BY SIGNAL, NOT THROUGH DEVTOOLS. DevTools has a command for it (`Page.crash`), and on a laptop
 * it left a tab in exactly the state a killed renderer does. On the Linux runner it ended nothing
 * in the five seconds each of eight tests gave it (run 37226711757, 2026-10-05), while a renderer
 * killed in that same run was heard at once; and it refuses a tab with a navigation pending
 * outright (`Page has pending navigations, not killing`). The signal is what the kernel sends, and
 * the browser calls it a crash on both.
 */
async function crash(page: Page): Promise<void> {
  let heard = false;
  page.once("crash", () => {
    heard = true;
  });
  process.kill(await rendererOf(page), "SIGKILL");
  if (!(await until(() => heard))) throw new Error("the tab did not crash");
}

type Element = { ref: string; name: string };
type Tab = { url: string; active: boolean };

const tabsOf = (answer: Answer): Tab[] => (answer.body.tabs as Tab[]) ?? [];

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  fixture = serveFixture();
  unfinished = serveUnfinished();
  computer = await startComputer();
});

// Closing a browser waits for it to be gone (`closeAndWait`), which is seconds, not the hook's five.
afterAll(async () => {
  await computer?.stop();
  await unfinished?.stop();
  fixture?.stop();
}, 30_000);

describe("a navigation that failed", () => {
  test("is the renderer's death when the browser said so or Playwright names it, and the site's otherwise", () => {
    // The two names Playwright gives a crash: the page's, and a frame's.
    for (const said of [
      "page.goto: Page crashed",
      "frame.goto: Target crashed",
    ]) {
      expect({ said, died: diedUnder(false, new Error(said)) }).toEqual({
        said,
        died: true,
      });
    }
    // What a site that would not answer is called, and a page that was closed under the call.
    for (const said of [
      "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/",
      "page.goto: net::ERR_NAME_NOT_RESOLVED at https://crashed.example/",
      "page.goto: Target page, context or browser has been closed",
    ]) {
      expect({ said, died: diedUnder(false, new Error(said)) }).toEqual({
        said,
        died: false,
      });
    }
    // The browser's own event is enough, whatever the failure was called.
    expect(diedUnder(true, new Error("page.goto: anything"))).toBe(true);
    expect(diedUnder(false, "Page crashed")).toBe(false);
    // And under an action on an element, where it is one level down: the element did not refuse.
    const underAClick = new Error("laf:element_not_actionable", {
      cause: new Error("locator.click: Target crashed"),
    });
    expect(saysRendererDied(underAClick)).toBe(true);
    expect(
      saysRendererDied(
        new Error("laf:element_not_actionable", {
          cause: new Error("locator.click: Timeout 10000ms exceeded."),
        }),
      ),
    ).toBe(false);
  });
});

/**
 * The bookkeeping on its own, with tabs that are nothing but what it asks of one: an address,
 * whether it is closed, and the two events. No browser, so a minute can pass in a line.
 */
describe("a Bot's tabs, kept without a browser", () => {
  type FakeTab = Page & EventEmitter;

  function tab(address: string): FakeTab {
    const made = new EventEmitter();
    let closed = false;
    return Object.assign(made, {
      url: () => address,
      isClosed: () => closed,
      close: async () => {
        closed = true;
        made.emit("close");
      },
    }) as unknown as FakeTab;
  }

  function keeping() {
    const open: FakeTab[] = [];
    const lost: [string, TabLost][] = [];
    const clock = { now: 0 };
    const tabs = createTabs({
      pages: () => open,
      now: () => clock.now,
      onPage: () => undefined,
      onLost: (botId, how) => lost.push([botId, how]),
    });
    /** A tab this Bot is handed and is on, as `profiles.page` hands one. */
    const on = (botId: string, address: string): FakeTab => {
      const made = tab(address);
      open.push(made);
      tabs.own(botId, made);
      tabs.touch(botId, made);
      return made;
    };
    return { tabs, open, lost, clock, on };
  }

  let warned: ReturnType<typeof spyOn<Console, "warn">> | undefined;

  afterEach(() => {
    warned?.mockRestore();
    warned = undefined;
  });

  const crashLines = () =>
    (warned?.mock.calls ?? [])
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((line) => line.event === "tab_crashed");

  test("the line a dead renderer leaves is one a minute for a Bot, and the ones not written are counted on the next", () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const { clock, lost, on } = keeping();

    // A machine too short of memory to keep a renderer: every tab the Bot is handed dies.
    for (let died = 0; died < 4; died += 1) {
      on("loop-bot", "https://shop.example/cart?item=77").emit("crash");
      clock.now += 1_000;
    }
    expect(crashLines()).toEqual([
      expect.objectContaining({
        bot: "loop-bot",
        origin: "https://shop.example",
        tabs: 1,
      }),
    ]);
    expect(crashLines()[0]).not.toHaveProperty("unsaid");
    // Another Bot's is its own line: the bound is on a Bot's lines, not on the log.
    on("other-bot", "https://bank.example/").emit("crash");
    expect(crashLines().map((line) => line.bot)).toEqual([
      "loop-bot",
      "other-bot",
    ]);

    clock.now += 60_000;
    on("loop-bot", "https://shop.example/cart?item=77").emit("crash");
    expect(crashLines().at(-1)).toMatchObject({ bot: "loop-bot", unsaid: 3 });
    expect(crashLines()).toHaveLength(3);
    // The line is bounded; what the Bot is told is not. Every one of them was the tab it was on.
    expect(lost.filter(([botId]) => botId === "loop-bot")).toHaveLength(5);
    expect(JSON.stringify(warned.mock.calls)).not.toMatch(/cart|item|77/);
  });

  test("a Bot is told its tab is gone only when it was the tab the Bot was on, and never for a tab this process closed", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const { tabs, lost, open, on } = keeping();
    const front = on("bot", "https://shop.example/orders?q=1");
    // A second tab of its own that it is not on: `own` without `touch`.
    const back = tab("https://shop.example/help");
    open.push(back);
    tabs.own("bot", back);

    back.emit("crash");
    expect(lost).toEqual([]);
    expect(tabs.pagesOf("bot")).toEqual([front]);

    // Closed by its site, while it was the Bot's and the Bot was on it.
    await front.close();
    expect(lost).toEqual([
      ["bot", { cause: "closed", origin: "https://shop.example" }],
    ]);

    // Closed by this process — a stop — which lets go of it first: nobody is told anything.
    const again = on("bot", "https://shop.example/");
    await tabs.closeTabsOf("bot");
    expect(again.isClosed()).toBe(true);
    expect(lost).toHaveLength(1);
  });

  test("a death is counted once, whichever way it is learned first", () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const { tabs, lost, on } = keeping();
    const dead = on("bot", "https://shop.example/");
    // The call that failed on it, then the event, late; and the other way round.
    tabs.died(dead);
    dead.emit("crash");
    tabs.died(dead);
    expect(lost).toHaveLength(1);
    expect(crashLines()).toHaveLength(1);
    expect(tabs.hasCrashed(dead)).toBe(true);
    expect(tabs.pagesOf("bot")).toEqual([]);
  });

  test("a tab that died before the browser said whose it was is adopted by nobody", async () => {
    warned = spyOn(console, "warn").mockImplementation(() => undefined);
    const { tabs, open, lost, on } = keeping();
    const opener = on("bot", "https://shop.example/");
    const popup = Object.assign(tab("https://pay.example/window"), {
      opener: async () => opener,
    }) as unknown as FakeTab;
    open.push(popup);

    tabs.adoptOpened(popup);
    // Dead before `opener()` has answered.
    popup.emit("crash");
    await Bun.sleep(0);

    expect(tabs.owners.has(popup)).toBe(false);
    expect(tabs.live.get("bot")?.page).toBe(opener);
    // The Bot never left the tab it clicked in, so it has lost nothing.
    expect(lost).toEqual([]);
    expect(crashLines()).toEqual([
      expect.objectContaining({ origin: "https://pay.example", tabs: 0 }),
    ]);
    expect(crashLines()[0]).not.toHaveProperty("bot");
  });
});

describe.skipIf(!HAS_BROWSER)("a tab whose renderer crashed", () => {
  test("is replaced, and the next address opens", async () => {
    const bot = "crash-next-bot";
    expect((await post("/navigate", bot, { url: fixture?.url })).status).toBe(
      200,
    );
    const dead = await tabOf(bot);
    await crash(dead);

    // THE FACT THAT WAS BROKEN: the same Bot, the next page. It answered `laf:navigation_failed`
    // in a millisecond, and went on answering it for as long as the Bot kept asking.
    for (let again = 0; again < 2; again += 1) {
      const next = await timed(
        post("/navigate", bot, { url: `${fixture?.url}other` }),
      );
      console.info(
        `after a crash, /navigate answered ${next.result.status} in ${next.ms}ms`,
      );
      expect([next.result.status, next.result.body.code]).toEqual([
        200,
        undefined,
      ]);
      expect(String(next.result.body.text)).toContain("주문 상세 화면");
      expect(next.ms).toBeLessThan(OPEN_BOUND_MS);
    }
    // One tab, and not the dead one: it is replaced, not kept beside its replacement.
    expect(await tabOf(bot)).not.toBe(dead);
    expect(tabsOf(await post("/snapshot", bot))).toHaveLength(1);
  }, 60_000);

  test("every look and a click right after it answer in time, about the tab that took its place", async () => {
    const bot = "crash-looks-bot";
    await post("/navigate", bot, { url: fixture?.url });
    const shot = await post("/snapshot", bot);
    const button = (shot.body.elements as Element[]).find(
      (element) => element.name === "알림",
    );
    if (!button) throw new Error("the fixture has no 알림 button");
    await crash(await tabOf(bot));

    // The ref names a control on a page that no longer exists: look again, said in time.
    const click = await timed(
      post("/click", bot, {
        ref: button.ref,
        snapshotId: shot.body.snapshotId,
      }),
    );
    console.info(
      `after a crash, /click answered ${click.result.status} ${click.result.body.code} in ${click.ms}ms`,
    );
    expect([click.result.status, click.result.body.code]).toEqual([
      409,
      "laf:stale_refs",
    ]);
    expect(click.ms).toBeLessThan(ANSWER_BOUND_MS);

    for (const [method, path, payload] of [
      ["POST", "/snapshot", {}],
      ["GET", "/read", undefined],
      ["POST", "/tabs/switch", { index: 0 }],
      ["POST", "/describe-point", { x: 20, y: 20 }],
      ["GET", "/screenshot", undefined],
    ] as const) {
      const look = await timed(call(method, path, bot, payload));
      console.info(
        `after a crash, ${path} answered ${look.result.status} in ${look.ms}ms`,
      );
      expect({ path, status: look.result.status }).toEqual({
        path,
        status: 200,
      });
      expect({ path, fast: look.ms < ANSWER_BOUND_MS }).toEqual({
        path,
        fast: true,
      });
      // An empty tab, said as one: the page it was on went with its renderer, and nothing of it is
      // answered as though it were still there.
      if (path !== "/describe-point") {
        expect({ path, url: look.result.body.url }).toEqual({
          path,
          url: "about:blank",
        });
      }
      if (path === "/snapshot") {
        expect(look.result.body.elements).toEqual([]);
        expect(tabsOf(look.result)).toEqual([
          { index: 0, title: "", url: "about:blank", active: true } as Tab,
        ]);
      }
      if (path === "/read") expect(look.result.body.text).toBe("");
    }
  }, 60_000);

  test("while /navigate is still opening a page is the browser's failure, not the site's, and the next address opens", async () => {
    const bot = "crash-opening-bot";
    await post("/navigate", bot, { url: fixture?.url });
    const tab = await tabOf(bot);
    // Not awaited: the navigation the renderer dies in the middle of.
    const opening = post("/navigate", bot, { url: unfinished?.url });
    // Its failure is this test's to read below, and nobody's to trip over if the crash throws first.
    opening.catch(() => undefined);
    expect(await until(() => tab.url() === unfinished?.url)).toBe(true);
    await crash(tab);

    // From the crash: the call was already waiting, and is answered when its renderer goes.
    const answered = await timed(opening);
    console.info(
      `a crash during /navigate answered ${answered.result.status} ${answered.result.body.code} ${answered.ms}ms after it`,
    );
    // "Try once more", which is true of a browser and not of a site that would not connect.
    expect([answered.result.status, answered.result.body.code]).toEqual([
      502,
      "laf:browser_failed",
    ]);
    // At the crash, not at the deadline the page would otherwise have been given.
    expect(answered.ms).toBeLessThan(ANSWER_BOUND_MS);
    // And none of Playwright's words for it leave with the answer.
    expect(answered.result.text).not.toMatch(/crash|goto/i);

    const next = await post("/navigate", bot, { url: fixture?.url });
    expect(next.status).toBe(200);
    expect(String(next.body.text)).toContain(VISIBLE_TEXT);
  }, 60_000);

  describe("in the log", () => {
    let warned: ReturnType<typeof spyOn<Console, "warn">> | undefined;

    afterEach(() => {
      warned?.mockRestore();
      warned = undefined;
    });

    test("is one line, with the Bot, the site's origin and how many tabs it had — and nothing else of the page", async () => {
      const bot = "crash-log-bot";
      const origin = new URL(fixture?.url ?? "").origin;
      // An address with a path and a query, on a page with a title: all three are the page's.
      const opened = await post("/navigate", bot, {
        url: `${fixture?.url}other?orderno=20261005-7788`,
      });
      expect(opened.body.title).toBe("주문 상세");
      warned = spyOn(console, "warn").mockImplementation(() => undefined);
      await crash(await tabOf(bot));
      await post("/navigate", bot, { url: fixture?.url });
      await post("/snapshot", bot);

      const lines = warned.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("tab_crashed"));
      expect(lines).toHaveLength(1);
      const line = lines[0] ?? "";
      expect(JSON.parse(line)).toMatchObject({
        level: "warn",
        svc: "agent-computer",
        event: "tab_crashed",
        bot,
        origin,
        tabs: 1,
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

  test("leaves another Bot's tab as it was, and hands its own Bot a tab of its own", async () => {
    const [crashedBot, otherBot] = ["crash-mine-bot", "crash-theirs-bot"];
    await post("/navigate", crashedBot, { url: fixture?.url });
    await post("/navigate", otherBot, { url: `${fixture?.url}other` });
    const theirs = await tabOf(otherBot);
    const dead = await tabOf(crashedBot);
    expect(theirs).not.toBe(dead);

    await crash(dead);
    const next = await post("/navigate", crashedBot, { url: fixture?.url });
    expect(next.status).toBe(200);

    // The other Bot is on the tab it was on, showing the page it was showing.
    expect(await tabOf(otherBot)).toBe(theirs);
    const read = await call("GET", "/read", otherBot);
    expect(read.status).toBe(200);
    expect(String(read.body.text)).toContain("주문 상세 화면");
    const theirTabs = tabsOf(await post("/snapshot", otherBot));
    expect(theirTabs).toHaveLength(1);
    expect(theirTabs[0]?.url).toBe(`${fixture?.url}other`);
    // And the replacement is the crashed Bot's own: not the other's tab, and not in its list.
    const replacement = await tabOf(crashedBot);
    expect(replacement).not.toBe(theirs);
    expect(replacement).not.toBe(dead);
    const mine = tabsOf(await post("/snapshot", crashedBot));
    expect(mine.map((tab) => tab.url)).toEqual([fixture?.url ?? ""]);
  }, 60_000);

  test("that a site opened is dropped the same way, and the Bot is back on the tab it came from", async () => {
    const bot = "crash-popup-bot";
    await post("/navigate", bot, { url: fixture?.url });
    const first = await tabOf(bot);
    const shot = await post("/snapshot", bot);
    const link = (shot.body.elements as Element[]).find(
      (element) => element.name === "주문 상세 보기",
    );
    if (!link) throw new Error("the fixture has no new-tab link");
    const clicked = await post("/click", bot, {
      ref: link.ref,
      snapshotId: shot.body.snapshotId,
      element: { role: "link", name: link.name },
    });
    expect(clicked.status).toBe(200);
    // The tab the click opened is the Bot's, and the one it is on.
    const popup = await tabOf(bot);
    expect(popup).not.toBe(first);
    const onPopup = await post("/snapshot", bot);
    expect(tabsOf(onPopup)).toHaveLength(2);

    await crash(popup);

    // A ref from the dead tab's look is retired with it. The tab the Bot is back on is not a new
    // one, and it has a control of its own under this very ref — the link, which would open again.
    const stale = await post("/click", bot, {
      ref: link.ref,
      snapshotId: onPopup.body.snapshotId,
    });
    expect([stale.status, stale.body.code]).toEqual([409, "laf:stale_refs"]);

    const after = await timed(post("/snapshot", bot));
    expect(after.result.status).toBe(200);
    expect(after.ms).toBeLessThan(ANSWER_BOUND_MS);
    expect(tabsOf(after.result)).toEqual([
      expect.objectContaining({ url: fixture?.url, active: true }),
    ]);
    expect(await tabOf(bot)).toBe(first);
    const read = await call("GET", "/read", bot);
    expect(String(read.body.text)).toContain(VISIBLE_TEXT);
  }, 60_000);

  test("that will not close holds no call up, and is handed to nobody", async () => {
    const bot = "crash-unclosed-bot";
    await post("/navigate", bot, { url: fixture?.url });
    const dead = await tabOf(bot);
    // A close that never comes back: what a wedged browser does with the tab it is asked to drop.
    const close = dead.close.bind(dead);
    dead.close = () => new Promise<void>(() => undefined);
    try {
      await crash(dead);
      const next = await timed(post("/navigate", bot, { url: fixture?.url }));
      expect(next.result.status).toBe(200);
      expect(next.ms).toBeLessThan(OPEN_BOUND_MS);
      // What made a crashed tab invisible: the browser calls it neither closed nor gone. Open, and
      // owned by nobody — which is exactly what a Bot with no tab yet is given (`profiles.page`,
      // the spare). Not this one.
      expect(dead.isClosed()).toBe(false);
      expect(await tabOf(bot)).not.toBe(dead);
      expect(await tabOf("crash-newcomer-bot")).not.toBe(dead);
      const opened = await post("/navigate", "crash-newcomer-bot", {
        url: fixture?.url,
      });
      expect(opened.status).toBe(200);
    } finally {
      dead.close = close;
      await dead.close().catch(() => undefined);
    }
  }, 60_000);

  test("under a person's live screen moves the picture to the tab that took its place, and says no error", async () => {
    const bot = "crash-screen-bot";
    await post("/navigate", bot, { url: fixture?.url });
    const dead = await tabOf(bot);
    const session = computer?.sessions.sessionFor(bot);

    const socket = new WebSocket(
      `${computer?.url.replace(/^http/, "ws")}/stream?bot=${bot}&token=${TOKEN}`,
    );
    socket.binaryType = "arraybuffer";
    /** The site each picture is of, and everything said that was not a picture. */
    const sites: (string | null)[] = [];
    const said: string[] = [];
    let closed = false;
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        said.push(event.data);
        return;
      }
      const frame = decodeScreenFrame(event.data as ArrayBuffer);
      if (frame) sites.push(frame.header.site);
    });
    socket.addEventListener("close", () => {
      closed = true;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("no socket")));
      });
      expect(await until(() => sites.length > 0)).toBe(true);
      expect(session?.viewer?.page).toBe(dead);

      await crash(dead);

      // The cast follows the Bot's tab once a second (`live-screen.ts`), and the Bot's tab is a new one.
      expect(
        await until(
          () => session?.viewer !== undefined && session.viewer.page !== dead,
        ),
      ).toBe(true);
      expect(session?.viewer?.page).toBe(await tabOf(bot));
      // An empty tab's picture names no site, which is how the surface knows there is no page.
      expect(await until(() => sites.at(-1) === null)).toBe(true);
      expect(said).toEqual([]);
      expect(closed).toBe(false);
    } finally {
      socket.close();
    }
  }, 60_000);

  /*
   * WHAT THE BOT MAY DO ON THE TAB IT WAS PUT ON: NOTHING, UNTIL IT HAS LOOKED.
   *
   * When a tab a site opened dies, the Bot's next call lands on the tab it came from — which is
   * the right thing for a look and was, on the first version of this fix, the wrong thing for
   * everything else. A key and a scroll name no element, and the masked box's door checks no
   * snapshot: both went straight to the page behind. Each test below opens a popup from a page,
   * ends the popup, and holds the page behind it to having been touched by nothing.
   */
  describe("that the Bot was on, with another tab of its own behind it", () => {
    /** A page, and the tab one of its links opened: where the Bot is, and where it would land. */
    async function onAPopup(bot: string, page: string, link: string) {
      await post("/navigate", bot, { url: `${fixture?.url}${page}` });
      const behind = await tabOf(bot);
      const first = await post("/snapshot", bot);
      const found = (first.body.elements as Element[]).find(
        (element) => element.name === link,
      );
      if (!found) throw new Error(`the fixture has no ${link} link`);
      const clicked = await post("/click", bot, {
        ref: found.ref,
        snapshotId: first.body.snapshotId,
        element: { role: "link", name: found.name },
      });
      expect(clicked.status).toBe(200);
      const popup = await tabOf(bot);
      expect(popup).not.toBe(behind);
      return { behind, popup, first, onPopup: await post("/snapshot", bot) };
    }

    /** The box on `/to-hang`, by the ref a look gave it. */
    const boxOn = (look: Answer): Element => {
      const box = (look.body.elements as Element[]).find(
        (element) => element.name === TO_HANG_PIN,
      );
      if (!box) throw new Error("the /to-hang fixture has no box");
      return box;
    };

    /** What every box on a page holds, asked of the page itself. */
    const boxesOf = (page: Page): Promise<string[]> =>
      page.evaluate(() =>
        [...document.querySelectorAll("input")].map((input) => input.value),
      );

    /** Everything this process writes to its log while `work` runs, one string a line. */
    async function logged(work: () => Promise<void>): Promise<string[]> {
      const lines: string[] = [];
      const spies = (["log", "warn", "error"] as const).map((level) =>
        spyOn(console, level).mockImplementation((...said: unknown[]) => {
          lines.push(said.map(String).join(" "));
        }),
      );
      try {
        await work();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      return lines;
    }

    /*
     * THE ASK ENDS WITH THE TAB — closed by its site, or its renderer dead — AND THE VALUE GOES
     * NOWHERE. The Bot asks for a value into a box on the popup; the popup goes; the person, whose
     * card was still up a moment ago, types. The page behind has a box of its own under the very
     * same ref — each tab's refs are its own last look's — and that is where the value went
     * (measured 2026-10-05 on `870673b9` for a dead renderer, and on main for a tab its site
     * closed: 200 `supplied: true`, the value in the wrong page, the popup's site in the trail).
     */
    for (const [cause, lose] of [
      ["crashed", (popup: Page) => crash(popup)],
      [
        "closed",
        async (popup: Page) => {
          // As a sign-in window that has done its work closes itself.
          await popup.evaluate(() => window.close()).catch(() => undefined);
          if (!(await until(() => popup.isClosed()))) {
            throw new Error("the popup did not close itself");
          }
        },
      ],
    ] as const) {
      test(`${cause === "crashed" ? "whose renderer died" : "that its site closed"} under an ask for a value ends the ask as nobody's answer, and what the person types reaches no page, no answer and no log line`, async () => {
        const bot = `lost-${cause}-secret-bot`;
        const SECRET = `PERSON-TYPED-AFTER-TAB-${cause.toUpperCase()}-5521`;
        const answers: string[] = [];
        let behind: Page | undefined;
        const lines = await logged(async () => {
          const there = await onAPopup(bot, "to-hang", "이 화면 새 탭");
          behind = there.behind;
          const box = boxOn(there.onPopup);
          // The trap: the page behind knows its own box by this very ref.
          expect(box.ref).toBe(boxOn(there.first).ref);
          const asked = await post("/control/secret", bot, {
            label: "간편 확인 값",
            ref: box.ref,
            snapshotId: there.onPopup.body.snapshotId,
          });
          expect(asked.body.secretWanted).toBe("간편 확인 값");

          await lose(there.popup);

          // The ask is over, and says nobody answered it: a wait reads that, not "it was typed".
          const state = await call("GET", "/control", bot);
          answers.push(state.text);
          expect(state.body.secretWanted).toBeUndefined();
          expect(state.body.unanswered).toBe(true);

          const typed = await post("/human/secret", bot, { text: SECRET });
          answers.push(typed.text);
          expect([typed.status, typed.body.code]).toEqual([
            409,
            "laf:secret_not_pending",
          ]);
          // And the Bot may not ask again for a box it has not looked at.
          const again = await post("/control/secret", bot, {
            label: "간편 확인 값",
            ref: box.ref,
            snapshotId: there.onPopup.body.snapshotId,
          });
          answers.push(again.text);
          expect([again.status, again.body.code]).toEqual([
            409,
            "laf:stale_refs",
          ]);
          const look = await post("/snapshot", bot);
          answers.push(look.text);
          expect(look.body.notes).toEqual([
            {
              code: "laf:tab_replaced",
              cause,
              origin: new URL(fixture?.url ?? "").origin,
            },
          ]);
        });

        // THE PAGE BEHIND: its one box holds what it held, which is nothing.
        if (!behind) throw new Error("no page behind the popup");
        expect(await boxesOf(behind)).toEqual([""]);
        // The value, looked for the way a secret is: in the whole of every answer and every line.
        for (const written of [...answers, ...lines]) {
          expect(written.includes(SECRET)).toBe(false);
        }
        expect(lines.some((line) => line.includes("ask_ended_tab_lost"))).toBe(
          true,
        );
      }, 60_000);
    }

    test("whose renderer died takes no key, scroll, tab switch or file until the Bot has looked", async () => {
      const bot = "lost-unseen-bot";
      const there = await onAPopup(bot, "", "주문 상세 보기");
      const written = await post("/files/write", bot, {
        path: "장부.csv",
        contents: "날짜,금액\n",
      });
      expect(written.status).toBe(200);
      const button = (there.first.body.elements as Element[]).find(
        (element) => element.name === "알림",
      );
      if (!button) throw new Error("the fixture has no 알림 button");

      await crash(there.popup);

      // Enter was judged for the popup's site, and would be pressed on the page behind it.
      for (const [path, payload] of [
        ["/key", { key: "Enter" }],
        ["/scroll", { deltaY: 400 }],
        ["/tabs/switch", { index: 1 }],
        ["/type", { ref: button.ref, text: "x" }],
        [
          "/upload",
          {
            ref: button.ref,
            path: "장부.csv",
            snapshotId: there.onPopup.body.snapshotId,
          },
        ],
        // Twice: a refusal is not a look, and does not let the next one through.
        ["/key", { key: "Enter" }],
      ] as const) {
        const refused = await timed(post(path, bot, payload));
        expect({
          path,
          status: refused.result.status,
          code: refused.result.body.code,
        }).toEqual({ path, status: 409, code: "laf:stale_refs" });
        expect(refused.ms).toBeLessThan(ANSWER_BOUND_MS);
      }
      // A person's own picture of the tab is not the Bot looking: the pane asks for one every two
      // seconds, and would have let the Bot act again within two.
      expect((await call("GET", "/screenshot", bot)).status).toBe(200);
      expect((await post("/key", bot, { key: "Enter" })).body.code).toBe(
        "laf:stale_refs",
      );
      // The page behind was sent nothing: no alert went up, and it says what it said.
      expect(
        await there.behind.evaluate(
          () => document.getElementById("said")?.textContent,
        ),
      ).toBe("아직 아무 일도 없었습니다");
    }, 60_000);

    test("whose renderer died is said on the Bot's first look, once, and from that look on the Bot acts again", async () => {
      const bot = "lost-look-bot";
      const there = await onAPopup(bot, "", "주문 상세 보기");
      await crash(there.popup);
      expect((await post("/scroll", bot, { deltaY: 200 })).status).toBe(409);

      const look = await call("GET", "/read", bot);
      expect(look.status).toBe(200);
      // Where the Bot is, and why it is not where it was: the fact, the cause and the site only.
      expect(look.body.url).toBe(fixture?.url);
      expect(String(look.body.text)).toContain(VISIBLE_TEXT);
      expect(look.body.notes).toEqual([
        {
          code: "laf:tab_replaced",
          cause: "crashed",
          origin: new URL(fixture?.url ?? "").origin,
        },
      ]);
      // Once: the next look has nothing to add.
      expect((await call("GET", "/read", bot)).body.notes).toBeUndefined();
      expect((await post("/snapshot", bot)).body.notes).toBeUndefined();

      for (const [path, payload] of [
        ["/scroll", { deltaY: 200 }],
        ["/key", { key: "Escape" }],
      ] as const) {
        const acted = await post(path, bot, payload);
        expect({ path, status: acted.status }).toEqual({ path, status: 200 });
      }
      expect(await tabOf(bot)).toBe(there.behind);
    }, 60_000);
  });

  /*
   * A DEATH THE `crash` EVENT DID NOT BRING. The event is heard on a tab from the moment the tab
   * exists, and the first version listened only from the moment a Bot owned it: a tab that died
   * in between was adopted dead or handed out as the spare, and the incident was back for that
   * Bot. And an event can be missed outright, so the call that fails on a dead tab is the second
   * way of knowing.
   */
  test("that died before any Bot owned it is handed to nobody", async () => {
    const holder = "stray-holder-bot";
    await post("/navigate", holder, { url: fixture?.url });
    // A tab no Bot's click opened, as the tab a browser starts with is nobody's until one is
    // taken: exactly what the next Bot with no tab is handed.
    const stray = await (await tabOf(holder)).context().newPage();
    await stray.goto(`${fixture?.url}other`);
    await crash(stray);

    const newcomer = "stray-newcomer-bot";
    const opened = await post("/navigate", newcomer, { url: fixture?.url });
    expect([opened.status, opened.body.code]).toEqual([200, undefined]);
    expect(await tabOf(newcomer)).not.toBe(stray);
    // And it is not left lying open for the one after either.
    expect(await until(() => stray.isClosed())).toBe(true);
  }, 60_000);

  describe("that nothing heard die", () => {
    let warned: ReturnType<typeof spyOn<Console, "warn">> | undefined;

    afterEach(() => {
      warned?.mockRestore();
      warned = undefined;
    });

    test("is learned from the call that fails on it, let go of once, and the next address opens", async () => {
      const bot = "unheard-bot";
      await post("/navigate", bot, { url: fixture?.url });
      const dead = await tabOf(bot);
      // The event, missed: nothing of this process is listening when the renderer goes.
      dead.removeAllListeners("crash");
      warned = spyOn(console, "warn").mockImplementation(() => undefined);
      await crash(dead);
      // Still the Bot's tab, and dead: every call on it failed for ever, before.
      expect(await tabOf(bot)).toBe(dead);

      const failed = await post("/navigate", bot, { url: fixture?.url });
      expect([failed.status, failed.body.code]).toEqual([
        502,
        "laf:browser_failed",
      ]);
      const next = await post("/navigate", bot, { url: fixture?.url });
      expect(next.status).toBe(200);
      expect(String(next.body.text)).toContain(VISIBLE_TEXT);
      expect(next.body.notes).toMatchObject([
        { code: "laf:tab_replaced", cause: "crashed" },
      ]);
      expect(await tabOf(bot)).not.toBe(dead);
      await post("/snapshot", bot);

      const lines = warned.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("tab_crashed") && line.includes(bot));
      expect(lines).toHaveLength(1);
    }, 60_000);
  });

  /*
   * A MACHINE SHORT OF MEMORY DOES NOT STOP AT ONE. Every renderer the browser has, ended in the
   * same moment — every Bot's tab in this file with them, which is why this is last. Each Bot is
   * then handed a tab of its own, and none of them another's.
   */
  test("along with every other tab in the browser leaves each Bot a tab of its own", async () => {
    const bots = ["crash-all-first-bot", "crash-all-second-bot"];
    const dead: Page[] = [];
    let heard = 0;
    for (const bot of bots) {
      await post("/navigate", bot, { url: fixture?.url });
      const tab = await tabOf(bot);
      tab.once("crash", () => {
        heard += 1;
      });
      dead.push(tab);
    }
    const browser = dead[0]?.context().browser();
    if (!browser) throw new Error("no browser");
    const session = await browser.newBrowserCDPSession();
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    void session.detach().catch(() => undefined);
    const renderers = processInfo.filter((entry) => entry.type === "renderer");
    expect(renderers.length).toBeGreaterThanOrEqual(bots.length);
    for (const renderer of renderers) {
      try {
        process.kill(renderer.id, "SIGKILL");
      } catch {
        // Gone already: a renderer with no tab left is ended by the browser itself.
      }
    }
    expect(await until(() => heard === bots.length)).toBe(true);

    const replaced: Page[] = [];
    for (const bot of bots) {
      const next = await timed(post("/navigate", bot, { url: fixture?.url }));
      console.info(
        `after every renderer was killed, /navigate answered ${next.result.status} in ${next.ms}ms`,
      );
      expect(next.result.status).toBe(200);
      expect(String(next.result.body.text)).toContain(VISIBLE_TEXT);
      replaced.push(await tabOf(bot));
    }
    expect(new Set([...dead, ...replaced]).size).toBe(4);
    for (const bot of bots) {
      expect(tabsOf(await post("/snapshot", bot))).toHaveLength(1);
    }
  }, 60_000);
});
