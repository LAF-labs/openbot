/**
 * A tab between two documents: a navigation has started, and the page it asked for has not arrived.
 *
 * NOTHING ASKED OF THE DOCUMENT ANSWERS WHILE IT IS. Measured 2026-09-14 on Playwright 1.62.1 with a
 * tab on the fixture's `/pw` sent to its `/hang`, which accepts the request and never answers:
 * `evaluate`, `locator.count`, `evaluateAll` and `screenshot` gave no answer in 6 s, and over CDP
 * `Runtime.evaluate`, `DOM.getDocument`, `Accessibility.getFullAXTree` and `Page.getFrameTree` none in
 * 4 s — the same whether `goto`, `Page.navigate` or the page's own `location.href` sent it. What the
 * browser answers without the document came back in milliseconds: `Page.captureScreenshot`,
 * `Page.getNavigationHistory`, `Target.getTargetInfo`. DevTools holds a document's messages until the
 * navigation commits, and a site that never answers never lets it commit. In the container every look
 * that asked the document waited for `/navigate` to give the page up (`/read`, `/screenshot`,
 * `/describe-point`, `/click`, `/type`: 502 at 29.1 s) or failed on its own deadline (`/snapshot`: 502
 * at 12.0 s).
 *
 * So a look the document does not answer in time asks this whether a document is on its way, and says
 * so — `laf:page_loading`, and from where — instead of waiting for it or calling the browser broken.
 * Never the other way round: what this holds is consulted only once the document has not answered, so
 * an arrival whose end this missed costs a look its wait, never a page that answers.
 */
import type { CDPSession, Page } from "playwright";
import type { NoteCode } from "./codes";
import { originOf } from "./navigation-guard";
import type { ComputerNote } from "./sessions";
import { within } from "./within";

/** Where a tab's document is coming from, and since when. The origin: a path carries what a page put in it. */
export type Arrival = { origin: string; since: number };

export const PAGE_LOADING: NoteCode = "laf:page_loading";

/** Each tab followed: the session it is followed through, and the document on its way, if one is. */
type Followed = {
  session: CDPSession;
  arriving?: { url: string; since: number };
  /**
   * How many documents the tab has committed since it was followed. `Page.frameNavigated` is sent for
   * a new document only — a `pushState` is `Page.navigatedWithinDocument` (measured 2026-09-16) — so
   * this moves exactly when everything typed into the page before is gone.
   */
  documents: number;
};

const followed = new WeakMap<Page, Followed>();

/** A navigation that moves within the document rather than replacing it. The document goes on answering. */
const SAME_DOCUMENT = new Set(["sameDocument", "historySameDocument"]);

/**
 * Follow when a tab's next document is on its way, from the browser's own events for it.
 *
 * A CDP session of its own, on the tab, and only the Page domain: the start of a navigation that
 * replaces the document (`Page.frameStartedNavigating`, which the browser sends while the document
 * answers nothing), and its three ends — committed (`Page.frameNavigated`, an error page included),
 * stopped without a document (`Page.frameStoppedLoading`: a 204, a cancelled navigation), or turned
 * into a download. Measured on Chromium 151 for the orders that matter: a navigation started while the
 * page before it was still loading an image sent no stop until its own document had arrived, and a
 * 204 sent its stop 4 ms after its start. And for the start that would matter most to miss — a tab a
 * page opens whose own script sends it on at once, the way a payment window submits itself to its
 * gateway — the tab's session had heard it six times out of six, as it had a `goto` sent the moment a
 * tab was handed out, eight of eight.
 *
 * Never throws and never waits: a tab this cannot follow is a tab whose looks wait out their bounds
 * and answer as a page that did not answer (`laf:browser_failed`), never one that is loading.
 *
 * `onDocument` is told each time the tab's main frame commits a NEW document — the same event that
 * moves `documentOf`, and never a `pushState`, which Playwright's own `framenavigated` does report
 * (measured 2026-09-26: a page's `history.pushState` fired it). See `watchPage` for who listens.
 */
