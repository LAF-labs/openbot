/**
 * Every document the Bot's browser is about to request, judged before the request leaves.
 *
 * THE SERVER JUDGES THE ADDRESS A BOT ASKS FOR, AND ONLY THAT ONE. Measured 2026-09-10 (audit A3):
 * `https://httpbin.org/redirect-to?url=http://127.0.0.1:4100/health` was allowed — httpbin is a
 * public host — and the browser followed the 302 to this deployment's own loopback and read the
 * page. A public redirector was one hop from the metadata endpoint, Postgres and the credential
 * vault, because nothing after `goto` ever looked at where the browser went.
 *
 * NOT `context.route`. That was the first attempt, and it does not see a redirect at all: Playwright
 * continues every redirected request itself without calling the route handler (`if (redirectedFrom
 * || …) Fetch.continueRequest` in its network manager). Measured 2026-09-13 against two local
 * servers: a 302 from the allowed one to the denied one reached the denied one with a route guard
 * installed, one hop and two. The hop is exactly what the guard existed for.
 *
 * So this talks to Chromium directly, on the BROWSER target: `Fetch.enable` there pauses the
 * document requests of every tab and frame this browser will ever have — a popup's first request
 * and a cross-site iframe's included, which a per-page session attaches to too late to see — and
 * each redirect hop is paused again as a request of its own, before its host is contacted. Measured
 * the same day with the same two servers: a 302, two 302s, a meta refresh, `location.href`, a
 * cross-site iframe, `window.open` and a link click all stopped with the denied server receiving
 * nothing. Documents only: a subresource's body never reaches the model, and pausing every image
 * for a verdict is a cost paid on every page.
 */
import type { BrowserContext, CDPSession, Page, Response } from "playwright";
import {
  type HostResolver,
  isPrivateAddress,
  normalizeHostname,
} from "../../shared/net/host-verdict";
import {
  checkNavigationTarget,
  resolvedNavigationTarget,
  type TargetVerdict,
} from "../../shared/net/navigation-target";
import { log } from "./log";

/** One document request, as the guard sees it before it is sent. */
export type NavigationHop = {
  url: string;
  /** The address whose response redirected here. Null when this is a request of its own. */
  redirectedFrom: string | null;
  /** The frame being navigated, as CDP names it. A tab's main frame has the tab's own id. */
  frameId: string;
  method: string;
  /**
   * The `Referer` Chromium was about to send, policy already applied — none for a redirect of an
   * address typed in, the linking page's origin for a script's own navigation. Kept so a hop that is
   * stopped and then asked for again is asked for with the same header it would have carried.
   */
  referer: string | null;
};

export type NavigationGuardOptions = {
  allowPrivateHosts: boolean;
  /** A hop the floor refused. Told before the request is failed; facts about a URL, never content. */
  onRefused?: (hop: NavigationHop, reason: string) => void;
  /**
   * Whether an allowed hop is stopped so somebody else can judge it first.
   *
   * `/navigate` uses it for a navigation reaching a host other than the one the gateway judged: the
   * request is failed exactly as a refusal is, before the host is contacted, and the gateway is told
   * where it was going. What differs from a refusal is only who decides next.
   */
  holds?: (hop: NavigationHop) => boolean;
  /** A proxy carries every request, so the address Chromium connected to is the proxy's. */
  behindProxy?: boolean;
  /** How names are resolved. Injected by tests, which never depend on somebody else's DNS. */
  resolve?: HostResolver;
};

/**
 * Schemes that name a host somewhere. Everything else a document can be — `about:`, `data:`,
 * `blob:`, `chrome-error:` — is made inside the browser and contacts nobody, so it is not the floor's
 * business: a page's `data:` iframe is not an address inside this deployment.
 */
const HOST_SCHEMES = new Set([
  "http:",
  "https:",
  "ws:",
  "wss:",
  "ftp:",
  "file:",
]);

