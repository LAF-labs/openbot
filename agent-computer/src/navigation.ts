/**
 * Opening a page, with every hop of the way judged — and a page that never arrives abandoned.
 *
 * The guard itself, which pauses every document request in the browser before it is sent, is in
 * `navigation-guard.ts`. This is what the guard's verdicts mean for the `/navigate` in flight: which
 * refusal belongs to the call that is waiting for an answer and which is a note for the next one,
 * which hop is held for the gateway to judge, and how the tab is left afterwards.
 */
import type { Frame, Page } from "playwright";
import {
  checkNavigationTarget,
  resolvedNavigationTarget,
} from "../../shared/net/navigation-target";
import type { BotRoute } from "./computer";
import { ControlError, HUMAN_HAS_CONTROL } from "./control";
import { deploymentEgress } from "./egress";
import { log } from "./log";
import {
  CONNECTED_PRIVATELY,
  hopVerdict,
  hostnameOf,
  mainFrameIdOf,
  type NavigationHop,
  originOf,
  privateServerAddressOf,
} from "./navigation-guard";
import { arrivalNote } from "./page-arrival";
import { readSettledPageText, titleOf } from "./page-text";
import { bodyOf, browserFailed, fact, invalid, json } from "./respond";
import { type BotSession, note, withNotes } from "./sessions";
import { keepOwnAddress } from "./typed-values";

/** A navigation this process stopped: where it was going, where it was sent from, and why. */
type RefusedHop = {
  url: string;
  /** The address that redirected here, when the refused hop was a redirect rather than the request. */
  redirectedFrom: string | null;
  /** The policy's own words, for the server to relay. Facts about a URL, never page content. */
  reason: string;
};

/**
 * One `/navigate`, while it runs. See `BotSession.navigating`.
 *
 * `holding` is the caller's request that a hop to another host be stopped and handed back rather
 * than followed: the gateway judged one host, and it is the gateway that judges the next one. An
 * older server does not ask, and gets the browser following redirects as it always did — every hop
 * still under the floor.
 */
export type Navigating = {
  page: Page;
  frameId: string | null;
  judgedHost: string;
  holding: boolean;
  held?: HeldHop;
  refused?: RefusedHop;
  /** Every address the tab's main frame committed during this call, in order. See `leavePage`. */
  commits: string[];
};

/** A hop stopped for the gateway: where to, which page sent it, and the `Referer` it was carrying. */
type HeldHop = { to: string; from: string; referer?: string };

/**
 * Whether a failure is the deadline's, by the name of the class Playwright gave it.
 *
 * A locator's wait throws the same class, so it is asked only of the `goto` itself — `opening` in
 * `navigate` says which call was in flight — and the narrower question is answered by where the
 * failure happened rather than by its words. Until 2026-09-14 it also matched `goto: Timeout` and
 * `navigating to "` in the message, and the server matched the same phrase again on the far side to
 * tell a slow site from a broken computer. Neither reads a message now: the server reads `code`.
 */
const isTimeout = (error: unknown): boolean =>
  error instanceof Error && error.name === "TimeoutError";

/**
 * A hop the floor refused, reported where it will be read.
 *
 * The tab `/navigate` is driving gets its answer from that call, directly. Anything else — a click
 * that followed a link, a redirect inside an iframe, a popup — becomes a note on the next result, so
 * a page that went blank is not reported as a page that loaded. Origins only: the path of a refused
 * URL carries whatever the page that sent the Bot there put in it.
 */
export function navigationRefused(
  session: BotSession,
  botId: string,
  hop: NavigationHop,
  reason: string,
): void {
  const navigating = session.navigating;
  const ours = navigating !== undefined && hop.frameId === navigating.frameId;
  if (ours && !navigating.refused) {
    navigating.refused = {
      url: hop.url,
      redirectedFrom: hop.redirectedFrom,
      reason,
    };
  } else if (!ours) {
    note(session, {
      code: "laf:navigation_refused",
      origin: originOf(hop.url),
      ...(hop.redirectedFrom
        ? { redirectedFrom: originOf(hop.redirectedFrom) }
        : {}),
    });
  }
  log.warn("navigation_refused", {
    bot: botId,
    origin: originOf(hop.url),
    redirected: hop.redirectedFrom !== null,
    frame: ours ? "navigating" : "other",
  });
}

