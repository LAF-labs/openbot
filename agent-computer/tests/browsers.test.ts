import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import {
  BACKGROUND_BROWSERS,
  BROWSER_HEADER,
  createBrowsers,
  isBrowserName,
  soleBrowser,
  sweepBackgroundProfiles,
  UNUSED_MS,
} from "../src/browsers";
import type { Computer } from "../src/computer";
import type { StreamData } from "../src/live-screen";
import { computerFetch } from "../src/routes";
import { createSessions } from "../src/sessions";
import { createWorkspace } from "../src/workspace";

/**
 * THE BROWSERS A COMPUTER HOLDS (`browsers.ts`, piece 5-3): the main one, and a few in the
 * background, each with everything that used to be kept once per deployment.
 *
 * No Chromium here. What is held is the arithmetic of places — which browser a call is for, when
 * there is room, whose place may be given away, what letting go does — against seats that only count what was asked of them, and
 * the door's part of it against the one route that needs no browser (`/files/list`).
 * `background-browsers.test.ts` is the same thing with real browsers.
 */

const TOKEN = "browsers-test-token";
const BOT = "bot-1";

type Seat = Computer & {
  name: string | null;
  root: string;
  closed: number;
  /** Which Bots hold a tab in this browser, set by the test. */
  holding: string[];
};

let base: string;
let under: string;
let seats: Seat[];
let said: [string, Record<string, unknown>][];
/** The clock the browsers are read against, moved by the test's own hand. */
let clock: number;

/** A seat that opens nothing: sessions and a workspace that are real, a browser that counts. */
function seat(root: string, name: string | null): Seat {
  const made = {
    name,
    root,
    closed: 0,
    holding: [] as string[],
    config: { token: TOKEN },
    profiles: {
      follow: async () => undefined,
      liveBots: () => made.holding,
      closeAll: async () => {
        made.closed += 1;
        made.holding = [];
      },
    },
    workspace: createWorkspace(join(base, "workspace")),
    sessions: createSessions({
      stateDirectoryFor: (botId) => join(root, "state", botId),
    }),
  };
  seats.push(made as unknown as Seat);
  return made as unknown as Seat;
}

const browsers = (cap?: number) =>
  createBrowsers({
    main: seat(join(base, "main"), null),
    seatAt: (root, name) => seat(root, name),
    under,
    now: () => clock,
    ...(cap === undefined ? {} : { cap }),
    log: (event, facts) => void said.push([event, facts]),
  });

const profileDirs = async () =>
  (await readdir(under)).filter((name) => name.startsWith("laf-browser-"));

/** The seat a name was opened on: the last one built for it. */
const seatOf = (name: string) =>
  seats.findLast((one) => one.name === name) as Seat;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "laf-browsers-test-"));
  under = join(base, "tmp");
  await mkdir(under, { recursive: true });
  await mkdir(join(base, "workspace"), { recursive: true });
  seats = [];
  said = [];
  clock = 1_000_000;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("which browser a call is for", () => {
  test("no name is the main one, and it takes no place", () => {
    const held = browsers();
    expect(held.take(null)).toBe(held.main);
    expect(held.take(null)).toBe(held.main);
    held.left(null);
    expect(held.names()).toEqual([]);
    // Nothing was built for it: the main browser is the one this was made with.
    expect(seats.map((one) => one.name)).toEqual([null]);
  });

  test("a name nobody opened is nobody's browser: a call is not a reason to start one", () => {
    const held = browsers();
    expect(held.take("run-1")).toBeNull();
    expect(held.names()).toEqual([]);
    expect(seats.map((one) => one.name)).toEqual([null]);
  });

  test("an opened name is a browser of its own on a directory of its own, and opening it again is the same browser", async () => {
    const held = browsers();
    expect(held.open("run-1")).toBe(true);
    expect(held.open("run-1")).toBe(true);
    expect(held.open("run-2")).toBe(true);
    const first = held.take("run-1") as Seat;
    const second = held.take("run-2") as Seat;

    expect(held.take("run-1")).toBe(first);
    expect(second).not.toBe(first);
    expect(first).not.toBe(held.main);
    expect(held.names()).toEqual(["run-1", "run-2"]);
    // One seat built per name, however often it was opened.
    expect(seats.map((one) => one.name)).toEqual([null, "run-1", "run-2"]);
    // Each on its own profile root, under where background profiles are made, never the main one's.
    expect(first.root).not.toBe(second.root);
    expect(first.root.startsWith(join(under, "laf-browser-"))).toBe(true);
    expect(await profileDirs()).toHaveLength(2);
    // What is kept beside a browser is that browser's: the same Bot has a session in each.
    expect(first.sessions.sessionFor(BOT)).not.toBe(
      (held.main as Seat).sessions.sessionFor(BOT),
    );
  });

  test("there is room for as many as were measured, and past that the answer is no", () => {
    const held = browsers();
    for (let index = 0; index < BACKGROUND_BROWSERS; index += 1) {
      expect(held.open(`run-${index}`)).toBe(true);
    }
    expect(held.cap).toBe(BACKGROUND_BROWSERS);

    expect(held.open("one-too-many")).toBe(false);
    // An answer, not a queue: nothing was built or closed for it, and it is not a browser.
    expect(held.names()).toHaveLength(BACKGROUND_BROWSERS);
    expect(held.take("one-too-many")).toBeNull();
    expect(seats.map((one) => one.closed)).toEqual(seats.map(() => 0));
    expect(said.at(-1)).toEqual([
      "browsers_full",
      {
        asked: "one-too-many",
        open: BACKGROUND_BROWSERS,
        cap: BACKGROUND_BROWSERS,
      },
    ]);
    // One already open still opens and still answers: being full refuses a new browser only.
    expect(held.open("run-0")).toBe(true);
    expect(held.take("run-0")).toBe(seatOf("run-0"));
  });

  test("two asked for together when one place is left: one is opened, and the other is told no", () => {
    const held = browsers(1);
    // The same turn of the loop, as two requests read off one socket are.
    expect([held.open("a"), held.open("b")]).toEqual([true, false]);
    expect(held.names()).toEqual(["a"]);
  });
});

