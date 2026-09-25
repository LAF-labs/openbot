import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Browser, chromium, type Page } from "playwright";
import { thumbnailOptions } from "../src/page-routes";
import { startScreencast } from "../src/screencast";
import { thumbnailOf } from "../src/thumbnail";

/**
 * A THUMBNAIL LEAVES THE TAB, AND THE LIVE SCREEN, AS THEY WERE.
 *
 * The thumbnail was a scaled screenshot, which Chrome takes by emulating a smaller screen. Two at
 * once — the panel's 480-wide poll and the 400-wide picture a task keeps as it ends — left the tab
 * emulating 480x300 for good: every live-screen frame 480x300, the small stale page QA saw in the
 * live view's corner 4 times in 4, and the Bot browsing a 480-wide page (measured 2026-09-25, 3 in
 * 3). `thumbnail.ts` takes one frame of a screencast instead. The first browser case below is that
 * measurement against Chrome itself, so a change of Chrome that stopped doing it would say so.
 * Skipped, and says so, where Playwright has no browser.
 */

const VIEWPORT = { width: 1280, height: 800 };

describe("what a thumbnail is asked for", () => {
  test("the width asked, at the tab's own proportions, and a bounded quality", () => {
    expect(
      thumbnailOptions(
        new URL("http://computer/screenshot?format=jpeg&width=480&quality=60"),
        VIEWPORT,
      ),
    ).toEqual({ width: 480, height: 300, quality: 60 });
    expect(
      thumbnailOptions(
        new URL("http://computer/screenshot?format=jpeg&width=4000&quality=5"),
        VIEWPORT,
      ),
    ).toEqual({ width: 1280, height: 800, quality: 20 });
    expect(
      thumbnailOptions(new URL("http://computer/screenshot"), VIEWPORT),
    ).toBeUndefined();
  });
});

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

let browser: Browser | null = null;

beforeAll(async () => {
  if (HAS_BROWSER) browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

/** A page that keeps painting, so a cast sends frames through everything else. */
async function animatedPage(): Promise<Page> {
  const page = await (browser as Browser).newPage({ viewport: VIEWPORT });
  await page.setContent(
    `<style>@keyframes s{to{transform:translateX(900px)}}div{width:200px;height:200px;background:#c33;animation:s 1s linear infinite alternate}</style><h1>가게 오늘 매출</h1><div></div>`,
  );
  return page;
}

const innerSize = (page: Page) =>
  page.evaluate(() => ({ width: innerWidth, height: innerHeight }));

/** The width of every frame a cast sends while `during` runs, and for a moment after. */
async function castWidths(
  page: Page,
  during: () => Promise<unknown>,
): Promise<number[]> {
  const widths: number[] = [];
  const cast = await startScreencast(page, (frame, ack) => {
    widths.push(frame.header.width);
    ack();
  });
  await page.waitForTimeout(300);
  await during();
  await page.waitForTimeout(400);
  await cast.stop();
  return widths;
}

/** The panel's and a finishing task's pictures, asked for in the same moment, as the surface does. */
const bothAtOnce = (page: Page) =>
  Promise.all([
    thumbnailOf(page, { width: 480, height: 300 }, 60, 3_000),
    thumbnailOf(page, { width: 400, height: 250 }, 70, 3_000),
  ]);

describe.skipIf(!HAS_BROWSER)("a thumbnail beside the live screen", () => {
  test("two scaled screenshots at once leave the tab emulating the small screen: what this replaced", async () => {
    const page = await animatedPage();
    // Each on its own session, as two requests to the route are.
    const shoot = async (width: number) =>
      (await page.context().newCDPSession(page)).send(
        "Page.captureScreenshot",
        {
          format: "jpeg",
          clip: { x: 0, y: 0, ...VIEWPORT, scale: width / VIEWPORT.width },
        },
      );
    await Promise.all([shoot(480), shoot(400)]);
    await page.waitForTimeout(500);
    expect((await innerSize(page)).width).toBeLessThan(VIEWPORT.width);
    await page.close();
  }, 30_000);

  test("is a small JPEG, and two at once leave the tab at its own size", async () => {
    const page = await animatedPage();
    const [panel, task] = await bothAtOnce(page);
    // `FF D8`: a JPEG, and a small one.
    expect(panel?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(task?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(panel?.length ?? 0).toBeLessThan(60_000);
    await page.waitForTimeout(500);
    expect(await innerSize(page)).toEqual(VIEWPORT);
    await page.close();
  }, 30_000);

  test("taken while the screen is open, leaves every frame of it full size", async () => {
    const page = await animatedPage();
    const widths = await castWidths(page, async () => {
      for (let shot = 0; shot < 3; shot += 1) {
        await bothAtOnce(page);
        await page.waitForTimeout(150);
      }
    });
    expect(widths.length).toBeGreaterThan(3);
    expect(widths.filter((width) => width !== VIEWPORT.width)).toEqual([]);
    await page.close();
  }, 30_000);

  test("taken before the screen opens, leaves it opening full size", async () => {
    const page = await animatedPage();
    await bothAtOnce(page);
    const widths = await castWidths(page, async () => {});
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.filter((width) => width !== VIEWPORT.width)).toEqual([]);
    await page.close();
  }, 30_000);
});