export function followArrivals(
  page: Page,
  hooks: { onDocument?: () => void } = {},
): void {
  void (async () => {
    let session: CDPSession | undefined;
    try {
      session = await page.context().newCDPSession(page);
      // The browser's answer, not the document's: it comes back while a document is on its way.
      const { targetInfo } = await session.send("Target.getTargetInfo");
      const main = targetInfo.targetId;
      const tab: Followed = { session, documents: 0 };
      const ended = () => {
        tab.arriving = undefined;
      };
      session.on("Page.frameStartedNavigating", (event) => {
        if (event.frameId !== main || SAME_DOCUMENT.has(event.navigationType)) {
          return;
        }
        tab.arriving = { url: event.url, since: Date.now() };
      });
      session.on("Page.frameNavigated", (event) => {
        if (event.frame.parentId) return;
        tab.documents += 1;
        ended();
        hooks.onDocument?.();
      });
      session.on("Page.frameStoppedLoading", (event) => {
        if (event.frameId === main) ended();
      });
      session.on("Page.downloadWillBegin", (event) => {
        if (event.frameId === main) ended();
      });
      followed.set(page, tab);
      /*
       * Not waited for. The browser's half of `Page.enable` starts its events; the document's half is
       * held like any other message while a document is on its way.
       */
      void session.send("Page.enable").catch(() => undefined);
    } catch {
      // Not waited for either: a detach, too, is held while a document is on its way (navigation-guard.ts).
      void session?.detach().catch(() => undefined);
    }
  })();
}

/** Where the tab's next document is coming from, while one is on its way. Undefined otherwise, or for a tab not followed. */
export function arrivalOf(page: Page): Arrival | undefined {
  const arriving = followed.get(page)?.arriving;
  return arriving
    ? { origin: originOf(arriving.url), since: arriving.since }
    : undefined;
}

/**
 * Which of the tab's documents is on it now, as a count that only moves when one is replaced — or
 * undefined for a tab not followed, which a caller must read as "cannot tell".
 */
export function documentOf(page: Page): number | undefined {
  return followed.get(page)?.documents;
}

/** The fact for a result: the page is still loading, from where, and for how long so far. */
export function arrivalNote(arrival: Arrival): ComputerNote {
  return {
    code: PAGE_LOADING,
    origin: arrival.origin,
    loadingMs: Date.now() - arrival.since,
  };
}

/**
 * How long a question to the document is given once its next document is already known to be on its
 * way.
 *
 * Room for a page that commits in the meantime, not a wait for one that will not: a navigation that
 * lands fails the question at once — its document is gone — and the caller reads the page that
 * arrived. A committed page answers in milliseconds.
 */
export const WHILE_ARRIVING_MS = 1_000;

/**
 * What the document answers within `ms`, or undefined — waiting no more than {@link WHILE_ARRIVING_MS}
 * when its next document is already on its way. See `within` for what becomes of the unanswered work.
 */
export function fromDocument<T>(
  page: Page,
  ms: number,
  work: Promise<T>,
): Promise<T | undefined> {
  return within(arrivalOf(page) ? Math.min(ms, WHILE_ARRIVING_MS) : ms, work);
}

/**
 * What the tab shows, as the browser last painted it, without asking the document anything.
 *
 * Playwright's own screenshot asks for the page's metrics before it asks for pixels
 * (`Page.getLayoutMetrics`, in 1.62.1's source) and gave no answer in 6 s on a tab whose next document
 * was on its way; `Page.captureScreenshot` alone answered in 26–44 ms on the same tab, with the page it
 * was leaving still on it (measured 2026-09-14). Undefined when the browser will not paint in `ms`
 * either.
 */
export async function pictureOf(
  page: Page,
  ms: number,
  /** Chrome's own options for the picture; a full-size PNG when absent. */
  options: Record<string, unknown> = { format: "png" },
): Promise<Buffer | undefined> {
  let session = followed.get(page)?.session;
  let own = false;
  try {
    if (!session) {
      session = await page.context().newCDPSession(page);
      own = true;
    }
    const shot = await within(
      ms,
      session.send("Page.captureScreenshot", options),
    );
    return shot ? Buffer.from(shot.data, "base64") : undefined;
  } catch {
    return undefined;
  } finally {
    if (own) void session?.detach().catch(() => undefined);
  }
}
