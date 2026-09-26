import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

/**
 * A DOWNLOAD THAT NEVER ENDS, AGAINST THE DISK IT LANDS ON.
 *
 * Measured 2026-09-26 against the real computer before `download-limit.ts`: an attachment streamed at
 * ~12 MB/s reached 27.8, 53.5, 79.2 and 104.9 MB in Chromium's download directory at 2, 4, 6 and 8 s,
 * the click answered 200 at once, the workspace stayed empty and no note came — the 1 MB limit was
 * measured on a file `saveAs` would hand over once it had finished, which this one never does. That
 * directory is under /tmp, the container's layer, the disk Postgres is on.
 *
 * This drives the real `src/index.ts` with its temporary directory pointed somewhere it can be
 * weighed, and asks: is the download stopped, does the server stop being read, is the disk given
 * back, and is the Bot told `laf:download_too_large` promptly.
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
const BOT = "download-bound-bot";

type Computer = { url: string; temporary: string; stop: () => Promise<void> };
let computer: Computer | null = null;
let site: ReturnType<typeof Bun.serve> | null = null;
let served = 0;
const CHUNK = new Uint8Array(256 * 1024).fill(65);

function serveSite(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch(request: Request): Response {
      const url = new URL(request.url);
      if (url.pathname === "/endless") {
        // 256 KB every 20 ms, for ever: ~12 MB/s.
        const stream = new ReadableStream({
          async pull(controller) {
            await Bun.sleep(20);
            served += CHUNK.byteLength;
            controller.enqueue(CHUNK);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="invoice.pdf"',
          },
        });
      }
      return new Response(
        `<html><body><a href="/endless">세금계산서 받기</a></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
}

async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("Bun.serve returned no port.");
  return port;
}

async function startComputer(): Promise<Computer> {
  const profilesDir = await mkdtemp(join(tmpdir(), "laf-download-profiles-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "laf-download-workspace-"));
  // Where Playwright puts Chromium's downloads while they arrive, so the disk can be weighed.
  const temporary = await mkdtemp(join(tmpdir(), "laf-download-tmp-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      PROFILES_DIR: profilesDir,
      WORKSPACE_DIR: workspaceDir,
      TMPDIR: temporary,
      AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const stop = async () => {
    child.kill();
    await child.exited;
    for (const dir of [profilesDir, workspaceDir, temporary]) {
      await rm(dir, { recursive: true, force: true });
    }
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const alive = await fetch(`${url}/health`).catch(() => null);
    if (alive?.ok) return { url, temporary, stop };
    await Bun.sleep(100);
  }
  await stop();
  throw new Error("the computer did not start");
}

async function call(
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${computer?.url}${path}`, {
    method,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": BOT,
    },
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/** Every byte under a directory, the files a download is being written to included. */
function weigh(dir: string): number {
  let total = 0;
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else total += statSync(full).size;
      } catch {
        // Deleted between the listing and the look: it weighs nothing now.
      }
    }
  };
  walk(dir);
  return total;
}

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  site = serveSite();
  computer = await startComputer();
});

afterAll(async () => {
  await computer?.stop();
  site?.stop(true);
});

describe.skipIf(!HAS_BROWSER)("a download that never ends", () => {
  test("is stopped near the limit, gives the disk back, and the Bot is told it was too large", async () => {
    const opened = await call("POST", "/navigate", {
      url: `http://127.0.0.1:${site?.port}/`,
    });
    expect(opened.status).toBe(200);
    const look = await call("POST", "/snapshot", {});
    const link = (look.body.elements as { ref: string; role: string }[]).find(
      (element) => element.role === "link",
    );
    const clickedAt = Date.now();
    const clicked = await call("POST", "/click", {
      ref: link?.ref,
      snapshotId: look.body.snapshotId,
    });
    expect(clicked.status).toBe(200);

    // The note rides on the next result; ask until it comes, and weigh the disk while waiting.
    let heaviest = 0;
    let told: string | undefined;
    const notes = (clicked.body.notes as { code: string }[] | undefined) ?? [];
    told = notes.find((entry) => entry.code.startsWith("laf:download"))?.code;
    while (!told && Date.now() - clickedAt < 15_000) {
      heaviest = Math.max(heaviest, weigh(computer?.temporary ?? ""));
      await Bun.sleep(200);
      const read = await call("GET", "/read");
      told = ((read.body.notes as { code: string }[] | undefined) ?? []).find(
        (entry) => entry.code.startsWith("laf:download"),
      )?.code;
    }
    const tellingMs = Date.now() - clickedAt;
    expect(told).toBe("laf:download_too_large");
    expect(tellingMs).toBeLessThan(5_000);

    // Nothing more is read from the site once it is stopped, and the partial file is gone.
    await Bun.sleep(1_000);
    const servedThen = served;
    await Bun.sleep(1_500);
    expect(served - servedThen).toBeLessThan(2 * CHUNK.byteLength);
    heaviest = Math.max(heaviest, weigh(computer?.temporary ?? ""));
    // The limit plus the progress events' interval at this rate — never the stream.
    expect(heaviest).toBeLessThan(30_000_000);
    expect(weigh(computer?.temporary ?? "")).toBeLessThan(1_000_000);
    console.log(
      `told in ${tellingMs} ms; heaviest on disk ${(heaviest / 1e6).toFixed(1)} MB; served ${(served / 1e6).toFixed(1)} MB`,
    );
  }, 60_000);
});
