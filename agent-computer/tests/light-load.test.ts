import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page, type Request } from "playwright";
import { BUSINESS_SITES } from "../../shared/sites/catalogue";
import { isSkipped, skipUnreadRequests } from "../src/light-load";
import { createProfiles } from "../src/profiles";

/**
 * What the Bot's browser does not download (light-load.ts): sound and video from anywhere, and what
 * a page pulls in from a short list of ad hosts — never a document, never a font, never a host a site
 * in the catalogue works on.
 *
 * The browser half runs against a real Chromium and a server here that counts what it is asked: a
 * skipped request must not reach it at all. An ad host is pointed at that server by the browser's own
 * resolver (`--host-resolver-rules`), so the addresses are the real names and nothing leaves the
 * machine. Skipped where Playwright has no browser downloaded, like korean-sites.test.ts.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe("which requests are skipped", () => {
  test.each([
    ["a video, anywhere", "https://www.naver.com/clip.mp4", "Media", true],
    [
      "a script from an ad host",
      "https://securepubads.g.doubleclick.net/tag/js/gpt.js",
      "Script",
      true,
    ],
    ["네이버's ad server", "https://siape.veta.naver.com/fxshow", "XHR", true],
    [
      "an ad pixel",
      "https://pagead2.googlesyndication.com/pagead/1x1.gif",
      "Image",
      true,
    ],
    [
      "an ad host's document",
      "https://googleads.g.doubleclick.net/pagead/ads",
      "Document",
      false,
    ],
    [
      "a font from the page's own host",
      "https://ssl.pstatic.net/font.woff2",
      "Font",
      false,
    ],
    [
      "a script from the page's own host",
      "https://www.naver.com/main.js",
      "Script",
      false,
    ],
    [
      "a host that only ends in the same letters",
      "https://notdoubleclick.net/a.js",
      "Script",
      false,
    ],
    [
      "a listed host inside a query",
      "https://www.korea.kr/a.js?u=x.doubleclick.net/",
      "Script",
      false,
    ],
  ] as const)("%s", (_name, url, kind, skipped) => {
    expect(isSkipped(url, kind)).toBe(skipped);
  });

  // Every host a catalogue site signs in or works on, each a test of its own.
  const siteHosts = BUSINESS_SITES.flatMap((site) => [
    ...site.hosts,
    ...(site.signInHosts ?? []),
    new URL(site.loginUrl).hostname,
  ]);
  test.each([...new Set(siteHosts)])("nothing from %s is skipped", (host) => {
    for (const kind of ["Script", "XHR", "Fetch", "Image", "Stylesheet"]) {
      expect(isSkipped(`https://${host}/app.js`, kind)).toBe(false);
    }
  });
});

/** A server that answers everything and remembers which paths it was asked for. */
function serveCounting() {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      seen.push(url.pathname);
      if (url.pathname === "/page") {
        const port = url.port;
        return new Response(
          `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>가벼운 페이지</title>
<style>@font-face{font-family:Own;src:url(/own.woff2)}body{font-family:Own}</style></head>
<body><p>오늘 주문 3건</p>
<video src="/clip.mp4" autoplay muted></video>
<script src="/own.js?u=x.doubleclick.net/"></script>
<script src="http://ads.doubleclick.net:${port}/ad.js"></script>
<img src="http://ads.doubleclick.net:${port}/pixel.gif">
</body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname === "/landing")
        return new Response("<!doctype html><title>광고 랜딩</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      return new Response("", { status: 200 });
    },
  });
  return {
    port: server.port,
    seen,
    stop: () => server.stop(true),
  };
}

/** The request for a path, once it has finished one way or the other. */
function settled(page: Page, path: string): Promise<Request> {
  return new Promise((resolve) => {
    const hear = (request: Request) => {
      if (new URL(request.url()).pathname === path) resolve(request);
    };
    page.on("requestfailed", hear);
    page.on("requestfinished", hear);
  });
}

describe.skipIf(!HAS_BROWSER)("the browser with the rule installed", () => {
  let site: ReturnType<typeof serveCounting>;
  let browser: Browser;

  beforeAll(async () => {
    site = serveCounting();
    browser = await chromium.launch({
      args: [`--host-resolver-rules=MAP ads.doubleclick.net 127.0.0.1`],
    });
  });

  afterAll(async () => {
    await browser?.close();
    site?.stop();
  });

  test("an ad host's script and pixel never leave; the page's own script and font do", async () => {
    const context = await browser.newContext();
    try {
      expect(await skipUnreadRequests(context)).not.toBeNull();
      const page = await context.newPage();
      const ad = settled(page, "/ad.js");
      const pixel = settled(page, "/pixel.gif");
      const own = settled(page, "/own.js");
      const font = settled(page, "/own.woff2");
      await page.goto(`http://127.0.0.1:${site.port}/page`);
      expect((await ad).failure()?.errorText).toContain("BLOCKED_BY_CLIENT");
      expect((await pixel).failure()?.errorText).toContain("BLOCKED_BY_CLIENT");
      // Paused because the ad host is in its query, and let go because its host is the page's own.
      expect((await own).failure()).toBeNull();
      expect((await font).failure()).toBeNull();
      expect(site.seen).toContain("/own.js");
      expect(site.seen).toContain("/own.woff2");
      expect(site.seen).not.toContain("/ad.js");
      expect(site.seen).not.toContain("/pixel.gif");
    } finally {
      await context.close();
    }
  }, 20_000);

  test("an ad host opened as a page still opens", async () => {
    const context = await browser.newContext();
    try {
      expect(await skipUnreadRequests(context)).not.toBeNull();
      const page = await context.newPage();
      const response = await page.goto(
        `http://ads.doubleclick.net:${site.port}/landing`,
      );
      expect(response?.status()).toBe(200);
      expect(await page.title()).toBe("광고 랜딩");
    } finally {
      await context.close();
    }
  }, 20_000);
});

describe.skipIf(!HAS_BROWSER)("the deployment's browser", () => {
  let site: ReturnType<typeof serveCounting>;
  let root: string;

  beforeAll(async () => {
    site = serveCounting();
    root = await mkdtemp(join(tmpdir(), "laf-light-load-"));
  });

  afterAll(async () => {
    site?.stop();
    await rm(root, { recursive: true, force: true });
  });

  // Through `createProfiles`, which every browser — the main one and each background one — is
  // started by: the rule is on from the first page, with nothing for a caller to remember.
  test("never downloads a page's video", async () => {
    const profiles = createProfiles(root, { idleCloseMs: 0 });
    try {
      const page = await profiles.page("light-load-bot");
      const clip = settled(page, "/clip.mp4");
      const own = settled(page, "/own.js");
      await page.goto(`http://127.0.0.1:${site.port}/page`);
      expect((await clip).failure()?.errorText).toContain("BLOCKED_BY_CLIENT");
      expect((await own).failure()).toBeNull();
      expect(site.seen).not.toContain("/clip.mp4");
    } finally {
      await profiles.closeAll();
    }
  }, 30_000);
});
