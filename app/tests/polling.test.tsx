import { environmentManager, focusManager } from "@tanstack/react-query";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { OUTAGE_CAP_MS, pollEvery } from "../src/lib/polling";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { BOT_ID, channelServer } from "./support/channel-server";

/**
 * AN OPEN CONVERSATION IS NOT A LOAD TEST, A HIDDEN WINDOW ASKS FOR NOTHING, AND AN OUTAGE IS WAITED
 * OUT RATHER THAN HAMMERED.
 *
 * MEASURED 2026-09-10 (audit A4, finding 4) and again 2026-09-13 in Chromium against a running
 * server, one idle 1:1 conversation on screen for sixty seconds: `control` 20, `working` 15,
 * `components/for-agent` 12, `plugins/for` 4, `sandboxed/published` 2 — 53 requests a minute; with
 * the tab hidden, `control` alone kept asking 20 times a minute; and while the API was down every
 * poll kept its rhythm, so the moment the front door came back the whole queue landed on it. The
 * product is a window left open all day on a shop owner's PC.
 *
 * The real channel route, the real polls, and a clock that runs a hundred times fast: timers and
 * `Date.now` are scaled together, so a minute of the screen's life is six hundred milliseconds of
 * the test's, and every interval, backoff and staleness check inside it keeps its proportions.
 */

const SPEED = 100;

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
/** What TanStack believed before this file told it otherwise, so the files after it are not changed. */
let wasServer = true;

beforeAll(() => {
  wasServer = environmentManager.isServer();
  /*
   * TanStack decided "no window, so a server" when its module was evaluated, which under bun can be
   * before any file registers a DOM — and on a server it schedules no interval at all, so every poll
   * would read once and never again and a test of the rhythm would pass on nothing. The app loads the
   * same module inside a browser; this tells the test's copy where it is.
   */
  environmentManager.setIsServer(() => false);
  /*
   * And which window a return to the screen arrives on. The focus manager binds its listener to
   * `window` when the first query subscribes, and in a full run that may have been an earlier file's
   * window, unregistered since: the visibility change below would reach nobody. Bound again here, to
   * this file's window, the way the manager binds itself.
   */
  focusManager.setEventListener((onFocus) => {
    const listener = () => onFocus();
    window.addEventListener("visibilitychange", listener, false);
    return () => window.removeEventListener("visibilitychange", listener);
  });
});
afterAll(async () => {
  environmentManager.setIsServer(() => wasServer);
  await removeAppDom();
});

/**
 * A clock a hundred times fast, for timers and `Date.now` alike.
 *
 * Timers first, before the screen mounts: a poll schedules its next read the moment its first one
 * lands, and a timer set on the real clock would fire long after the test is over. `Date.now` once
 * the screen is up, because mounting waits on a real deadline.
 */
function fastClock() {
  const real = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    now: Date.now,
  };
  globalThis.setTimeout = ((
    handler: TimerHandler,
    delay = 0,
    ...rest: unknown[]
  ) =>
    real.setTimeout(
      handler,
      Math.max(0, Number(delay)) / SPEED,
      ...rest,
    )) as typeof setTimeout;
  globalThis.setInterval = ((
    handler: TimerHandler,
    delay = 0,
    ...rest: unknown[]
  ) =>
    real.setInterval(
      handler,
      Math.max(1, Number(delay) / SPEED),
      ...rest,
    )) as typeof setInterval;
  return {
    /** From now on `Date.now` runs fast too, continuing from where it is. */
    speedUpDate: () => {
      const startedAt = real.now();
      Date.now = () => startedAt + (real.now() - startedAt) * SPEED;
    },
    /** Let `virtualMs` of the screen's life pass. */
    pass: (virtualMs: number) =>
      new Promise<void>((resolve) => {
        real.setTimeout(resolve, virtualMs / SPEED);
      }),
    restore: () => {
      globalThis.setTimeout = real.setTimeout;
      globalThis.setInterval = real.setInterval;
      Date.now = real.now;
    },
  };
}

const MINUTE = 60_000;

/** The polls the audit counted, by what they ask for. Everything else is a one-off. */
const POLLED = [
  `/api/computers/${BOT_ID}/control`,
  "/api/agents/working",
  `/api/components/for-agent/${BOT_ID}`,
  `/api/plugins/for/${BOT_ID}`,
  "/api/sandboxed/published",
];

