import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

/**
 * STOP STOPS, WITH THE LIVE SCREEN OPEN.
 *
 * Measured 2026-09-26 on the real computer: `/computers/stop` with a screen open answered
 * `{"stopped":true}`, and six seconds later `/health` said the browser was running again, on a fresh
 * blank tab. The screen's loop asked for the Bot's page every second, and asking opened one — and
 * started the browser — and marked the Bot busy, so the idle sweep never closed it either. A deleted
 * Bot's screen kept its tab alive the same way (`release.ts` stops the Bot's computer).
 *
 * Now stop ends the Bot's screens, and a screen shows the page the Bot has and never makes one: the
 * surface reconnects a closed screen by itself (`app/src/components/computer/live-screen.tsx`), so
 * this reconnects too, and the browser has to stay down through that.
 *
 * Skipped where Playwright has no browser downloaded, like hung-site.test.ts. To run here as root,
 * where Chromium's sandbox needs an unprivileged user, run it as one with PLAYWRIGHT_BROWSERS_PATH
 * pointing at a Chromium this Playwright accepts.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const TOKEN = "test-computer-token";

type Computer = { url: string; stop: () => Promise<void> };
let computer: Computer | null = null;
let site: ReturnType<typeof Bun.serve> | null = null;

async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("Bun.serve returned no port.");
  return port;
}

async function startComputer(): Promise<Computer> {
  const profilesDir = await mkdtemp(join(tmpdir(), "laf-screen-profiles-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "laf-screen-workspace-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      PROFILES_DIR: profilesDir,
      WORKSPACE_DIR: workspaceDir,
      AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const stop = async () => {
    child.kill();
    await child.exited;
    await rm(profilesDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const alive = await fetch(`${url}/health`).catch(() => null);
    if (alive?.ok) return { url, stop };
    await Bun.sleep(100);
  }
  await stop();
  throw new Error("the computer did not start");
}

async function call(
  method: "GET" | "POST",
  path: string,
  bot: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${computer?.url}${path}`, {
    method,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": bot,
    },
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/** A live screen as the surface opens it, counting pictures and noticing when it is closed. */
async function openScreen(bot: string) {
  const socket = new WebSocket(
    `${computer?.url.replace(/^http/, "ws")}/stream?bot=${bot}&token=${TOKEN}`,
  );
  socket.binaryType = "arraybuffer";
  const screen = { frames: 0, closed: false, socket };
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") screen.frames += 1;
  });
  socket.addEventListener("close", () => {
    screen.closed = true;
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("no socket")));
  });
  return screen;
}

async function until(holds: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (holds()) return true;
    await Bun.sleep(100);
  }
  return holds();
}

const running = async (bot: string) =>
  (await call("GET", "/health", bot)).body.browser === true;

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  site = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        // Something that changes, so the cast has pictures to send.
        `<html><body><p id=n>0</p><script>let n = 0; setInterval(() => { document.getElementById("n").textContent = String(n++) }, 100)</script></body></html>`,
        { headers: { "content-type": "text/html" } },
      ),
  });
  computer = await startComputer();
});

afterAll(async () => {
  await computer?.stop();
  site?.stop(true);
});

describe.skipIf(!HAS_BROWSER)("stop, with the live screen open", () => {
  test("ends the screen, and the browser stays down though the screen reconnects", async () => {
    const bot = "screen-stop-bot";
    await call("POST", "/navigate", bot, {
      url: `http://127.0.0.1:${site?.port}/`,
    });
    const screen = await openScreen(bot);
    expect(await until(() => screen.frames > 0, 5_000)).toBe(true);

    const stopped = await call("POST", "/computers/stop", bot, {});
    expect(stopped.status).toBe(200);
    expect(stopped.body.wasRunning).toBe(true);
    expect(await until(() => screen.closed, 3_000)).toBe(true);

    // The surface opens it again at once, as it does for any screen that closed.
    const again = await openScreen(bot);
    await Bun.sleep(3_000);
    expect(await running(bot)).toBe(false);
    expect(again.frames).toBe(0);
    const listed = await call("GET", "/computers", bot);
    const row = (
      listed.body.computers as { botId: string; running: boolean }[]
    ).find((entry) => entry.botId === bot);
    expect(row?.running ?? false).toBe(false);

    // The Bot working again is what brings the browser back, and the open screen shows it.
    await call("POST", "/navigate", bot, {
      url: `http://127.0.0.1:${site?.port}/`,
    });
    expect(await until(() => again.frames > 0, 5_000)).toBe(true);
    again.socket.close();
  }, 60_000);

  test("a screen opened on a computer with no browser does not start one", async () => {
    const bot = "screen-cold-bot";
    await call("POST", "/computers/stop", bot, {});
    const screen = await openScreen(bot);
    await Bun.sleep(2_500);
    expect(await running(bot)).toBe(false);
    expect(screen.frames).toBe(0);
    screen.socket.close();
  }, 30_000);
});
