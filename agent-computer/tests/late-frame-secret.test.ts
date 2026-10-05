import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { followTyping } from "../src/person-typing";
import { type BotSession, createSessions } from "../src/sessions";
import { snapshotPage } from "../src/snapshot";
import {
  LATE_FRAME_BUTTON,
  LATE_FRAME_CLICKED,
  LATE_FRAME_SECRET,
  serveFixture,
  TYPED_NEAR_LINK,
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

/**
 * TWO MORE MOMENTS OF A LOOK THAT CANNOT BE REACHED FROM THE FAR SIDE OF `/snapshot`: the instant
 * after the tree has been read, and the questions a look puts to the page, counted.
 *
 * A person's typing is followed here as the door follows it — the element with focus asked for
 * before the key (`followTyping`), then the key — so the nodes are marked in the page and the frame
 * remembered, with nothing of the door in between.
 */
describe.skipIf(!HAS_BROWSER)(
  "a look at a tab a person typed into, at its seams",
  () => {
    const sessionFor = (bot: string): BotSession =>
      createSessions({
        stateDirectoryFor: (botId: string) => join(profilesDir, botId),
      }).sessionFor(bot);
    async function personTypes(
      session: BotSession,
      page: Page,
      place: string,
      text: string,
    ): Promise<void> {
      await page.locator(place).click();
      await followTyping(session, page, text);
      await page.keyboard.insertText(text);
    }

    /*
     * THE TREE'S NAMES ARE ONE MOMENT'S AND THE PAGE WAS ASKED AT ANOTHER — after the late join and
     * the search for typed-into boxes. A region that went in between (a dialog's exit, a re-render)
     * answered that nothing was near, and the name the tree had just read stood, with what a person
     * typed in it. Deterministic: the region is taken out the moment the tree comes back.
     */
    test("a region that leaves between the tree and the question about it is not in the name the tree read", async () => {
      const page = await (browser as Browser).newPage();
      await page.goto(`${fixture?.url}takeover-typed`);
      const session = sessionFor("region-leaves-bot");
      const TYPED = "CANARY-leaves-7391";
      await personTypes(session, page, '[data-shape="near"]', TYPED);

      const tree = page.ariaSnapshot.bind(page);
      let read = "";
      page.ariaSnapshot = async (options) => {
        read = await tree(options);
        await page.evaluate(() =>
          document.querySelector('[data-shape="near"]')?.remove(),
        );
        return read;
      };
      const shot = await snapshotPage(session, page, async () => []);

      // The tree did read the link by what was typed inside it: that is what is being kept out.
      expect(read).toContain(`${TYPED_NEAR_LINK} ${TYPED}`);
      expect(JSON.stringify(shot)).not.toContain(TYPED);
      // Listed under what the page calls it now, which the region is no part of.
      expect(
        shot.elements
          .filter((element) => element.role === "link")
          .map(({ name, value }) => ({ name, value })),
      ).toEqual([{ name: TYPED_NEAR_LINK, value: undefined }]);
      await page.close();
    }, 30_000);

    /*
     * A BOX THAT IS OUT OF ITS DOCUMENT STAYS FOLLOWED — a page can put it back — AND IS IN NO TREE.
     * Each was asked against every listed text-entry control in turn, two round trips a pair, at
     * every look: nine boxes of a closed step beside twelve on the page is 117 controls asked
     * about, for as long as the document lives. Counted here by the refs a look resolves.
     */
    test("followed boxes that are out of the document cost a look no question, and put back are found with one each", async () => {
      const page = await (browser as Browser).newPage();
      const boxes = (label: string, count: number) =>
        Array.from(
          { length: count },
          (_, index) => `<p><input aria-label="${label} ${index}"></p>`,
        ).join("");
      await page.setContent(
        `<!doctype html><html lang="ko"><body><div id="step">${boxes("닫히는 단계 칸", 9)}</div><div>${boxes("화면 칸", 12)}</div></body></html>`,
      );
      const session = sessionFor("detached-boxes-bot");
      for (let index = 0; index < 9; index += 1) {
        await personTypes(
          session,
          page,
          `#step input >> nth=${index}`,
          `CANARY-step-${index}-7391`,
        );
      }
      expect(session.secretFields.length).toBe(9);
      // The step closes: its boxes leave the document, as the same nodes.
      await page.evaluate(() => {
        const step = document.getElementById("step") as HTMLElement;
        (window as unknown as { kept: HTMLElement }).kept = step;
        step.remove();
      });

      let asked = 0;
      const locator = page.locator.bind(page);
      page.locator = (selector, options) => {
        if (selector.startsWith("aria-ref=")) asked += 1;
        return locator(selector, options);
      };
      const closed = await snapshotPage(session, page, async () => []);
      expect(closed.elements.length).toBe(12);
      // Nothing a person typed into is in this tree, so no control of it is asked anything.
      expect(asked).toBe(0);
      // And every one of them is still followed.
      expect(session.secretFields.length).toBe(9);

      await page.evaluate(() => {
        document.body.prepend(
          (window as unknown as { kept: HTMLElement }).kept,
        );
      });
      asked = 0;
      const back = await snapshotPage(session, page, async () => []);
      expect(
        back.elements.filter((element) => element.type === "password").length,
      ).toBe(9);
      expect(JSON.stringify(back)).not.toContain("CANARY");
      // Found where the page said its marked boxes are drawn: one question a box.
      expect(asked).toBe(9);
      await page.close();
    }, 60_000);
  },
);