function setVisible(visible: boolean) {
  Object.defineProperty(document, "visibilityState", {
    value: visible ? "visible" : "hidden",
    configurable: true,
  });
  Object.defineProperty(document, "hidden", {
    value: !visible,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("visibilitychange"));
}

describe("one idle conversation left open", () => {
  test("asks at most ten times a minute, nothing while hidden, and backs off to a minute in an outage", async () => {
    const channelId = "channel_polling";
    const server = channelServer({ channelId, computer: true });
    let down = false;
    const asked: { path: string; at: number }[] = [];
    const clock = fastClock();
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: (request) => {
        if (POLLED.includes(request.pathname)) {
          asked.push({ path: request.pathname, at: Date.now() });
        }
        // The front door, answering for an API process that is not there.
        if (down) return json({ error: "Bad Gateway" }, 502);
        return server.api(request);
      },
    });
    clock.speedUpDate();
    const between = (from: number, to: number) =>
      asked.filter((request) => request.at >= from && request.at < to);

    try {
      // The screen's first minute: everything it reads on arrival, and the control loop settling.
      await clock.pass(MINUTE);

      const visibleFrom = Date.now();
      await clock.pass(MINUTE);
      const visible = between(visibleFrom, Date.now());
      expect(visible.length).toBeLessThanOrEqual(10);

      setVisible(false);
      const hiddenFrom = Date.now();
      await clock.pass(MINUTE);
      const hidden = between(hiddenFrom, Date.now());
      expect(hidden.length).toBeLessThanOrEqual(2);

      setVisible(true);
      await clock.pass(5_000);

      // THE OUTAGE. Six minutes of a front door answering 502 for everything.
      down = true;
      const outageFrom = Date.now();
      await clock.pass(6 * MINUTE);
      const outageTo = Date.now();
      const lastMinute = between(outageTo - MINUTE, outageTo);
      // By the sixth minute nothing asks more than about once a minute…
      for (const path of POLLED) {
        const times = lastMinute.filter((request) => request.path === path);
        // Named, so a failure says which poll kept hammering.
        expect({ path, times: times.length }).toEqual({
          path,
          times: Math.min(times.length, 2),
        });
      }
      // …and the waits grew to get there: the working poll's last gap is the minute cap, not its base.
      const working = between(outageFrom, outageTo)
        .filter((request) => request.path === "/api/agents/working")
        .map((request) => request.at);
      const gaps = working
        .slice(1)
        .map((at, index) => at - (working[index] ?? at));
      expect(Math.max(...gaps)).toBeGreaterThanOrEqual(0.9 * OUTAGE_CAP_MS);
      expect(Math.max(...gaps)).toBeLessThan(OUTAGE_CAP_MS * 1.6);

      // THE WAY BACK: the server returns and the person looks at the window again.
      down = false;
      const returnedAt = Date.now();
      setVisible(true);
      window.dispatchEvent(new Event("focus"));
      await clock.pass(3_000);
      const resumed = new Set(
        between(returnedAt, Date.now()).map((request) => request.path),
      );
      expect(resumed.has("/api/agents/working")).toBe(true);
    } finally {
      clock.restore();
      await view.unmount();
    }
  }, 60_000);
});

describe("the interval rule every poll shares", () => {
  const state = (overrides: Record<string, unknown>) => ({
    state: {
      status: "success" as const,
      dataUpdatedAt: 0,
      errorUpdatedAt: 0,
      errorUpdateCount: 0,
      ...overrides,
    },
  });

  test("waits as long as it has already been failing, from its own interval up to a minute", () => {
    const every = pollEvery(4_000);
    expect(every(state({ dataUpdatedAt: 1_000 }))).toBe(4_000);
    const failing = (forMs: number) =>
      every(
        state({
          status: "error",
          dataUpdatedAt: 100_000,
          errorUpdatedAt: 100_000 + forMs,
        }),
      );
    expect(failing(4_000)).toBe(4_000);
    expect(failing(12_000)).toBe(12_000);
    expect(failing(600_000)).toBe(OUTAGE_CAP_MS);
    // Never succeeded: every error was consecutive, so their count is the exponent.
    expect(every(state({ status: "error", errorUpdateCount: 3 }))).toBe(16_000);
  });
});
