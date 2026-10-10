import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { BACKGROUND_BROWSERS, BROWSER_HEADER } from "../src/browsers";
import { serveFixture, SIGNED_OUT_TEXT, signedInAs } from "./fixture-site";

/**
 * BACKGROUND BROWSERS, WITH REAL ONES (`browsers.ts`, piece 5-3).
 *
 * `browsers.test.ts` holds the arithmetic against seats that open nothing. This is the computer
 * itself, started as the image starts it, with Chromium: that a background browser really is a
 * second browser — not signed in to what the main one is, not moving what a Bot is looking at
 * there — that there is room for as many as the number says and no more, and that letting one go
 * closes it and leaves nothing of its profile on disk.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const TOKEN = "test-computer-token";
const BOT = "shop-bot";
const SIGNED_IN_AS = "가게봇";

let fixture: ReturnType<typeof serveFixture> | null = null;
let base = "";
let child: ReturnType<typeof Bun.spawn> | null = null;
let root = "";
/** Where this computer makes its background profiles: its own temporary directory. */
let temp = "";

async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("Bun.serve returned no port.");
  return port;
}

type Answer = { status: number; body: Record<string, unknown> };

async function post(
  path: string,
  payload: unknown,
  browser?: string,
): Promise<Answer> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": BOT,
      ...(browser ? { [BROWSER_HEADER]: browser } : {}),
    },
  });
  return {
    status: response.status,
    body: ((await response.json().catch(() => null)) ?? {}) as Record<
      string,
      unknown
    >,
  };
}

const textOf = (answer: Answer) => String(answer.body.text ?? "");
const whoAmI = (browser?: string) =>
  post("/navigate", { url: `${fixture?.url}whoami` }, browser);
const backgroundProfiles = async () =>
  (await readdir(temp)).filter((name) => name.startsWith("laf-browser-"));
/** Ask for a background browser by name, as the server will before it sends a Bot into one. */
const open = async (browser: string) =>
  (await post("/browsers/open", {}, browser)).body;

describe.skipIf(!HAS_BROWSER)("background browsers, with real ones", () => {
  beforeAll(async () => {
    fixture = serveFixture();
    root = await mkdtemp(join(tmpdir(), "laf-background-browsers-"));
    temp = join(root, "tmp");
    await mkdir(temp, { recursive: true });
    await mkdir(join(root, "workspace"), { recursive: true });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
      env: {
        ...process.env,
        COMPUTER_TOKEN: TOKEN,
        PORT: String(port),
        PROFILES_DIR: join(root, "profiles"),
        WORKSPACE_DIR: join(root, "workspace"),
        // Where `os.tmpdir()` points, so the profiles this computer makes are this test's to count.
        TMPDIR: temp,
        AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
        AGENT_COMPUTER_EGRESS_FIREWALL: "off",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const alive = await fetch(`${base}/health`).catch(() => null);
      if (alive?.ok) return;
      await Bun.sleep(100);
    }
    throw new Error("the computer did not start");
  }, 30_000);

  afterAll(async () => {
    child?.kill();
    await child?.exited.catch(() => undefined);
    await fixture?.stop();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  test("a background browser is not signed in to what the main one is, and does not move what the Bot is looking at there", async () => {
    // The main browser signs in, as a person's Bot does.
    const signedIn = await post("/navigate", {
      url: `${fixture?.url}sign-in?as=${encodeURIComponent(SIGNED_IN_AS)}`,
    });
    expect(signedIn.status).toBe(200);
    expect(textOf(await whoAmI())).toContain(signedInAs(SIGNED_IN_AS));

    // A name nobody opened is not a browser, and a call into it starts none.
    const unopened = await whoAmI("run-1");
    expect(unopened.status).toBe(400);
    expect(unopened.body).toMatchObject({
      code: "laf:request_invalid",
      field: "browser",
    });
    expect(await backgroundProfiles()).toEqual([]);

    // Opened, the same Bot has a browser of its own: another cookie jar, so nobody is signed in.
    expect(await open("run-1")).toEqual({
      opened: true,
      open: 1,
      cap: BACKGROUND_BROWSERS,
    });
    const elsewhere = await whoAmI("run-1");
    expect(elsewhere.status).toBe(200);
    expect(textOf(elsewhere)).toContain(SIGNED_OUT_TEXT);
    expect(await backgroundProfiles()).toHaveLength(1);

    // And it went somewhere else without the main browser's tab going anywhere.
    await post("/navigate", { url: `${fixture?.url}other` }, "run-1");
    const stillThere = await fetch(`${base}/read`, {
      headers: { "x-openbot-computer-token": TOKEN, "x-openbot-bot-id": BOT },
    });
    expect(
      String(((await stillThere.json()) as { text?: string }).text ?? ""),
    ).toContain(signedInAs(SIGNED_IN_AS));
  }, 60_000);

  test("a snapshot in one browser does not make the other's stale", async () => {
    const main = await post("/snapshot", {});
    const background = await post("/snapshot", {}, "run-1");
    expect(main.status).toBe(200);
    expect(background.status).toBe(200);
    // Each browser counts its own looks: taking one in the background left the main one's id
    // the newest the main browser has, so a ref from it still acts.
    const again = await post("/snapshot", {}, "run-1");
    expect(Number(again.body.snapshotId)).toBeGreaterThan(
      Number(background.body.snapshotId),
    );
    const mainAgain = await post("/snapshot", {});
    expect(Number(mainAgain.body.snapshotId)).toBe(
      Number(main.body.snapshotId) + 1,
    );
  }, 60_000);

  test("there is room for as many as the number says, the next is told there is none, and letting one go makes room", async () => {
    // `run-1` is open from the tests above; fill what is left.
    for (let index = 2; index <= BACKGROUND_BROWSERS; index += 1) {
      expect((await open(`run-${index}`)).opened).toBe(true);
      expect((await whoAmI(`run-${index}`)).status).toBe(200);
    }
    expect(await backgroundProfiles()).toHaveLength(BACKGROUND_BROWSERS);

    // An answer, not a failure: there is no room, and the caller is told so.
    expect(await open("one-too-many")).toEqual({
      opened: false,
      open: BACKGROUND_BROWSERS,
      cap: BACKGROUND_BROWSERS,
    });
    // Nothing was opened for it, and the ones that were open still answer.
    expect(await backgroundProfiles()).toHaveLength(BACKGROUND_BROWSERS);
    expect((await whoAmI("run-1")).status).toBe(200);

    const released = await post("/browsers/release", {}, "run-1");
    expect(released.body).toEqual({ released: true });
    // Closed, and its profile gone from the disk with it.
    expect(await backgroundProfiles()).toHaveLength(BACKGROUND_BROWSERS - 1);

    expect((await open("one-too-many")).opened).toBe(true);
    expect((await whoAmI("one-too-many")).status).toBe(200);
    expect(await backgroundProfiles()).toHaveLength(BACKGROUND_BROWSERS);
    // The main browser was never one of the places, and is still signed in.
    expect(textOf(await whoAmI())).toContain(signedInAs(SIGNED_IN_AS));
  }, 120_000);

  test("a name that is not a name opens nothing", async () => {
    const before = await backgroundProfiles();
    const refused = await whoAmI("../profiles");
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      code: "laf:request_invalid",
      field: "browser",
    });
    expect(await backgroundProfiles()).toEqual(before);
  }, 20_000);
});
