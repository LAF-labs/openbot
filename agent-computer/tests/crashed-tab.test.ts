import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
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
import { computerFetch } from "../src/routes";
import { createSessions } from "../src/sessions";
import { createWorkspace } from "../src/workspace";
import { serveFixture, VISIBLE_TEXT } from "./fixture-site";

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
 * speak HTTP to it; a tab can only be crashed by whoever holds it, so this one builds the computer
 * the way `index.ts` does — the same routes, socket, profiles, sessions and navigation guard — and
 * keeps the `profiles` it was built from, to reach the tab a Bot was handed. Every call below still
 * goes in over HTTP with the token and the Bot's header.
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
 * the fixture's `/hang`: a tab still waiting for a first byte is not handed what DevTools sends it
 * (page-arrival.ts), the crash included.
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

/**
 * End a tab's renderer, as running out of memory on a heavy page does.
 *
 * `Page.crash` is DevTools' own way to do it, and it is never answered — the renderer that would
 * answer is the one it ends — so the send is not waited for and the browser's own `crash` event is.
 */
async function crash(page: Page): Promise<void> {
  let heard = false;
  page.once("crash", () => {
    heard = true;
  });
  const session = await page.context().newCDPSession(page);
  void session.send("Page.crash").catch(() => undefined);
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
    const opening = timed(post("/navigate", bot, { url: unfinished?.url }));
    // Its failure is this test's to read below, and nobody's to trip over if the crash throws first.
    opening.catch(() => undefined);
    expect(await until(() => tab.url() === unfinished?.url)).toBe(true);
    await crash(tab);

    const answered = await opening;
    console.info(
      `a crash during /navigate answered ${answered.result.status} ${answered.result.body.code} in ${answered.ms}ms`,
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
   * WHAT RUNNING OUT OF MEMORY IS, ON THE MACHINE THIS RUNS ON: the kernel ends the renderer's
   * process, and nothing in the page had a say. The tests above end a renderer through DevTools,
   * which is exact about which tab; this one ends it from outside, as the kernel does, and holds
   * the browser to calling that a crash too — the event everything above hangs on.
   *
   * Last, and every renderer at once: the browser says which processes are renderers and not whose
   * tab each is, and by now every other Bot in this file is done with its tab.
   */
  test("by the system ending its process is heard the same way, and the next address opens", async () => {
    const bot = "crash-killed-bot";
    await post("/navigate", bot, { url: fixture?.url });
    const dead = await tabOf(bot);
    let heard = false;
    dead.once("crash", () => {
      heard = true;
    });
    const browser = dead.context().browser();
    if (!browser) throw new Error("no browser");
    const session = await browser.newBrowserCDPSession();
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    void session.detach().catch(() => undefined);
    const renderers = processInfo.filter((entry) => entry.type === "renderer");
    expect(renderers.length).toBeGreaterThan(0);
    for (const renderer of renderers) {
      try {
        process.kill(renderer.id, "SIGKILL");
      } catch {
        // Gone already: a renderer with no tab left is ended by the browser itself.
      }
    }
    expect(await until(() => heard)).toBe(true);

    const next = await timed(post("/navigate", bot, { url: fixture?.url }));
    console.info(
      `after its renderer was killed, /navigate answered ${next.result.status} in ${next.ms}ms`,
    );
    expect(next.result.status).toBe(200);
    expect(String(next.result.body.text)).toContain(VISIBLE_TEXT);
    expect(await tabOf(bot)).not.toBe(dead);
  }, 60_000);
});