/** Why a document that arrived from inside this deployment's network after all was not read. */
export const CONNECTED_PRIVATELY =
  "That page came from inside this deployment's own network, so the assistant is not allowed to read it.";

/** How many paused requests are remembered, so a redirect hop can name the request it came from. */
const REMEMBERED_REQUESTS = 256;

/**
 * The floor, for a URL the browser is about to request or has landed on.
 *
 * `checkNavigationTarget` is the server's own decision, imported rather than copied: two floors that
 * could disagree would be this bug in a new spelling. A `file:` URL is refused by it (web addresses
 * only), which is the right answer for a page that tries to open this container's disk.
 */
export function hopVerdict(
  url: string,
  allowPrivateHosts: boolean,
): TargetVerdict {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return checkNavigationTarget(url, { allowPrivateHosts });
  }
  if (!HOST_SCHEMES.has(scheme)) return { allowed: true, url };
  return checkNavigationTarget(url, { allowPrivateHosts });
}

/**
 * {@link hopVerdict}, plus where the name resolves (`resolvedNavigationTarget`). What the guard asks.
 *
 * Only for schemes that name a host: a `data:` document has nothing to resolve. Security review
 * 2026-09-25 F1 — `http://127.0.0.1.nip.io/` passed the string-only floor at every hop.
 */
export async function resolvedHopVerdict(
  url: string,
  allowPrivateHosts: boolean,
  resolve?: HostResolver,
): Promise<TargetVerdict> {
  const verdict = hopVerdict(url, allowPrivateHosts);
  if (!verdict.allowed || !HOST_SCHEMES.has(new URL(url).protocol)) {
    return verdict;
  }
  return resolvedNavigationTarget(url, { allowPrivateHosts, resolve });
}

/**
 * The address a document was actually fetched from, when it is inside this deployment's network.
 *
 * THE REBINDING HALF. The guard resolves a name before the request, and Chromium resolves it again
 * to send it; a zone that answers publicly to the first and privately to the second walks past the
 * first. `serverAddr()` is the address Chromium connected to, so this is the one check made at
 * connect time rather than before it. The request has been sent by then — the container's firewall
 * is what stops that (the host's rules on the `laf-browser` bridge, checked by `agent-computer/src/egress-guard.ts`) — but the answer is not handed on.
 *
 * Null when there is nothing to judge: a cached response carries no address.
 */
export async function privateServerAddressOf(
  response: Pick<Response, "serverAddr">,
): Promise<string | null> {
  const server = await response.serverAddr().catch(() => null);
  if (!server?.ipAddress) return null;
  return isPrivateAddress(server.ipAddress) ? server.ipAddress : null;
}

/** The host a URL names, normalised as every comparison in `host-verdict` expects. Empty if none. */
export function hostnameOf(url: string): string {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return "";
  }
}

/**
 * A destination as the trail and the Bot may see it: the origin, never the path or the query. An
 * address with no origin (`file:`, `data:`) is named by its scheme, which is the fact that refused it.
 */
export function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? parsed.protocol : parsed.origin;
  } catch {
    return url.slice(0, 80);
  }
}

/** One request header, whatever case the browser spelled it in. */
function headerOf(
  headers: Record<string, string>,
  wanted: string,
): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === wanted) return value;
  }
  return null;
}

/**
 * Install the guard on a Bot's browser. Resolves once Chromium has confirmed it, so nothing this
 * context does afterwards happens unguarded.
 *
 * FAILS CLOSED. A browser whose guard could not be installed throws here, which fails the launch:
 * a Bot without a computer is an outage somebody sees, and a Bot whose computer quietly opens the
 * metadata endpoint is not.
 */