describe("whose place may be given away", () => {
  test("not one that was only just opened, though no call has reached it yet", () => {
    const held = browsers(1);
    held.open("a");
    // Opened a moment ago, no tab, no call: by tabs alone this was idle, and the browser a call
    // was on its way into was closed under it.
    clock += 5_000;
    expect(held.open("b")).toBe(false);
    expect(seatOf("a").closed).toBe(0);
  });

  test("not one with a call in it, however long the call has been going", () => {
    const held = browsers(1);
    held.open("a");
    held.take("a");
    clock += UNUSED_MS * 3;
    expect(held.open("b")).toBe(false);
    // The call ends: the wait starts from then, not from when the browser was opened.
    held.left("a");
    clock += UNUSED_MS - 1;
    expect(held.open("b")).toBe(false);
    clock += 1;
    expect(held.open("b")).toBe(true);
    expect(held.names()).toEqual(["b"]);
  });

  test("not one a Bot still holds a tab in", () => {
    const held = browsers(1);
    held.open("a");
    seatOf("a").holding = [BOT];
    clock += UNUSED_MS * 3;
    expect(held.open("b")).toBe(false);
  });

  test("one with no call, no tab and nothing asked of it for long enough is closed, thrown away, and its place taken", async () => {
    const held = browsers(2);
    held.open("kept");
    seatOf("kept").holding = [BOT];
    held.open("left-behind");
    const leftBehind = seatOf("left-behind");
    clock += UNUSED_MS;

    expect(held.open("next")).toBe(true);
    expect(held.names().sort()).toEqual(["kept", "next"]);
    await Bun.sleep(20);
    expect(leftBehind.closed).toBe(1);
    expect(seatOf("kept").closed).toBe(0);
    expect(existsSync(leftBehind.root)).toBe(false);
    // And the name it was under is nobody's again.
    expect(held.take("left-behind")).toBeNull();
  });

  test("a call that is over more times than it began does not unbalance the count", () => {
    const held = browsers(1);
    held.open("a");
    held.take("a");
    held.take("a");
    held.left("a");
    held.left("a");
    held.left("a");
    // Two began and two ended; one more beginning is one call in flight.
    held.take("a");
    clock += UNUSED_MS * 2;
    expect(held.open("b")).toBe(false);
  });
});

describe("letting a browser go", () => {
  test("closes it, removes its profile and frees its place", async () => {
    const held = browsers(1);
    held.open("run-1");
    const one = seatOf("run-1");
    one.holding = [BOT];
    await writeFile(join(one.root, "Cookies"), "what a site left", "utf8");

    expect(await held.release("run-1")).toBe(true);
    expect(one.closed).toBe(1);
    expect(existsSync(one.root)).toBe(false);
    expect(held.names()).toEqual([]);
    expect(held.take("run-1")).toBeNull();
    // Nothing under that name any more: a second release has nothing to close.
    expect(await held.release("run-1")).toBe(false);
    expect(await held.release("never-opened")).toBe(false);
    // And the place is free at once: the same name opens a new browser, not the one that closed.
    expect(held.open("run-1")).toBe(true);
    expect(seatOf("run-1")).not.toBe(one);
    expect(seatOf("run-1").root).not.toBe(one.root);
  });

  test("closing everything closes the main browser and every background one", async () => {
    const held = browsers();
    held.open("a");
    held.open("b");
    await held.closeAll();
    expect([
      (held.main as Seat).closed,
      seatOf("a").closed,
      seatOf("b").closed,
    ]).toEqual([1, 1, 1]);
    expect(held.names()).toEqual([]);
    expect(await profileDirs()).toEqual([]);
  });

  test("what a process that died left behind is removed at the next start, and nothing else is", async () => {
    await mkdir(join(under, "laf-browser-abc123"), { recursive: true });
    await mkdir(join(under, "laf-browser-def456", "Default"), {
      recursive: true,
    });
    await mkdir(join(under, "somebody-elses"), { recursive: true });

    expect(await sweepBackgroundProfiles(under)).toBe(2);
    expect(await readdir(under)).toEqual(["somebody-elses"]);
    // A directory that is not there is nothing to sweep, not a failure to start.
    expect(await sweepBackgroundProfiles(join(under, "missing"))).toBe(0);
  });
});