/**
 * Whether a hop of the tab `/navigate` is driving goes to a host the gateway has not judged.
 *
 * GET only. A hop that is stopped here is requested again by the gateway, from scratch, once it has
 * judged it — which is what a redirect is anyway, and what a form's POST is not: its body cannot be
 * sent twice. A POST that lands somewhere new is judged where it lands instead (gateway.ts).
 */
export function heldForJudgement(
  navigating: Navigating | undefined,
  hop: NavigationHop,
): boolean {
  if (!navigating?.holding || hop.frameId !== navigating.frameId) return false;
  if (hop.method !== "GET") return false;
  if (hostnameOf(hop.url) === navigating.judgedHost) return false;
  navigating.held ??= {
    to: hop.url,
    // A redirect names the response it came from; a script's own navigation came from the page on
    // screen when it ran, which by then is the one this call opened.
    from: hop.redirectedFrom ?? navigating.page.url(),
    ...(hop.referer ? { referer: hop.referer } : {}),
  };
  return true;
}

/** The answer to a navigation this process refused, as facts: which origin, sent from where, why. */
function refusedNavigation(
  session: BotSession,
  hop: RefusedHop,
  startedAt: number,
): Response {
  return fact(
    "laf:navigation_refused",
    withNotes(session, {
      refused: {
        origin: originOf(hop.url),
        ...(hop.redirectedFrom
          ? { redirectedFrom: originOf(hop.redirectedFrom) }
          : {}),
      },
      reason: hop.reason,
      elapsedMs: Date.now() - startedAt,
    }),
  );
}

/**
 * The answer to a navigation stopped at a host the caller has not judged: where it was going and
 * where from, and that nothing loaded. Not an error — the gateway judges `to` and, if it may, asks
 * for it next, with the `Referer` the stopped request was carrying.
 */
function heldNavigation(
  session: BotSession,
  target: Page,
  held: HeldHop,
  startedAt: number,
): Response {
  return json(
    withNotes(session, {
      url: target.url(),
      title: "",
      text: "",
      truncated: false,
      redirect: held,
      // See `act` in actions.ts: the generation the server holds its next ref-less key to.
      generation: session.snapshotId,
      elapsedMs: Date.now() - startedAt,
    }),
  );
}

/**
 * The answer to a `/navigate` the guard stopped part of the way: refused, or held for the gateway.
 *
 * The tab is put on `about:blank` either way rather than left on Chromium's error page for an
 * address the Bot was not allowed to open, so the next snapshot is of nothing rather than of a
 * refusal notice — and a refusal outranks a hold, because nothing about a refused hop is the
 * gateway's to reconsider.
 */
async function stoppedNavigation(
  session: BotSession,
  target: Page,
  navigating: Navigating,
  startedAt: number,
): Promise<Response> {
  await leavePage(target, navigating.commits);
  session.snapshotId += 1;
  if (navigating.refused) {
    return refusedNavigation(session, navigating.refused, startedAt);
  }
  if (navigating.held) {
    return heldNavigation(session, target, navigating.held, startedAt);
  }
  return fact(NAVIGATION_FAILED);
}

/**
 * The address could not be opened, for a reason that is the site's or the network's: a name that does
 * not resolve, a connection refused, a navigation replaced by another. Not a timeout, which has its
 * own code, and not the browser, which does too.
 */
const NAVIGATION_FAILED = "laf:navigation_failed";

const LEAVE_PAGE_MS = 2_000;
/** How long a stopped navigation is given to show its error page. A landing the guard missed has none. */
const ERROR_PAGE_MS = 1_000;
const ERROR_PAGE_POLL_MS = 20;

