import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { createSessions } from "../src/sessions";
import { snapshotPage } from "../src/snapshot";
import {
  LATE_FRAME_BUTTON,
  LATE_FRAME_CLICKED,
  LATE_FRAME_SECRET,
  serveFixture,
} from "./fixture-site";

/**
 * A FRAME THAT ARRIVES WHILE THE PAGE IS BEING LOOKED AT BRINGS NO SECRET INTO THE LOOK.
 *
 * The look stops waiting on a frame's secret fields after a second, so that a frame that never loads
 * cannot hold it for ever — and the tree it takes next waits for frames longer than that. A frame
 * arriving in between reaches the tree with its password box filled in and nothing marking it:
 * measured 2026-09-14 with the late join switched off, this test failed on
 * `"name":"간편결제","value":"LATE-FRAME-SECRET-4455"`, the nameless box beside it unmarked.
 *
 * Deterministic rather than timed: the frame's page is held by the fixture and released the moment
 * the tree is asked for, which is after the join has already given up on it. In-process, because
 * that moment cannot be reached from the far side of `/snapshot`. Skipped, and says so, where
 * Playwright has no browser.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

let fixture: ReturnType<typeof serveFixture> | null = null;
let browser: Browser | null = null;
let profilesDir = "";

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  fixture = serveFixture();
  browser = await chromium.launch();
  profilesDir = await mkdtemp(join(tmpdir(), "laf-late-frame-"));
});

afterAll(async () => {
  fixture?.stop();
  await browser?.close();
  if (profilesDir) await rm(profilesDir, { recursive: true, force: true });
});

/** Release the late frame on the first tree, and count the trees. */
function releasedOnTheTree(page: Page) {
  const seen = { trees: 0 };
  const tree = page.ariaSnapshot.bind(page);
  page.ariaSnapshot = (options) => {
    seen.trees += 1;
    if (seen.trees === 1) fixture?.releaseLateFrames();
    return tree(options);
  };
  return seen;
}

describe.skipIf(!HAS_BROWSER)("a frame that arrives during the look", () => {
  test("has its secret boxes marked and blanked, and its refs still act", async () => {
    const page = await (browser as Browser).newPage();
    await page.goto(`${fixture?.url}other`);
    // After the load, as a payment window is: the page has finished, and the frame is on its way.
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.src = "/late-frame";
      document.body.append(frame);
    });
    const seen = releasedOnTheTree(page);
    const session = createSessions({
      stateDirectoryFor: (botId: string) => join(profilesDir, botId),
    }).sessionFor("late-frame-bot");

    const shot = await snapshotPage(session, page, async () => []);

    // Asserted on the whole of what the Bot would be handed, the way a secret is tested.
    expect(JSON.stringify(shot)).not.toContain(LATE_FRAME_SECRET);
    const boxes = shot.elements.filter(
      (element) => element.role === "textbox" && /^f\d+e\d+$/.test(element.ref),
    );
    // Both, the one with no name and no value included — which nothing but its ref can mark.
    expect(boxes.map((box) => box.type)).toEqual(["password", "password"]);
    // It was the late path: the join had given up, so the tree was taken a second time.
    expect(seen.trees).toBe(2);

    // And the page's tree is the one standing, so a ref from the late frame still acts.
    const button = shot.elements.find(
      (element) => element.name === LATE_FRAME_BUTTON,
    );
    expect(button?.ref).toMatch(/^f\d+e\d+$/);
    await page.locator(`aria-ref=${button?.ref}`).click({ timeout: 5_000 });
    const frame = page
      .frames()
      .find((each) => each.url().endsWith("/late-frame"));
    expect(await frame?.locator("#late-said").textContent()).toBe(
      LATE_FRAME_CLICKED,
    );
    await page.close();
  }, 30_000);
});
