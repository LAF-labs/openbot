import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { VISIBLE_TEXT } from "./fixture-site";

/**
 * The boundaries the browser holds itself, driven against a real Chromium (audit A3, 2026-09-10).
 *
 *  - EVERY HOP IS JUDGED BEFORE IT IS SENT. A public host that 302s to a denied one was one redirect
 *    from `169.254.169.254`, Postgres and the credential vault, because only the address the Bot
 *    asked for was ever judged. `site` below is the host that counts requests: a refused or held hop
 *    must not appear in it at all, which is the difference between stopping a hop and reading the
 *    page it returned and then hiding it.
 *  - A HOP TO A HOST NOBODY JUDGED IS HANDED BACK when the gateway asks for that (`holdAtNewHost`),
 *    so the boundary policy judges where a navigation goes and not only where it starts.
 *
 * The computer runs with private hosts ALLOWED, because both servers are on this machine's loopback.
 * What stays refused under that opt-in is the metadata endpoint, by address and by name — so that is
 * what these send hops to. The production floor (loopback, private ranges, internal names, no opt-in)
 * is the table in `server/tests/computer-target.test.ts`, and was measured on a Docker network.
 * `127.0.0.1` and `localhost` are two hosts to the browser and to the gateway, which is what the hold
 * tests use.
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

const BOT = "boundaries-bot";
const TOKEN = "test-computer-token";
let base = "";
let child: ReturnType<typeof Bun.spawn> | null = null;
let profilesDir = "";
let workspaceDir = "";

/** The counting host. Every request it answers is recorded, so "never contacted" is checkable. */
let site: ReturnType<typeof Bun.serve> | null = null;
const received: string[] = [];
const onLoopback = (path: string) => `http://127.0.0.1:${site?.port}${path}`;
const onLocalhost = (path: string) => `http://localhost:${site?.port}${path}`;

function serveCountingSite() {
  return Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      received.push(`${url.hostname}${url.pathname}`);
      const to = url.searchParams.get("to") ?? "/";
      const html = (body: string) =>
        new Response(`<!doctype html><html><body>${body}</body></html>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      if (url.pathname === "/redirect") {
        return new Response(null, { status: 302, headers: { location: to } });
      }
      if (url.pathname === "/script") {
        return html(`<script>location.href = ${JSON.stringify(to)};</script>`);
      }
      if (url.pathname === "/popup") {
        return html(
          `<h1>${VISIBLE_TEXT}</h1><script>window.open(${JSON.stringify(to)});</script>`,
        );
      }
      if (url.pathname === "/frame") {
        return html(`<h1>${VISIBLE_TEXT}</h1><iframe src="${to}"></iframe>`);
      }
      return html(`<h1>${VISIBLE_TEXT}</h1><p>${url.pathname}</p>`);
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

async function post(
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": BOT,
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

const noteCodes = (body: Record<string, unknown>) =>
  ((body.notes as { code: string }[] | undefined) ?? []).map(
    (entry) => entry.code,
  );

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  site = serveCountingSite();
  profilesDir = await mkdtemp(join(tmpdir(), "laf-bound-profiles-"));
  workspaceDir = await mkdtemp(join(tmpdir(), "laf-bound-workspace-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      PROFILES_DIR: profilesDir,
      WORKSPACE_DIR: workspaceDir,
      AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
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
  await site?.stop(true);
  if (profilesDir) await rm(profilesDir, { recursive: true, force: true });
  if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true });
});

describe.skipIf(!HAS_BROWSER)("every hop, before it is sent", () => {
  test("a redirect to the metadata address is refused at the hop, and names only origins", async () => {
    received.length = 0;
    const refused = await post("/navigate", {
      url: onLoopback(
        "/redirect?to=http://169.254.169.254/latest/meta-data/iam/",
      ),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("laf:navigation_refused");
    expect(refused.body.refused).toEqual({
      origin: "http://169.254.169.254",
      redirectedFrom: `http://127.0.0.1:${site?.port}`,
    });
    // The path a redirecting page chose is its own business, and never in the answer.
    expect(JSON.stringify(refused.body)).not.toContain("meta-data");

    // AND THE BOT GOES ON WORKING: the next navigation to an allowed page answers.
    const next = await post("/navigate", { url: onLoopback("/after") });
    expect(next.status).toBe(200);
    expect(String(next.body.text)).toContain(VISIBLE_TEXT);
  });

  test("so is a redirect to the metadata service by name", async () => {
    const refused = await post("/navigate", {
      url: onLoopback(
        "/redirect?to=http://metadata.google.internal/computeMetadata/v1/",
      ),
    });
    expect(refused.status).toBe(403);
    expect(
      (refused.body.refused as { origin?: string } | undefined)?.origin,
    ).toBe("http://metadata.google.internal");
  });

  test("an address refused outright never reaches the browser", async () => {
    for (const url of [
      "http://169.254.169.254/",
      "file:///etc/passwd",
      "data:text/html,<h1>x</h1>",
      "javascript:alert(1)",
    ]) {
      const refused = await post("/navigate", { url });
      expect([url, refused.status]).toEqual([url, 403]);
    }
  });

  test("a frame pointed at the metadata address is refused and reported, and the page still opens", async () => {
    const opened = await post("/navigate", {
      url: onLoopback("/frame?to=http://169.254.169.254/latest/meta-data/"),
    });
    expect(opened.status).toBe(200);
    expect(String(opened.body.text)).toContain(VISIBLE_TEXT);
    expect(noteCodes(opened.body)).toContain("laf:navigation_refused");
  });
});