/**
 * Put the tab on nothing. Bounded and never fatal: a page that will not leave is the next call's problem.
 *
 * AFTER THE ERROR PAGE, NOT BEFORE IT. A navigation the guard stopped makes `goto` reject at once,
 * and Chromium commits its error page for that navigation a moment later. Measured 2026-09-13:
 * leaving in that moment had the error page overtake `about:blank`, so the tab stayed on
 * `chrome-error://`, and the `about:blank` landed during the NEXT `/navigate` — which then failed as
 * "interrupted by another navigation to about:blank", while the page's own redirect went ahead with
 * nothing holding it.
 *
 * And the error page is THIS call's, which is why the commits are counted rather than the address
 * read: a tab already showing an error page — a popup whose first request was refused, adopted as the
 * Bot's tab — satisfied a wait for `chrome-error:` before the new one had landed, and the race was back
 * (measured the same day, a hold that ended on `chrome-error://`).
 */
async function leavePage(target: Page, commits: string[]): Promise<void> {
  const deadline = Date.now() + ERROR_PAGE_MS;
  while (
    !commits.some((address) => address.startsWith("chrome-error:")) &&
    Date.now() < deadline
  ) {
    await Bun.sleep(ERROR_PAGE_POLL_MS);
  }
  await target
    .goto("about:blank", { timeout: LEAVE_PAGE_MS })
    .catch(() => undefined);
}

