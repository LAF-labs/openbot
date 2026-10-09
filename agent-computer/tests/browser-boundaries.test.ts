import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  BOXED_BUTTON,
  FRAME_BUTTON,
  HEADLINE_LINKS,
  HEADLINE_TREE_NAMES,
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
 *  - THE DEPLOYMENT'S OWN APP IS NEVER OPENED (`shared/net/own-addresses.ts`): named outright, reached
 *    by a redirect — a provider's, back to the app's sign-in callback, is the hop a session would be
 *    set on — or pointed at by a frame. `app` below stands for it and counts what it is asked.
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
/**
 * For a test that opens real pages and waits for each to settle. One `/navigate` waits for the load
 * and then for the network to go quiet, about a second a page, so the test that opens five pages was
 * five and a half seconds alone, against Bun's default of five. It timed out on CI with four workers
 * sharing the runner. The timeout also killed the computer this file had started, so the three
 * tests after it failed on a refused connection.
 */
const PAGE_WALK_MS = 30_000;

let base = "";
let fixture: ReturnType<typeof serveFixture> | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;
let profilesDir = "";
let workspaceDir = "";

/** The counting host. Every request it answers is recorded, so "never contacted" is checkable. */
let site: ReturnType<typeof Bun.serve> | null = null;
const received: string[] = [];
/** The deployment's own app, as far as the computer is told: it counts what reaches it. */
let app: ReturnType<typeof Bun.serve> | null = null;
const appReceived: string[] = [];
const onApp = (path: string) => `http://127.0.0.1:${app?.port}${path}`;
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
  app = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      appReceived.push(`${url.pathname}${url.search}`);
      return new Response("<!doctype html><h1>the app</h1>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
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
      // A laptop has no host to hold the browser's egress rules (egress-guard.ts).
      AGENT_COMPUTER_EGRESS_FIREWALL: "off",
      // The deployment's own app, in the server's own variables. All four are set, so nothing a
      // developer's own `.env` names is taken for this run's app.
      BETTER_AUTH_URL: `http://127.0.0.1:${app.port}`,
      TRUSTED_ORIGINS: `http://127.0.0.1:${app.port}`,
      PUBLIC_ORIGIN: "",
      LAF_OIDC_ISSUER: "",
    },
    /*
     * NOT A PIPE NOBODY READS. The computer logs a line for every request and every refusal, and a
     * pipe holds some tens of kilobytes: with four more tests in this file the log outgrew it, the
     * computer blocked on its next line, and every test after that point failed with a closed socket
     * (2026-10-03 — fifteen tests fitted, nineteen did not).
     */
    stdout: "ignore",
    stderr: "ignore",
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
  await app?.stop(true);
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

/*
 * A person answers a Bot's questions in the app and signs in to it with the accounts this browser
 * holds logins for. The private-host opt-in is ON in this run and the app is a local address: the
 * opt-in opens every other local page here and does not open that one.
 */
