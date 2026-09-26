import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

/**
 * A KEY WITH NO REF LANDS ON THE PAGE IT WAS JUDGED AGAINST, OR NOWHERE.
 *
 * Measured 2026-09-26 on the real computer, and the reason this file exists: a page's own script
 * opened a tab 1.5 s after the Bot's snapshot, the tab became the Bot's, and the next `/key Enter`
 * pressed that tab's autofocused 송금하기 — while the server, whose snapshot still described the page
 * before, judged the key there. The same for a `target=_blank` link: the click answered with the old
 * tab as `url`. A ref is refused from another generation; a ref-less key carried nothing to refuse.
 *
 * Now the server sends the generation it judged against (`acts.ts`) and the computer refuses a key
 * or a scroll whose page has moved since. These drive the real `src/index.ts`, and press nothing on
 * the wrong page — the fixture counts every press, by the page it landed on.
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
const pressed: string[] = [];

/** The fixture: a blog that opens a bank, one way or another, and a bank that counts presses. */
function serveSite(): ReturnType<typeof Bun.serve> {
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    fetch(request: Request): Response {
      const url = new URL(request.url);
      const bank = `http://localhost:${server.port}/bank`;
      const html = (body: string) =>
        new Response(`<html><body>${body}</body></html>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      switch (url.pathname) {
        case "/link":
          return html(
            `<h1>Blog</h1><a href="${bank}" target="_blank">read more</a>`,
          );
        case "/script-popup":
          return html(
            `<h1>Blog</h1><script>setTimeout(() => window.open("${bank}"), 800)</script>`,
          );
        case "/spa":
          // Moves its own address every 300 ms, the way a single-page app does on every click.
          return html(
            `<h1>Shop</h1><button autofocus onclick="fetch('/pressed?on=spa')">담기</button>` +
              `<script>let n = 0; setInterval(() => history.pushState({}, "", "/spa/" + n++), 300)</script>`,
          );
        case "/opens-reloader":
          return html(
            `<h1>Blog</h1><a href="/reloader" target="_blank">live scores</a>`,
          );
        case "/reloader":
          // A background tab that reloads itself, as a scoreboard or a news ticker does.
          return html(
            "<p>scores</p><script>setTimeout(() => location.reload(), 300)</script>",
          );
        case "/bank":
          return html(
            `<button autofocus onclick="fetch('/pressed?on=bank')">송금하기</button>`,
          );
        case "/pressed":
          pressed.push(url.searchParams.get("on") ?? "");
          return new Response("ok");
        default:
          return new Response("not here", { status: 404 });
      }
    },
  });
  return server;
}

async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("Bun.serve returned no port.");
  return port;
}

async function startComputer(): Promise<Computer> {
  const profilesDir = await mkdtemp(join(tmpdir(), "laf-generation-profiles-"));
  const workspaceDir = await mkdtemp(
    join(tmpdir(), "laf-generation-workspace-"),
  );
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

type Answer = { status: number; body: Record<string, unknown> };

async function post(
  path: string,
  payload: unknown,
  bot: string,
): Promise<Answer> {
  const response = await fetch(`${computer?.url}${path}`, {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
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

const at = (path: string) => `http://127.0.0.1:${site?.port}${path}`;

/** Wait for a press that might have been made, so a missing one is a fact and not a race. */
async function settledPresses(): Promise<string[]> {
  await Bun.sleep(400);
  return [...pressed];
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

describe.skipIf(!HAS_BROWSER)(
  "a key with no ref, after the page moved under it",
  () => {
    test("a tab the page's own script opened: the key is refused, and presses nothing", async () => {
      pressed.length = 0;
      const bot = "generation-script";
      await post("/navigate", { url: at("/script-popup") }, bot);
      const look = await post("/snapshot", {}, bot);
      const judged = look.body.snapshotId as number;
      // The tab opens while the Bot is thinking about the page it looked at.
      await Bun.sleep(1_500);

      const key = await post("/key", { key: "Enter", snapshotId: judged }, bot);
      expect(key.status).toBe(409);
      expect(key.body.code).toBe("laf:stale_refs");
      // And where the Bot is now, so the server's next refusal names the bank, not the blog.
      expect(String(key.body.url)).toContain("/bank");
      expect(key.body.generation).not.toBe(judged);
      expect(await settledPresses()).toEqual([]);

      // Looked at again, it is the bank the Bot sees — and the same key, held to that look, lands.
      const again = await post("/snapshot", {}, bot);
      expect(String(again.body.url)).toContain("/bank");
      const landed = await post(
        "/key",
        { key: "Enter", snapshotId: again.body.snapshotId },
        bot,
      );
      expect(landed.status).toBe(200);
      expect(await settledPresses()).toEqual(["bank"]);
    }, 60_000);

    test("a tab a link opened: the answer names it, and a key held to the look before is refused", async () => {
      pressed.length = 0;
      const bot = "generation-link";
      await post("/navigate", { url: at("/link") }, bot);
      const look = await post("/snapshot", {}, bot);
      const link = (
        look.body.elements as { ref: string; role: string; name: string }[]
      ).find((element) => element.role === "link");
      const click = await post(
        "/click",
        {
          ref: link?.ref,
          snapshotId: look.body.snapshotId,
          element: { role: "link", name: link?.name },
        },
        bot,
      );
      expect(click.status).toBe(200);
      expect((click.body.page as { url?: string } | undefined)?.url).toContain(
        "/bank",
      );
      expect(typeof click.body.generation).toBe("number");
      // Give the adoption its moment, then press as a server still holding the blog's look would.
      await Bun.sleep(300);
      const key = await post(
        "/key",
        { key: "Enter", snapshotId: look.body.snapshotId },
        bot,
      );
      expect(key.status).toBe(409);
      expect(key.body.code).toBe("laf:stale_refs");
      expect(await settledPresses()).toEqual([]);
    }, 60_000);

    test("a scroll is held the same way", async () => {
      const bot = "generation-scroll";
      await post("/navigate", { url: at("/script-popup") }, bot);
      const look = await post("/snapshot", {}, bot);
      await Bun.sleep(1_500);
      const scroll = await post(
        "/scroll",
        { deltaY: 300, snapshotId: look.body.snapshotId },
        bot,
      );
      expect(scroll.status).toBe(409);
      expect(scroll.body.code).toBe("laf:stale_refs");
    }, 60_000);

    test("a hand-back moves the generation: what the person did is not what the Bot looked at", async () => {
      const bot = "generation-handback";
      await post("/navigate", { url: at("/bank") }, bot);
      const look = await post("/snapshot", {}, bot);
      await post("/control/take", {}, bot);
      await post("/control/release", {}, bot);
      const key = await post(
        "/key",
        { key: "Escape", snapshotId: look.body.snapshotId },
        bot,
      );
      expect(key.status).toBe(409);
      expect(key.body.code).toBe("laf:stale_refs");
    }, 60_000);
  },
);

/*
 * AND NOTHING THAT IS NOT A NEW PAGE MOVES IT. A single-page app moves its address with `pushState`
 * on every other click, and a generation that moved for that would retire the refs the Bot is still
 * using on the same document — a chat and a routine on one tab would refuse each other all day.
 */
describe.skipIf(!HAS_BROWSER)("what leaves the generation where it was", () => {
  test("a pushState is not a new page: the key held to the look lands", async () => {
    pressed.length = 0;
    const bot = "generation-spa";
    await post("/navigate", { url: at("/spa") }, bot);
    const look = await post("/snapshot", {}, bot);
    // The page moves its address several times between the look and the key.
    await Bun.sleep(1_200);
    const key = await post(
      "/key",
      { key: "Enter", snapshotId: look.body.snapshotId },
      bot,
    );
    expect(key.status).toBe(200);
    expect(await settledPresses()).toEqual(["spa"]);
  }, 60_000);

  test("a background tab that reloads itself does not move the tab the Bot is on", async () => {
    const bot = "generation-background";
    await post("/navigate", { url: at("/opens-reloader") }, bot);
    const first = await post("/snapshot", {}, bot);
    const link = (first.body.elements as { ref: string; role: string }[]).find(
      (element) => element.role === "link",
    );
    await post(
      "/click",
      { ref: link?.ref, snapshotId: first.body.snapshotId },
      bot,
    );
    // Back to the blog; the scoreboard goes on reloading behind it.
    const switched = await post("/tabs/switch", { index: 0 }, bot);
    expect(switched.status).toBe(200);
    const look = await post("/snapshot", {}, bot);
    expect(String(look.body.url)).toContain("/opens-reloader");
    await Bun.sleep(1_500);
    const key = await post(
      "/key",
      { key: "Tab", snapshotId: look.body.snapshotId },
      bot,
    );
    expect(key.status).toBe(200);
  }, 60_000);

  test("an older server that sends no generation is held to nothing, as before", async () => {
    const bot = "generation-older";
    await post("/navigate", { url: at("/bank") }, bot);
    const key = await post("/key", { key: "Tab" }, bot);
    expect(key.status).toBe(200);
  }, 60_000);
});
