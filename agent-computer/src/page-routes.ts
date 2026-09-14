/**
 * Looking at the page without changing anything on any site: `/read`, `/snapshot`, `/screenshot`
 * and `/tabs/switch`.
 *
 * Each answers within its own bound whatever the page is doing, and a tab whose next document is on
 * its way is answered with what the browser can say without it, and `laf:page_loading` (see
 * `page-arrival.ts` for why nothing else can be said about it).
 */
import type { Page } from "playwright";
import type { BotRoute } from "./computer";
import { arrivalNote, arrivalOf, pictureOf } from "./page-arrival";
import { readSettledPageText, titleOf } from "./page-text";
import { TabError } from "./profiles";
import { bodyOf, browserFailed, fact, invalid, json } from "./respond";
import { note, withNotes } from "./sessions";
import { snapshotPage } from "./snapshot";

/**
 * The current page as text, without navigating anywhere.
 *
 * Reading must be available after actions too. Returning page text only from `/navigate` would be
 * enough if opening a page were the only way to change what is on screen. It is not: the Bot presses
 * "Submit order", the page becomes a confirmation, and it has no way to find out what the
 * confirmation said. "I clicked the button" is not an answer to what happened.
 */
export const readPage: BotRoute = async ({ botId, session }, { profiles }) => {
  try {
    const target = await profiles.page(botId);
    const extract = await readSettledPageText(target);
    if (extract.arriving) note(session, arrivalNote(extract.arriving));
    return json(
      withNotes(session, {
        url: target.url(),
        title: extract.arriving ? "" : await titleOf(target),
        text: extract.text,
        truncated: extract.truncated,
        ...(extract.frames ? { frames: extract.frames } : {}),
      }),
    );
  } catch (error) {
    return browserFailed(error);
  }
};

/**
 * The list of things on the page a Bot can act on. POST rather than GET because it mutates the
 * page, stamping every element it describes, and a GET that changes the document is a lie that
 * caches and prefetchers eventually punish.
 */
export const snapshot: BotRoute = async ({ botId, session }, { profiles }) => {
  try {
    return json(
      withNotes(
        session,
        await snapshotPage(session, await profiles.page(botId), () =>
          profiles.tabs(botId),
        ),
      ),
    );
  } catch (error) {
    return browserFailed(error);
  }
};

/**
 * How long Playwright's own picture is given. An ordinary page takes a fraction of a second; the wait
 * it cannot get past is a document that answers nothing, and that one is photographed by the browser.
 */
const SCREENSHOT_WAIT_MS = 5_000;

/** How long the browser is given to paint the tab when the document will not be asked. */
const PAINT_WAIT_MS = 3_000;

/**
 * The tab as a picture.
 *
 * PLAYWRIGHT'S PICTURE, UNLESS THE DOCUMENT IS NOT ANSWERING. `page.screenshot` measures the page
 * through the document before it asks the browser for pixels, so on a tab whose next document was on
 * its way it waited for that document: measured 2026-09-14 in the image built from dbc1c67, 502
 * `laf:browser_failed` at 29.1 s, one second into a `/navigate` to `/hang`. The browser can paint the
 * tab without the document (`pictureOf`), and does here whenever a document is known to be on its way
 * or Playwright's picture does not come in its bound.
 */
async function pictureOfTab(target: Page): Promise<Buffer | undefined> {
  if (!arrivalOf(target)) {
    try {
      return await target.screenshot({
        type: "png",
        timeout: SCREENSHOT_WAIT_MS,
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === "TimeoutError")) {
        throw error;
      }
    }
  }
  return pictureOf(target, PAINT_WAIT_MS);
}

export const screenshot: BotRoute = async ({ botId }, { profiles }) => {
  try {
    const target = await profiles.page(botId);
    const buffer = await pictureOfTab(target);
    if (!buffer) return fact("laf:browser_failed");
    const size = target.viewportSize() ?? { width: 1280, height: 800 };
    return json({
      base64: buffer.toString("base64"),
      width: size.width,
      height: size.height,
      capturedAt: new Date().toISOString(),
      // Which page this is a picture of. A browser that has not been sent anywhere sits on
      // `about:blank`, and a screenshot of that is a valid, entirely white PNG, indistinguishable
      // from a real page to anything looking only at the bytes. The transcript needs to tell
      // those apart to avoid presenting a blank browser as though it were a loaded page.
      url: target.url(),
    });
  } catch (error) {
    return browserFailed(error);
  }
};

/**
 * Move the Bot to another tab.
 *
 * Read-only as far as any website is concerned — nothing on any page changes because somebody
 * looked at a different one — which is why the gateway governs it as `read`. What it does change
 * is which page the next action lands on, so the refs from the last snapshot are retired with it.
 */
export const switchTab: BotRoute = async (
  { request, botId, session },
  { profiles },
) => {
  const body = await bodyOf<{ index?: unknown }>(request);
  if (typeof body?.index !== "number" || !Number.isInteger(body.index)) {
    return invalid("index");
  }
  try {
    // Started if it is not running, so a switch is never answered with "there are no tabs" on a
    // computer that simply has not been woken up yet.
    await profiles.page(botId);
    const tabs = await profiles.switchTab(botId, body.index);
    session.snapshotId += 1;
    const target = await profiles.page(botId);
    // The tab it is on now is still arriving: the next look will say so too, but this is where it went.
    const arrival = arrivalOf(target);
    if (arrival) note(session, arrivalNote(arrival));
    return json(
      withNotes(session, {
        action: "switch_tab",
        index: body.index,
        tabs,
        url: target.url(),
      }),
    );
  } catch (error) {
    if (error instanceof TabError) return fact("laf:tab_missing");
    return browserFailed(error);
  }
};
