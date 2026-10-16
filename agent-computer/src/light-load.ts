/**
 * What the Bot's browser does not download: sound and video, and what a short list of ad hosts
 * sends. Nothing it reads is among them — the Bot reads a page's text and its controls, and a person
 * watching sees the page — and fetching them is CPU the VM pays on every page.
 *
 * Measured 2026-10-16 on a 1-OCPU test VM, inside the agent-computer container, opening 네이버,
 * 네이버 뉴스, 다음, 대한민국 정책브리핑 and 스마트스토어 six times each way, beside a session that
 * pauses documents as the navigation guard does: 21.7 CPU-seconds before, 17.4 after (−20 %), the
 * ranges apart; 다음 −41 %, 네이버 −21 %. No page that opened before failed to open after, the
 * sign-in pages of the catalogue's sites included (`docs/laf/browser-limits.md` has the table).
 * Skipping images as well gave nothing, measured the same day.
 *
 * TALKS TO CHROMIUM ON THE BROWSER TARGET, as the navigation guard does (`navigation-guard.ts`), so
 * every tab, popup and frame of every browser — the main one and each background one — is covered
 * from its first request, and only the requests that match are paused at all: everything else goes
 * out untouched, without a round trip through this process.
 *
 * NEVER A DOCUMENT. A page, a frame or a link a Bot follows is the navigation guard's to judge and
 * nobody else's; an ad's click-through (`adcr.naver.com`) is a document, so it still opens. Only
 * what a page pulls in beside its document is skipped here.
 *
 * FONTS ARE KEPT. The image has a Korean font of its own (NanumGothic, the Dockerfile), and 네이버
 * with its web fonts skipped still showed its Korean whole on the screen — but skipping them saved
 * nothing that stood apart from one run to the next, and a page whose icons are a font draws them as
 * words or boxes without it, on the screen a person watches.
 *
 * FAILS OPEN. This is a saving, not a boundary: a browser on which it could not be installed browses
 * as it did before, and the launch goes on.
 */
import type { BrowserContext, CDPSession } from "playwright";
import { hostBelongsTo } from "../../shared/sites/catalogue";
import { log } from "./log";

/**
 * The ad hosts whose requests are skipped. A host here covers its subdomains, matched at a dot.
 *
 * HOW IT WAS CHOSEN: every host here served ads or ad measurement on the heavy pages measured on
 * 2026-10-16 (네이버, 네이버 뉴스, 다음, 대한민국 정책브리핑), and none is a host any site in
 * `shared/sites/catalogue.ts` signs in or works on (`tests/light-load.test.ts` walks that table).
 * Ad hosts only, on purpose. Analytics and tag managers are not here: a page that waits for one to
 * call back before it moves on (`eventCallback`, `hitCallback`) never moves on when the script
 * never loads, and a sign-up or a payment is exactly the page that does that. Social sign-in SDKs
 * (`connect.facebook.net`, 카카오's) are not here either: they are the 로그인 button.
 *
 * Kept short on purpose: a long list copied from a blocker is a list of hosts nobody here has seen,
 * any of which may be somebody's working page.
 */
export const SKIPPED_HOSTS: readonly string[] = [
  // 네이버's display ads: the ad server and the ads it streams (`siape.veta`, `nam.veta`).
  "veta.naver.com",
  // 다음's ads: the ad API and its id sync.
  "ads-api.daum.net",
  "ad.daum.net",
  // Google's ads: the ad server, the ad frames and their fraud checks.
  "doubleclick.net",
  "googlesyndication.com",
  "adtrafficquality.google",
  // Recommended-article ads under news stories.
  "dable.io",
];

/**
 * The kinds of request skipped from a listed host. Every kind but a document, whose requests the
 * navigation guard pauses (it asks for `Document` alone): two sessions never pause the same request.
 *
 * Only kinds Chromium's Fetch filter knows. One it does not (`TextTrack`, `Prefetch`, `WebSocket`,
 * measured on 151.0.7922.34) fails the whole `Fetch.enable`, and with it every skip — which
 * `tests/light-load.test.ts` would see, since nothing would be skipped.
 */
const HOST_KINDS = [
  "Stylesheet",
  "Image",
  "Font",
  "Script",
  "XHR",
  "Fetch",
  "EventSource",
  "Ping",
  "Other",
] as const;

/** Whatever its host: sound and video. A Bot reads neither, and a playing video is CPU every second. */
const ALWAYS_SKIPPED_KINDS = ["Media"] as const;

/** Whether a request of this kind, to this address, is skipped. Chromium's names for the kinds. */
export function isSkipped(url: string, resourceType: string): boolean {
  if ((ALWAYS_SKIPPED_KINDS as readonly string[]).includes(resourceType))
    return true;
  if (!(HOST_KINDS as readonly string[]).includes(resourceType)) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return hostBelongsTo(host, SKIPPED_HOSTS);
}

type FetchPattern = { urlPattern: string; resourceType: string };

/**
 * What Chromium is asked to pause. A wildcard pattern matches more than the host — `*` crosses
 * slashes and dots, so `doubleclick.network` and a listed host inside another address's query match
 * too — and {@link isSkipped} decides each paused request again by its parsed host, letting those go.
 */
export function skipPatterns(): FetchPattern[] {
  const patterns: FetchPattern[] = ALWAYS_SKIPPED_KINDS.map((kind) => ({
    urlPattern: "*",
    resourceType: kind,
  }));
  for (const host of SKIPPED_HOSTS) {
    for (const resourceType of HOST_KINDS) {
      // Open at the end, so an address with a port (`host:8443/`) is paused as well.
      patterns.push({ urlPattern: `*://${host}*`, resourceType });
      patterns.push({ urlPattern: `*://*.${host}*`, resourceType });
    }
  }
  return patterns;
}

/**
 * Skip what {@link isSkipped} names in every tab of this browser, from now on. The session it
 * returns lives as long as the browser; null where it could not be installed.
 */
export async function skipUnreadRequests(
  context: BrowserContext,
): Promise<CDPSession | null> {
  const browser = context.browser();
  if (!browser) return null;
  let session: CDPSession | undefined;
  try {
    session = await browser.newBrowserCDPSession();
    const paused = session;
    paused.on("Fetch.requestPaused", (event) => {
      // Every paused request is answered one way or the other, or its page waits for it for ever.
      // Gone already — the tab closed, the browser is going — needs no answer.
      const answer = isSkipped(event.request.url, event.resourceType)
        ? paused.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "BlockedByClient",
          })
        : paused.send("Fetch.continueRequest", { requestId: event.requestId });
      void answer.catch(() => undefined);
    });
    await paused.send("Fetch.enable", {
      patterns: skipPatterns().map((pattern) => ({
        ...pattern,
        requestStage: "Request",
      })) as never,
    });
    return paused;
  } catch (error) {
    log.warn("light_load_unavailable", {
      note: "the browser downloads everything a page asks for",
      error: error instanceof Error ? error.message : String(error),
    });
    await session?.detach().catch(() => undefined);
    return null;
  }
}