export async function guardNavigations(
  context: BrowserContext,
  options: NavigationGuardOptions,
): Promise<CDPSession> {
  const browser = context.browser();
  if (!browser) throw new Error("laf:navigation_guard_unavailable");
  const session = await browser.newBrowserCDPSession();
  const urls = new Map<string, string>();

  const remember = (requestId: string, url: string): void => {
    urls.set(requestId, url);
    if (urls.size > REMEMBERED_REQUESTS) {
      const oldest = urls.keys().next().value;
      if (oldest !== undefined) urls.delete(oldest);
    }
  };

  const fail = (requestId: string) =>
    session
      .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
      // Gone already: the tab closed or another navigation replaced this one. Nothing to stop.
      .catch(() => undefined);

  session.on("Fetch.requestPaused", async (event) => {
    const hop: NavigationHop = {
      url: event.request.url,
      redirectedFrom: event.redirectedRequestId
        ? (urls.get(event.redirectedRequestId) ?? null)
        : null,
      frameId: event.frameId,
      method: event.request.method,
      referer: headerOf(event.request.headers, "referer"),
    };
    remember(event.requestId, hop.url);
    let stop: boolean;
    try {
      const verdict = await resolvedHopVerdict(
        hop.url,
        options.allowPrivateHosts,
        options.resolve,
      );
      if (!verdict.allowed) {
        options.onRefused?.(hop, verdict.reason);
        stop = true;
      } else {
        stop = options.holds?.(hop) === true;
      }
    } catch (error) {
      // A guard that cannot decide does not let the request through undecided.
      log.error("navigation_guard_failed", { reason: error });
      stop = true;
    }
    void (stop
      ? fail(event.requestId)
      : session
          .send("Fetch.continueRequest", { requestId: event.requestId })
          .catch(() => undefined));
  });

  /*
   * Where every document actually came from, judged when it arrives (`privateServerAddressOf`).
   * Skipped under the private-host opt-in, and behind a proxy, where the address is the proxy's.
   * A document that came from inside is replaced with a blank page before anybody reads it.
   */
  if (!options.allowPrivateHosts && !options.behindProxy) {
    context.on("response", (response) => {
      if (!response.request().isNavigationRequest()) return;
      void privateServerAddressOf(response).then(async (address) => {
        if (!address) return;
        const page = response.frame().page();
        options.onRefused?.(
          {
            url: response.url(),
            redirectedFrom: null,
            frameId: (await mainFrameIdOf(page)) ?? "",
            method: response.request().method(),
            referer: null,
          },
          CONNECTED_PRIVATELY,
        );
        log.warn("navigation_connected_privately", {
          origin: originOf(response.url()),
        });
        void page.goto("about:blank").catch(() => undefined);
      });
    });
  }

  await session.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
    ],
  });
  return session;
}

/**
 * A tab's main frame id, which is how a paused request says it belongs to that tab's own navigation.
 *
 * Asked of the page's own CDP session and remembered: the id is the tab's target id and does not
 * change while the tab lives. Null when the tab will not say, and then nothing is held for it —
 * the floor still judges every hop, because it does not need to know whose hop it is.
 *
 * ASKED OF THE BROWSER, NOT THE DOCUMENT, AND LET GO WITHOUT WAITING. This read `Page.getFrameTree`,
 * which the document answers, and awaited the session's `detach` — and a tab whose next document is
 * on its way answers neither until it arrives (`page-arrival.ts`): measured 2026-09-14, no answer in
 * 4 s and 8 s, while `Target.getTargetInfo` came back in 0–2 ms with the same id. The id is remembered
 * after the first `/navigate` on a tab, so it was a tab a link had opened that met it: in the image
 * built from dbc1c67, a `/navigate` on such a tab, whose form had just been sent to the fixture's
 * `/hang`, gave no answer in 70 s — and the same tab's `goto` elsewhere, asked directly, took 25 ms.
 */
const mainFrames = new WeakMap<Page, string>();

export async function mainFrameIdOf(page: Page): Promise<string | null> {
  const known = mainFrames.get(page);
  if (known) return known;
  let session: CDPSession | undefined;
  try {
    session = await page.context().newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    mainFrames.set(page, targetInfo.targetId);
    return targetInfo.targetId;
  } catch {
    return null;
  } finally {
    void session?.detach().catch(() => undefined);
  }
}
