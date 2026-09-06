import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { serveFixture, VISIBLE_TEXT } from "./fixture-site";

/**
 * A site that never answers, and the Bot that has to go on working afterwards.
 *
 * Measured 2026-09-06 (docs/laf/browser-limits.md §3): one navigation to 기업마당 that ran out its
 * deadline left that Bot's browser dead for the rest of the day — every later `navigate` sat out
 * its own deadline, and stop and reset hung behind a `context.close()` that never returned. This
 * drives the real `src/index.ts` against a fixture endpoint that accepts the connection and then
 * says nothing, with a two-second deadline so the run stays short, and asks the two questions that
 * matter: does the next command on that Bot work, and does reset answer while a page is hanging.
 *
 * Skipped where Playwright has no browser downloaded, like korean-sites.test.ts.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const BOT = "hung-site-bot";
const TOKEN = "test-computer-token";
const NAVIGATION_TIMEOUT_MS = 2_000;

let base = "";
let fixture: ReturnType<typeof serveFixture> | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;
let profilesDir = "";
let workspaceDir = "";

async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("Bun.serve returned no port.");
  return port;
}

async function post(
  path: string,
  payload: unknown,
  bot = BOT,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": bot,
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

const timed = async <T>(
  work: Promise<T>,
): Promise<{ result: T; ms: number }> => {
  const started = Date.now();
  const result = await work;
  return { result, ms: Date.now() - started };
};

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  fixture = serveFixture();
  profilesDir = await mkdtemp(join(tmpdir(), "laf-hung-profiles-"));
  workspaceDir = await mkdtemp(join(tmpdir(), "laf-hung-workspace-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      PROFILES_DIR: profilesDir,
      WORKSPACE_DIR: workspaceDir,
      NAVIGATION_TIMEOUT_MS: String(NAVIGATION_TIMEOUT_MS),
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
});

afterAll(async () => {
  child?.kill();
  fixture?.stop();
  if (profilesDir) await rm(profilesDir, { recursive: true, force: true });
  if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true });
});

describe.skipIf(!HAS_BROWSER)("a page that never loads", () => {
  test("is given up on at the deadline, as the fact, and the next command works", async () => {
    const hung = await timed(post("/navigate", { url: `${fixture?.url}hang` }));
    expect(hung.result.status).toBe(504);
    expect(hung.result.body.code).toBe("laf:page_timeout");
    // The tab was replaced, or the browser was; either way the Bot was told which.
    expect(["page", "browser"]).toContain(String(hung.result.body.recycled));
    // The deadline plus the recovery, never a second deadline on top.
    expect(hung.ms).toBeLessThan(NAVIGATION_TIMEOUT_MS + 8_000);

    // THE FACT THAT WAS BROKEN: the same Bot, the next page. It used to take >45s and fail.
    const next = await timed(post("/navigate", { url: fixture?.url }));
    expect(next.result.status).toBe(200);
    expect(String(next.result.body.text)).toContain(VISIBLE_TEXT);
    expect(next.ms).toBeLessThan(NAVIGATION_TIMEOUT_MS + 8_000);
  }, 40_000);

  test("reset answers while a page is still hanging, and the Bot starts clean", async () => {
    // Not awaited: this is the navigation somebody presses reset in the middle of.
    const hanging = post("/navigate", { url: `${fixture?.url}hang` });
    await Bun.sleep(300);

    const reset = await timed(post("/computers/reset", {}));
    expect(reset.result.status).toBe(200);
    expect(reset.result.body.reset).toBe(true);
    // A close that hangs is killed after its grace (profiles.ts); nothing here waits longer.
    expect(reset.ms).toBeLessThan(10_000);

    // Whatever the interrupted navigation says, it says it rather than waiting for ever.
    const interrupted = await timed(hanging);
    expect(interrupted.result.status).not.toBe(200);
    expect(interrupted.ms).toBeLessThan(NAVIGATION_TIMEOUT_MS + 10_000);

    const fresh = await timed(post("/navigate", { url: fixture?.url }));
    expect(fresh.result.status).toBe(200);
    expect(String(fresh.result.body.text)).toContain(VISIBLE_TEXT);
  }, 40_000);
});