/** `POST /navigate`: open a page and hand back what it says, or why it was not opened. */
export const navigate: BotRoute = async (
  { request, botId, session },
  { config, profiles },
) => {
  const body = await bodyOf<{
    url?: unknown;
    holdAtNewHost?: unknown;
    referer?: unknown;
  }>(request);
  if (typeof body?.url !== "string") return invalid("url");

  const startedAt = Date.now();
  /*
   * The address itself, before the browser is asked. The guard would refuse it a moment later
   * anyway, but a `javascript:` URL never becomes a request the guard sees — and the server's own
   * check is one process away, on a caller this container cannot assume was the server. Resolved,
   * because a public name can point at 127.0.0.1 (security review 2026-09-25 F1).
   */
  const asked = await resolvedNavigationTarget(body.url, {
    allowPrivateHosts: config.allowPrivateHosts,
  });
  if (!asked.allowed) {
    return refusedNavigation(
      session,
      { url: body.url, redirectedFrom: null, reason: asked.reason },
      startedAt,
    );
  }
  /*
   * The Bot's own address is never blanked on the way back (`typed-values.ts`): it wrote every
   * value in it, and an address that came back blanked would tell it which of its guesses was what a
   * person typed.
   */
  keepOwnAddress(session, asked.url);
  // The `Referer` a hop stopped last time was carrying, when the gateway asks for that hop now.
  // Only a web address the floor allows; anything else is dropped rather than sent.
  const referer =
    typeof body.referer === "string" &&
    checkNavigationTarget(body.referer, {
      allowPrivateHosts: config.allowPrivateHosts,
    }).allowed
      ? body.referer
      : undefined;
  let target: Page | undefined;
  let navigating: Navigating | undefined;
  let recordCommits: ((frame: Frame) => void) | undefined;
  /** Whether a failure belongs to the address (the `goto`) or to the browser around it. */
  let opening = false;
  try {
    session.control.assertBotMayAct();
    target = await profiles.page(botId);
    const commits: string[] = [];
    navigating = {
      page: target,
      frameId: await mainFrameIdOf(target),
      judgedHost: hostnameOf(asked.url),
      holding: body.holdAtNewHost === true,
      commits,
    };
    const tab = target;
    recordCommits = (frame: Frame) => {
      if (frame === tab.mainFrame()) commits.push(frame.url());
    };
    tab.on("framenavigated", recordCommits);
    session.navigating = navigating;
    opening = true;
    const response = await target.goto(asked.url, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
      ...(referer ? { referer } : {}),
    });
    opening = false;
    // A new document wipes every stamp, so every ref handed out before now is meaningless.
    // Bumping the generation makes an action carrying one fail with "take a new snapshot" rather
    // than fall through to a selector that matches nothing and read as a missing element.
    session.snapshotId += 1;
    /*
     * WHERE IT LANDED, judged once more: the response the document came from and the address the
     * tab shows. The guard judged every hop before it was requested, so this is the second net,
     * for the day a request reaches the page some way the guard does not see. Its cost is two
     * string checks; the cost of that day is the metadata endpoint's answer in a model's context.
     */
    const landed = [response?.url(), target.url()]
      .filter((address): address is string => Boolean(address))
      .map((address) => ({
        address,
        verdict: hopVerdict(address, config.allowPrivateHosts),
      }))
      .find(({ verdict }) => !verdict.allowed);
    if (landed && !landed.verdict.allowed) {
      navigating.refused ??= {
        url: landed.address,
        redirectedFrom: asked.url,
        reason: landed.verdict.reason,
      };
    }
    /*
     * And the address the document was actually fetched from, which no string check can see: a name
     * the guard resolved publicly can be resolved privately by Chromium a moment later (DNS
     * rebinding). Not asked behind a proxy, whose own address is all this would read.
     */
    if (
      response &&
      !config.allowPrivateHosts &&
      deploymentEgress(process.env) === null &&
      (await privateServerAddressOf(response))
    ) {
      navigating.refused ??= {
        url: response.url(),
        redirectedFrom: asked.url,
        reason: CONNECTED_PRIVATELY,
      };
    }
    if (!navigating.refused && !navigating.held) {
      const extract = await readSettledPageText(target, {
        settleFirst: true,
      });
      // A page's own script can leave for another host while it settles; the guard stopped that
      // too, and what was read is the error page it left behind, not an answer.
      if (!navigating.refused && !navigating.held) {
        // Or it left for somewhere that has not answered yet: what opened is said, and that it is
        // already on its way elsewhere, rather than waited on (`readSettledPageText`).
        if (extract.arriving) note(session, arrivalNote(extract.arriving));
        return json(
          withNotes(session, {
            url: target.url(),
            title: extract.arriving ? "" : await titleOf(target),
            text: extract.text,
            truncated: extract.truncated,
            ...(extract.reader ? { reader: true } : {}),
            ...(extract.frames ? { frames: extract.frames } : {}),
            /*
             * THE SITE REFUSED, SAID AS A FACT. A 403 "Access Denied" is a page like any other to
             * the browser, so it arrived as a navigation that worked, and the task card said 끝남
             * over a site that had turned the Bot away (UX review 0.5.4, item 2). Only on a refusal:
             * a result that worked carries nothing new.
             */
            ...((response?.status() ?? 0) >= 400
              ? { httpStatus: response?.status() }
              : {}),
            // See `act` in actions.ts: the generation the server holds its next ref-less key to.
            generation: session.snapshotId,
            elapsedMs: Date.now() - startedAt,
          }),
        );
      }
    }
    return await stoppedNavigation(session, target, navigating, startedAt);
  } catch (error) {
    // A person holding the wheel is not a failed navigation; the Bot should wait.
    if (error instanceof ControlError) {
      return fact(HUMAN_HAS_CONTROL, { humanHasControl: true });
    }
    /*
     * A hop the guard stopped. Playwright's words for it are `net::ERR_BLOCKED_BY_CLIENT`, which
     * are true and name nothing; the call recorded which address, and whether it was refused or
     * held for the gateway to judge.
     */
    if (target && (navigating?.refused || navigating?.held)) {
      return await stoppedNavigation(session, target, navigating, startedAt);
    }
    /*
     * A PAGE THAT NEVER ARRIVED IS ABANDONED, NOT KEPT.
     *
     * Playwright's `goto` returning after its deadline does not mean the browser gave up on the
     * page — measured 2026-09-06 against 기업마당, the tab stayed stuck on it, the next `goto`
     * (to a site that was fine) sat out its own deadline too, and `context.close()` never
     * returned. The wedge outlived stop, reset and the idle sweep, because all three waited on
     * that close. So the deadline is the moment this process stops trusting the page: the tab is
     * replaced, or the browser is, before the Bot is told.
     */
    if (opening && isTimeout(error)) {
      const recycled = await profiles.recycle(botId);
      session.snapshotId += 1;
      return fact(
        "laf:page_timeout",
        withNotes(session, { recycled, elapsedMs: Date.now() - startedAt }),
      );
    }
    // The page is the Bot's working surface, so a failed navigation is reported rather than
    // thrown: the transcript needs to say what happened, and the browser stays usable.
    return opening ? fact(NAVIGATION_FAILED) : browserFailed(error);
  } finally {
    if (session.navigating === navigating) session.navigating = undefined;
    if (target && recordCommits) target.off("framenavigated", recordCommits);
  }
};