describe.skipIf(!HAS_BROWSER)("a hop to a host nobody judged", () => {
  test("is handed back, and the host is never contacted", async () => {
    received.length = 0;
    const held = await post("/navigate", {
      url: onLoopback(`/redirect?to=${onLocalhost("/held-redirect")}`),
      holdAtNewHost: true,
    });
    expect(held.status).toBe(200);
    expect(held.body.redirect).toEqual({
      to: onLocalhost("/held-redirect"),
      from: onLoopback(`/redirect?to=${onLocalhost("/held-redirect")}`),
    });
    // Nothing loaded, and the tab is on nothing rather than on Chromium's error page.
    expect(held.body.text).toBe("");
    expect(held.body.url).toBe("about:blank");
    expect(received).toEqual(["127.0.0.1/redirect"]);
  });

  test("including a page's own script leaving for it while the page loads", async () => {
    received.length = 0;
    const held = await post("/navigate", {
      url: onLoopback(`/script?to=${onLocalhost("/held-script")}`),
      holdAtNewHost: true,
    });
    expect(held.status).toBe(200);
    const redirect = held.body.redirect as Record<string, string>;
    expect(redirect.to).toBe(onLocalhost("/held-script"));
    // The page that sent it, and the Referer Chromium was about to send with it.
    expect(redirect.from).toBe(
      onLoopback(`/script?to=${onLocalhost("/held-script")}`),
    );
    expect(redirect.referer).toBe(`http://127.0.0.1:${site?.port}/`);
    expect(received).not.toContain("localhost/held-script");
  });

  test("from a tab already on an error page, the hold still leaves it blank and the next call is not interrupted", async () => {
    // A popup whose first request is refused is adopted as the Bot's tab, on Chromium's error page.
    const opened = await post("/navigate", {
      url: onLoopback("/popup?to=http://169.254.169.254/"),
    });
    expect(opened.status).toBe(200);
    await Bun.sleep(500);
    const onErrorPage = await post("/snapshot", {});
    expect(String(onErrorPage.body.url)).toStartWith("chrome-error:");

    // Measured before the fix: this ended on `chrome-error://`, because the old error page satisfied
    // the wait for the new one, and `about:blank` raced the new one in.
    const held = await post("/navigate", {
      url: onLoopback(`/redirect?to=${onLocalhost("/held-from-error")}`),
      holdAtNewHost: true,
    });
    expect(held.body.url).toBe("about:blank");
    const next = await post("/navigate", {
      url: onLocalhost("/held-from-error"),
      holdAtNewHost: true,
    });
    expect([next.status, next.body.url]).toEqual([
      200,
      onLocalhost("/held-from-error"),
    ]);
  });

  test("a redirect within the same host is followed without a second look", async () => {
    const followed = await post("/navigate", {
      url: onLoopback("/redirect?to=/same-host"),
      holdAtNewHost: true,
    });
    expect(followed.status).toBe(200);
    expect(followed.body.url).toBe(onLoopback("/same-host"));
    expect(followed.body.redirect).toBeUndefined();
  });

  test("the hop asked for next is sent with the Referer it was carrying", async () => {
    const asked = await post("/navigate", {
      url: onLocalhost("/asked-for-next"),
      referer: `http://127.0.0.1:${site?.port}/`,
      holdAtNewHost: true,
    });
    expect(asked.status).toBe(200);
    expect(String(asked.body.text)).toContain("/asked-for-next");
  });

  test("a caller that does not ask for holds gets the redirect followed, as before", async () => {
    received.length = 0;
    const followed = await post("/navigate", {
      url: onLoopback(`/redirect?to=${onLocalhost("/followed")}`),
    });
    expect(followed.status).toBe(200);
    expect(followed.body.url).toBe(onLocalhost("/followed"));
    expect(received).toContain("localhost/followed");
  });
});