describe("a browser's name", () => {
  test.each(["run-1", "a", "routine.7f3c_2", "A9", "x".repeat(128)])(
    "%p is a name",
    (name) => {
      expect(isBrowserName(name)).toBe(true);
    },
  );

  test.each([
    "",
    " ",
    "../profiles",
    "a/b",
    "a b",
    ".hidden",
    "-flag",
    "한글",
    "x".repeat(129),
    null,
    7,
  ])("%p is not", (name) => {
    expect(isBrowserName(name)).toBe(false);
  });
});

describe("the door", () => {
  const door = (held: ReturnType<typeof browsers>) => {
    const handle = computerFetch(held);
    return (path: string, headers: Record<string, string> = {}) =>
      handle(
        new Request(`http://computer${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-openbot-computer-token": TOKEN,
            "x-openbot-bot-id": BOT,
            ...headers,
          },
          body: "{}",
        }),
        {} as Server<StreamData>,
      );
  };
  const answered = async (response: Response) => ({
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  });
  const UNUSABLE = {
    status: 400,
    body: {
      error: "laf:request_invalid",
      code: "laf:request_invalid",
      field: "browser",
    },
  };
  const named = (name: string) => ({ [BROWSER_HEADER]: name });

  test("a call that names no browser is answered by the main one, as every call was", async () => {
    const held = browsers();
    const ask = door(held);
    expect((await ask("/files/list")).status).toBe(200);
    expect(held.names()).toEqual([]);
  });

  test("a browser is opened by asking for it, and a call that names it is answered by it", async () => {
    const held = browsers();
    const ask = door(held);
    expect(await answered(await ask("/browsers/open", named("run-1")))).toEqual(
      {
        status: 200,
        body: { opened: true, open: 1, cap: BACKGROUND_BROWSERS },
      },
    );
    expect((await ask("/files/list", named("run-1"))).status).toBe(200);
    expect(held.names()).toEqual(["run-1"]);
  });

  test("a call that names a browser nobody opened is refused, and opens nothing", async () => {
    const held = browsers();
    const ask = door(held);
    expect(await answered(await ask("/files/list", named("run-1")))).toEqual(
      UNUSABLE,
    );
    expect(held.names()).toEqual([]);
  });

  test("a name that is not one is refused at every door, and opens nothing", async () => {
    const held = browsers();
    const ask = door(held);
    for (const path of ["/files/list", "/browsers/open", "/browsers/release"]) {
      expect(await answered(await ask(path, named("../x")))).toEqual(UNUSABLE);
    }
    expect(held.names()).toEqual([]);
  });

  test("with every place taken, opening another is answered no — an answer, not a failure", async () => {
    const held = browsers(1);
    const ask = door(held);
    await ask("/browsers/open", named("held"));
    expect(
      await answered(await ask("/browsers/open", named("another"))),
    ).toEqual({ status: 200, body: { opened: false, open: 1, cap: 1 } });
    expect(held.names()).toEqual(["held"]);
  });

  test("the door says when a call is over, so a browser with a call in it is nobody's to take", async () => {
    const held = browsers(1);
    const ask = door(held);
    await ask("/browsers/open", named("a"));
    await ask("/files/list", named("a"));
    // The call is over and the browser has gone unused for long enough.
    clock += UNUSED_MS;
    expect(
      (await answered(await ask("/browsers/open", named("b")))).body.opened,
    ).toBe(true);
    expect(held.names()).toEqual(["b"]);
  });

  test("a route this build does not have is said before anything else about the browser", async () => {
    const held = browsers();
    const ask = door(held);
    const refused = await answered(await ask("/no-such-route", named("run-1")));
    expect(refused.body.code).toBe("laf:computer_route_unknown");
  });

  test("letting go is asked for by the browser's name, and needs one", async () => {
    const held = browsers();
    const ask = door(held);
    await ask("/browsers/open", named("run-1"));

    expect(
      await answered(await ask("/browsers/release", named("run-1"))),
    ).toEqual({ status: 200, body: { released: true } });
    expect(held.names()).toEqual([]);
    expect(
      await answered(await ask("/browsers/release", named("run-1"))),
    ).toEqual({ status: 200, body: { released: false } });
    // The main browser is neither opened nor let go of this way: no name is a part missing.
    expect(await answered(await ask("/browsers/release"))).toEqual(UNUSABLE);
    expect(await answered(await ask("/browsers/open"))).toEqual(UNUSABLE);
    expect((held.main as Seat).closed).toBe(0);
  });

  test("a computer with one browser has no room for another, and says so", async () => {
    const held = soleBrowser(seat(join(base, "main"), null));
    const ask = door(held);
    expect((await ask("/files/list")).status).toBe(200);
    expect(
      (await answered(await ask("/browsers/open", named("run-1")))).body,
    ).toEqual({ opened: false, open: 0, cap: 0 });
  });
});
