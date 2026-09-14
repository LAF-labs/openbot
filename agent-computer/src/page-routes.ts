/**
 * Looking at the page without changing anything on any site: `/read`, `/snapshot`, `/screenshot`
 * and `/tabs/switch`.
 */
import type { BotRoute } from "./computer";
import { readSettledPageText } from "./page-text";
import { TabError } from "./profiles";
import { bodyOf, browserFailed, fact, invalid, json } from "./respond";
import { withNotes } from "./sessions";
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
    return json(
      withNotes(session, {
        url: target.url(),
        title: await target.title().catch(() => ""),
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

export const screenshot: BotRoute = async ({ botId }, { profiles }) => {
  try {
    const target = await profiles.page(botId);
    const buffer = await target.screenshot({ type: "png" });
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
    return json(
      withNotes(session, {
        action: "switch_tab",
        index: body.index,
        tabs,
        url: target.url(),
      }),
    );
  } catch (error) {
    if (error instanceof TabError) return fact("laf:tab_missing", 400);
    return browserFailed(error);
  }
};
