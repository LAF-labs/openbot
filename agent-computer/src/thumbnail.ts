/**
 * THE PANEL'S THUMBNAIL, AS ONE FRAME OF A SCREENCAST — NEVER A SCALED SCREENSHOT.
 *
 * It used to be `Page.captureScreenshot` with `clip.scale` (bd2ce0a9), which Chrome takes by
 * emulating a smaller screen for the length of the capture and then putting the old one back. Two of
 * those at once — the panel's 480-wide poll and the 400-wide picture a task keeps when it ends, which
 * are asked for in the same second — each saved the other's emulated screen as "the old one", and
 * the tab was left emulating 480x300 for good: measured 2026-09-25 in the image built from 95cdc6b,
 * 3 times in 3, `innerWidth` 480 afterwards and every live-screen frame 480x300, the small stale page
 * in the corner of the live view that QA saw 4 times in 4. A lone scaled capture also showed in a
 * running cast as a 480x300 frame.
 *
 * A screencast scales the frame it copies and emulates nothing, so any number of these can run beside
 * each other and beside the live screen's own cast (each DevTools session has its own capturer):
 * measured the same day, three of them during a cast left every cast frame 1280x800, and each came
 * back in 7–29 ms at the same size and weight as before (480x300, 6–18 KB).
 */
import type { CDPSession, Page } from "playwright";
import { within } from "./within";

type ScreencastFrame = { data: string; sessionId: number };

/** One JPEG of the tab, at most `size`, or undefined when none came within `ms`. */
export async function thumbnailOf(
  page: Page,
  size: { width: number; height: number },
  quality: number,
  ms: number,
): Promise<Buffer | undefined> {
  let session: CDPSession;
  try {
    session = await page.context().newCDPSession(page);
  } catch {
    return undefined;
  }
  const frame = new Promise<Buffer>((resolve, reject) => {
    session.on("Page.screencastFrame", (event: ScreencastFrame) => {
      void session
        .send("Page.screencastFrameAck", { sessionId: event.sessionId })
        .catch(() => undefined);
      resolve(Buffer.from(event.data, "base64"));
    });
    session
      .send("Page.startScreencast", {
        format: "jpeg",
        quality,
        maxWidth: Math.max(1, Math.round(size.width)),
        maxHeight: Math.max(1, Math.round(size.height)),
        everyNthFrame: 1,
      })
      .catch(reject);
  });
  const picture = await within(ms, frame);
  // Asked, not waited for, like the live screen's own stop: a tab whose next document is on its way
  // may answer neither (screencast.ts).
  void session.send("Page.stopScreencast").catch(() => undefined);
  void session.detach().catch(() => undefined);
  return picture;
}