describe.skipIf(!HAS_BROWSER)("the deployment's own app, at every hop", () => {
  test("named outright it never reaches the browser, and the answer says which refusal", async () => {
    appReceived.length = 0;
    const refused = await post("/navigate", {
      url: onApp("/channel/channel_1"),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("laf:own_address_refused");
    expect(refused.body.refused).toEqual({
      origin: `http://127.0.0.1:${app?.port}`,
    });
    expect(appReceived).toEqual([]);
  });

  test("a redirect back to its sign-in callback is refused at the hop: the app never hears it", async () => {
    appReceived.length = 0;
    received.length = 0;
    const callback = onApp("/api/auth/callback/naver?code=one-time-code");
    const refused = await post("/navigate", {
      url: onLoopback(`/redirect?to=${encodeURIComponent(callback)}`),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("laf:own_address_refused");
    expect(refused.body.refused).toEqual({
      origin: `http://127.0.0.1:${app?.port}`,
      redirectedFrom: `http://127.0.0.1:${site?.port}`,
    });
    // The redirecting host was asked; the app was not, so no session was ever set on a reply.
    expect(received).toEqual(["127.0.0.1/redirect"]);
    expect(appReceived).toEqual([]);
    // Origins only: the code a provider put in the address is nowhere in the answer.
    expect(JSON.stringify(refused.body)).not.toContain("one-time-code");

    // Another local page opens as before, under the same opt-in.
    const next = await post("/navigate", { url: onLoopback("/after") });
    expect(next.status).toBe(200);
    expect(String(next.body.text)).toContain(VISIBLE_TEXT);
  });

  test("a frame pointed at it is refused and noted under the same code, and the page still opens", async () => {
    appReceived.length = 0;
    const opened = await post("/navigate", {
      url: onLoopback(`/frame?to=${encodeURIComponent(onApp("/"))}`),
    });
    expect(opened.status).toBe(200);
    expect(String(opened.body.text)).toContain(VISIBLE_TEXT);
    expect(noteCodes(opened.body)).toContain("laf:own_address_refused");
    expect(appReceived).toEqual([]);
  });

  test("a script that leaves for it is stopped the same way", async () => {
    appReceived.length = 0;
    const left = await post("/navigate", {
      url: onLoopback(`/script?to=${encodeURIComponent(onApp("/approve/1"))}`),
    });
    expect(left.status).toBe(403);
    expect(left.body.code).toBe("laf:own_address_refused");
    expect(appReceived).toEqual([]);
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
  test(
    "a control the page renamed after the snapshot is refused",
    async () => {
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
    },
    PAGE_WALK_MS,
  );

  /*
   * MEASURED 2026-09-14, the real container through the server's routes: a button the page hid after
   * the snapshot answered `laf:label_changed` in 31 ms, because the role engine the hold asks leaves
   * hidden nodes out — and the Bot was told the control had been renamed. It had not; it was gone.
   */
  test(
    "a control the page hid after the snapshot is not called renamed",
    async () => {
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
    },
    PAGE_WALK_MS,
  );

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

  /*
   * MEASURED 2026-10-04 on five Korean pages: every one of 190 links whose name the AI tree prints
   * beneath it was listed nameless, and the hold, asked about the empty name the gateway judged,
   * refused every click on one — the role engine calls each link by its words. Named by the words
   * the tree printed beneath them, 186 were held; the four left were a table's caption and
   * decorations or words the tree prints differently from the browser. Named by the page, the same
   * way the role engine names them (`page-names.ts`), every one not hidden from the accessibility
   * tree was held exactly — 203 of 203 on the same five pages that evening.
   */
  test(
    "a link the tree left nameless is held to the name the page gives it, and can be clicked",
    async () => {
      for (const [key, name] of Object.entries(HEADLINE_LINKS)) {
        const opened = await post("/navigate", {
          url: `${fixture?.url}headlines`,
        });
        expect(opened.status).toBe(200);
        const shot = await snapshot();
        const link = shot.elements.find(
          (element) => element.role === "link" && element.name === name,
        );
        if (!link) {
          throw new Error(
            `the snapshot had no link named ${name}: ${shot.elements
              .map(
                (element) => `${element.ref}:${element.role}:${element.name}`,
              )
              .join(" | ")}`,
          );
        }
        // What the list used to call it, which the browser does not: blank before pull request 65,
        // the tree's words after it — a ★ the browser leaves out, a space the browser does not put in.
        const before =
          key in HEADLINE_TREE_NAMES
            ? HEADLINE_TREE_NAMES[key as keyof typeof HEADLINE_TREE_NAMES]
            : key === "headline"
              ? ""
              : undefined;
        if (before !== undefined) {
          const refused = await post("/click", {
            ref: link.ref,
            snapshotId: shot.snapshotId,
            element: { role: "link", name: before },
          });
          // Refused either way. The ★ is found by the hold's second question, which counts what is
          // hidden from the accessibility tree, so that click is refused as one on a hidden control.
          expect([key, refused.status, refused.body.code]).toEqual([
            key,
            409,
            key === "decorated"
              ? "laf:element_not_actionable"
              : "laf:label_changed",
          ]);
        }
        const clicked = await post("/click", {
          ref: link.ref,
          snapshotId: shot.snapshotId,
          element: { role: link.role, name: link.name },
        });
        expect([name, clicked.status, clicked.body.code]).toEqual([
          name,
          200,
          undefined,
        ]);
        // Landed where that link goes: the click reached the link it was judged as.
        const landed = await post("/snapshot", {});
        expect(String(landed.body.url)).toEndWith(`/landed-${key}`);
      }
    },
    PAGE_WALK_MS,
  );

  /*
   * NEVER A FIELD'S CONTENTS IN A NAME. The browser names a button wrapped around a search box by what
   * is typed into the box as well; the page's name for it here leaves the box out, so a value a person
   * typed never reaches the list as a label. The browser's name then differs from the listed one, and
   * a click held to the listed name is refused as renamed — on purpose: a refusal, never the value.
   */
  test("a button around a search box is not named by what was typed into the box", async () => {
    const typedText = "hunter2-무선마우스";
    const opened = await post("/navigate", {
      url: `${fixture?.url}headlines`,
    });
    expect(opened.status).toBe(200);
    const first = await snapshot();
    const box = first.elements.find(
      (element) =>
        element.role === "textbox" && element.name === BOXED_BUTTON.box,
    );
    if (!box) throw new Error("the fixture's search box was not listed");
    const typed = await post("/type", {
      ref: box.ref,
      snapshotId: first.snapshotId,
      text: typedText,
      element: { role: box.role, name: box.name },
    });
    expect(typed.status).toBe(200);

    const shot = await snapshot();
    const button = shot.elements.find((element) => element.role === "button");
    expect(button?.name).toBe(BOXED_BUTTON.word);
    expect(
      shot.elements.filter((element) => element.name.includes("hunter2")),
    ).toEqual([]);
    const refused = await post("/click", {
      ref: button?.ref,
      snapshotId: shot.snapshotId,
      element: { role: "button", name: BOXED_BUTTON.word },
    });
    expect([refused.status, refused.body.code]).toEqual([
      409,
      "laf:label_changed",
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
