import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  FRAME_BUTTON,
  RELABEL_AFTER,
  RELABEL_BEFORE,
  serveFixture,
  VISIBLE_TEXT,
} from "./fixture-site";

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
 *  - A CONTROL IS HELD TO THE LABEL IT WAS JUDGED ON: "저장" renamed "결제하기" under the same ref is
 *    refused with the name it has now.
 *  - A RESET TAKES THE BOT'S DIRECTORY WITH IT, and does not write it back.
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
/**
 * Long enough to snapshot the old label before it changes: `/navigate` waits for the page to settle
 * (load, then network idle), and a 400ms swap had happened before the snapshot was taken.
 */
const RELABEL_AFTER_MS = 2_000;

let base = "";
let fixture: ReturnType<typeof serveFixture> | null = null;
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

type SnapshotElement = { ref: string; role: string; name: string };

async function snapshot(): Promise<{
  snapshotId: number;
  elements: SnapshotElement[];
}> {
  const result = await post("/snapshot", {});
  return result.body as { snapshotId: number; elements: SnapshotElement[] };
}

const noteCodes = (body: Record<string, unknown>) =>
  ((body.notes as { code: string }[] | undefined) ?? []).map(
    (entry) => entry.code,
  );

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  fixture = serveFixture();
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
  fixture?.stop();
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

describe.skipIf(!HAS_BROWSER)("holding a click to its label", () => {
  test("a control the page renamed after the snapshot is refused", async () => {
    const opened = await post("/navigate", {
      url: `${fixture?.url}relabel?after=${RELABEL_AFTER_MS}`,
    });
    expect(opened.status).toBe(200);

    const shot = await snapshot();
    const button = shot.elements.find(
      (element) => element.name === RELABEL_BEFORE,
    );
    if (!button) {
      throw new Error(
        `the snapshot had no ${RELABEL_BEFORE} button: ${shot.elements
          .map((element) => element.name)
          .join(" | ")}`,
      );
    }

    // Let the page swap the label under the ref.
    await Bun.sleep(RELABEL_AFTER_MS + 300);

    // The gateway sends `element` as the name it judged; here that is the OLD name.
    const refused = await post("/click", {
      ref: button.ref,
      snapshotId: shot.snapshotId,
      element: { role: button.role, name: RELABEL_BEFORE },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("laf:label_changed");

    // And asking did not spend the ref: held to the name the control has now, the same ref lands.
    // (The first attempt at this read the name with an aria snapshot, which replaced the snapshot the
    // ref resolves against — this click then answered `laf:stale_refs`.)
    const clicked = await post("/click", {
      ref: button.ref,
      snapshotId: shot.snapshotId,
      element: { role: button.role, name: RELABEL_AFTER },
    });
    expect(clicked.status).toBe(200);
  });

  /*
   * MEASURED 2026-09-14, the real container through the server's routes: a button the page hid after
   * the snapshot answered `laf:label_changed` in 31 ms, because the role engine the hold asks leaves
   * hidden nodes out — and the Bot was told the control had been renamed. It had not; it was gone.
   */
  test("a control the page hid after the snapshot is not called renamed", async () => {
    const opened = await post("/navigate", {
      url: `${fixture?.url}relabel?after=${RELABEL_AFTER_MS}&hide`,
    });
    expect(opened.status).toBe(200);
    const shot = await snapshot();
    const button = shot.elements.find(
      (element) => element.name === RELABEL_BEFORE,
    );
    if (!button) {
      throw new Error(
        `the snapshot had no ${RELABEL_BEFORE} button: ${shot.elements
          .map((element) => element.name)
          .join(" | ")}`,
      );
    }
    await Bun.sleep(RELABEL_AFTER_MS + 300);

    const started = Date.now();
    const refused = await post("/click", {
      ref: button.ref,
      snapshotId: shot.snapshotId,
      element: { role: button.role, name: RELABEL_BEFORE },
    });
    expect([refused.status, refused.body.code]).toEqual([
      409,
      "laf:element_not_actionable",
    ]);
    // Refused on the question, not after Playwright's action timeout waiting for it to reappear.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a control that kept its label is acted on, on the page and inside a frame", async () => {
    const opened = await post("/navigate", { url: fixture?.url });
    expect(opened.status).toBe(200);
    const shot = await snapshot();
    // By name, not by ref shape: every ref carries a frame prefix, the page's own as well.
    const inFrame = shot.elements.find(
      (element) => element.name === FRAME_BUTTON,
    );
    const onPage = shot.elements.find(
      (element) => element.role === "textbox" && element.name !== "",
    );
    if (!inFrame || !onPage) {
      throw new Error(
        `the fixture should expose a button on the page and a control in its frame: ${shot.elements
          .map((element) => `${element.ref}:${element.role}:${element.name}`)
          .join(" | ")}`,
      );
    }
    // A text field, so the value typed into it is not mistaken for its name.
    const typed = await post("/type", {
      ref: onPage.ref,
      snapshotId: shot.snapshotId,
      text: '따옴표 " 가 든 값',
      element: { role: onPage.role, name: onPage.name },
    });
    expect([onPage.name, typed.status, typed.body.error]).toEqual([
      onPage.name,
      200,
      undefined,
    ]);
    const clicked = await post("/click", {
      ref: inFrame.ref,
      snapshotId: shot.snapshotId,
      element: { role: inFrame.role, name: inFrame.name },
    });
    expect([inFrame.ref, clicked.status, clicked.body.error]).toEqual([
      inFrame.ref,
      200,
      undefined,
    ]);
  });

  test("a click with no judged label is not held to one (an older gateway)", async () => {
    const opened = await post("/navigate", { url: fixture?.url });
    expect(opened.status).toBe(200);
    const shot = await snapshot();
    const first = shot.elements[0];
    if (!first) throw new Error("the fixture page exposed no elements");

    const clicked = await post("/click", {
      ref: first.ref,
      snapshotId: shot.snapshotId,
    });
    expect(clicked.status).toBe(200);
  });
});

describe.skipIf(!HAS_BROWSER)("a reset", () => {
  test("closes the browser and takes the shared profile with it, for good", async () => {
    const opened = await post("/navigate", {
      url: onLoopback("/before-reset"),
    });
    expect(opened.status).toBe(200);
    /*
     * ONE PROFILE, NOT ONE PER BOT (2026-09-16). This used to look for `<profilesDir>/<BOT>` and it
     * was right to: the cookie jar was the Bot's. It is the deployment's now, so the directory the
     * browser opened is the shared one and the answer says whose logins a reset takes.
     */
    expect(existsSync(join(profilesDir, "shared.profile"))).toBe(true);
    expect(existsSync(join(profilesDir, BOT))).toBe(false);

    const reset = await post("/computers/reset", {});
    expect(reset.body).toEqual({
      reset: true,
      botId: BOT,
      scope: "deployment",
    });

    // Measured before the fix that came first: `control.json` was written back into the deleted
    // directory, and `/computers` went on listing the Bot. Both still have to be true of the shared
    // profile — and the Bot's own state, which now lives outside it, has to go with it.
    expect(existsSync(join(profilesDir, "shared.profile"))).toBe(false);
    expect(existsSync(join(profilesDir, "bot.state", BOT))).toBe(false);
    const listed = (await (
      await fetch(`${base}/computers`, {
        headers: { "x-openbot-computer-token": TOKEN },
      })
    ).json()) as { computers: { botId: string }[] };
    expect(listed.computers.map((entry) => entry.botId)).not.toContain(BOT);
  });
});
