import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Browser,
  chromium,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import { readSettledPageText } from "../src/page-text";
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
      place: string | Locator,
      text: string,
    ): Promise<void> {
      await (typeof place === "string" ? page.locator(place) : place).click();
      await followTyping(session, page, text);
      await page.keyboard.insertText(text);
    }
    /**
     * Stand in front of the questions put to a frame whose source says `words`: `around` is handed
     * each one, to be asked or not, before or after whatever the test does to the page.
     */
    function inFrontOf(
      frame: Frame,
      words: string,
      around: (ask: () => Promise<unknown>, nth: number) => Promise<unknown>,
    ) {
      const seen = { asked: 0 };
      const evaluate = frame.evaluate.bind(frame) as (
        script: unknown,
        argument?: unknown,
      ) => Promise<unknown>;
      frame.evaluate = ((script: unknown, argument?: unknown) => {
        if (typeof script !== "string" || !script.includes(words)) {
          return evaluate(script, argument);
        }
        seen.asked += 1;
        return around(() => evaluate(script, argument), seen.asked);
      }) as typeof frame.evaluate;
      return seen;
    }
    /** The reader's question (`reader.ts`), and the question of where the marked nodes are. */
    const THE_READER = "isProbablyReaderable";
    const THE_SCAN = "function scanTyped";

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
     * THE QUESTION BEFORE THE TREE COUNTS ON ITS OWN, AND SILENCE IS NOT "NOTHING NEAR". The region
     * leaves the moment the tree comes back, so the question after it finds nothing: all that
     * stands between the tree's name and the list is the question before — and here the page does
     * not answer that one. Not knowing is then every control asked about, and none named by the
     * tree.
     */
    test("a page that does not answer before the tree has every control asked about, and none named by the tree", async () => {
      const page = await (browser as Browser).newPage();
      await page.goto(`${fixture?.url}takeover-typed`);
      const session = sessionFor("silent-before-bot");
      const TYPED = "CANARY-silent-before-7391";
      await personTypes(session, page, '[data-shape="near"]', TYPED);

      // The first question of where the marked nodes are is never answered; the second is.
      const scans = inFrontOf(page.mainFrame(), THE_SCAN, (ask, nth) =>
        nth === 1 ? new Promise(() => {}) : ask(),
      );
      const tree = page.ariaSnapshot.bind(page);
      let read = "";
      page.ariaSnapshot = async (options) => {
        read = await tree(options);
        await page.evaluate(() =>
          document.querySelector('[data-shape="near"]')?.remove(),
        );
        return read;
      };
      const asked = new Set<string>();
      const locator = page.locator.bind(page);
      page.locator = (selector, options) => {
        if (selector.startsWith("aria-ref=")) asked.add(selector.slice(9));
        return locator(selector, options);
      };
      const shot = await snapshotPage(session, page, async () => []);

      expect(scans.asked).toBe(2);
      expect(read).toContain(`${TYPED_NEAR_LINK} ${TYPED}`);
      expect(JSON.stringify(shot)).not.toContain(TYPED);
      expect(
        shot.elements
          .filter((element) => element.role === "link")
          .map(({ name, value }) => ({ name, value })),
      ).toEqual([{ name: TYPED_NEAR_LINK, value: undefined }]);
      // Every control of the list was asked about, the far button and the Bot's own box included.
      expect(shot.elements.length).toBeGreaterThan(3);
      expect(shot.elements.filter(({ ref }) => !asked.has(ref))).toEqual([]);
      await page.close();
    }, 30_000);

    /*
     * AND A LOOK IS HELD TO THE COUNT AFTER ITS LAST QUESTION AS WELL. Nobody had typed on this tab
     * when the look asked, before its tree and after it; the first key lands before the names are
     * asked, in a link that is itself the place to type and that the tree — taken while it was
     * empty — left nameless. The page is asked what to call it, and says what was just typed.
     * Names the count moved under are not used.
     */
    test("a first key that lands between a look's last scan and its names is in no name: names the count moved under are not used", async () => {
      const page = await (browser as Browser).newPage();
      await page.setContent(
        `<!doctype html><html lang="ko"><body><a href="#renamed" contenteditable="true" style="display:block;width:300px;height:30px"></a><button type="button">곁의 버튼</button></body></html>`,
      );
      const session = sessionFor("first-key-bot");
      const TYPED = "CANARY-first-key-7391";
      const locator = page.locator.bind(page);
      let asked = 0;
      page.locator = (selector, options) => {
        const found = locator(selector, options);
        if (!selector.startsWith("aria-ref=")) return found;
        asked += 1;
        if (asked > 1) return found;
        // The first element the names are asked of: the person's key arrives just ahead of it.
        const handle = found.elementHandle.bind(found);
        found.elementHandle = async (wait) => {
          await personTypes(session, page, "a", TYPED);
          return handle(wait);
        };
        return found;
      };
      const shot = await snapshotPage(session, page, async () => []);

      expect(asked).toBe(1);
      expect(await page.locator("a").textContent()).toBe(TYPED);
      expect(JSON.stringify(shot)).not.toContain(TYPED);
      expect(shot.elements.map(({ role, name }) => ({ role, name }))).toEqual([
        { role: "link", name: "" },
        { role: "button", name: "곁의 버튼" },
      ]);
      await page.close();
    }, 30_000);

    /*
     * A READ IS TOLD WHAT TO LEAVE OUT BY WHETHER THE DOCUMENT WAS TYPED INTO, NOT BY WHAT IS IN IT
     * WHEN IT IS ASKED. A step that closes takes its region out of the document, as the same node,
     * and a page puts it back: out at the question, back while the text is made, out again after.
     * The reader finds the marked nodes itself, so it need only be told to look.
     */
    test("a region out of the document when a read asks who typed here, and back while it reads, is not read out", async () => {
      const page = await (browser as Browser).newPage();
      await page.goto(`${fixture?.url}takeover-typed`);
      const session = sessionFor("region-back-bot");
      const TYPED = "CANARY-back-at-the-read-7391";
      await personTypes(session, page, '[data-shape="near"]', TYPED);
      type Kept = { kept: Element; home: Element };
      await page.evaluate(() => {
        const region = document.querySelector('[data-shape="near"]') as Element;
        const held = window as unknown as Kept;
        held.kept = region;
        held.home = region.parentElement as Element;
        region.remove();
      });
      const reads = inFrontOf(page.mainFrame(), THE_READER, async (ask) => {
        await page.evaluate(() => {
          const held = window as unknown as Kept;
          held.home.append(held.kept);
        });
        const answer = await ask();
        await page.evaluate(() => (window as unknown as Kept).kept.remove());
        return answer;
      });

      const read = await readSettledPageText(page, { session });
      expect(read.text).toContain(TYPED_NEAR_LINK);
      expect(JSON.stringify(read)).not.toContain(TYPED);
      // Told from the start: the text was made once.
      expect(reads.asked).toBe(1);
      // And the words were there to be read: a read that is told of nobody's typing has them.
      expect((await readSettledPageText(page)).text).toContain(TYPED);
      await page.close();
    }, 30_000);

    /*
     * A PERSON MAY START TYPING WHILE THE TEXT IS BEING MADE: a read is not refused while they hold
     * the wheel. What to leave out was asked once, before the main frame — nobody had typed, so
     * nothing — and the frames were read one after another with that answer: a paste landing in
     * between was read out. Deterministic: the typing happens after the question and before the
     * first frame is read. The record is asked again after the text, and the text made once more.
     */
    test("a person who starts typing while a page is being read is not read out, in the main frame or in the frame read after it", async () => {
      const page = await (browser as Browser).newPage();
      await page.goto(`${fixture?.url}takeover-editable`);
      const session = sessionFor("typed-during-read-bot");
      const MAIN = "CANARY-during-main-7391";
      const FRAMED = "CANARY-during-frame-7391";
      const bare = page.locator('[data-shape="bare"]');
      const framed = page
        .frameLocator("iframe")
        .locator('[data-shape="framedBare"]');
      await framed.waitFor();

      let typing = false;
      const reads = inFrontOf(page.mainFrame(), THE_READER, async (ask) => {
        if (typing) {
          typing = false;
          await personTypes(session, page, bare, MAIN);
          await personTypes(session, page, framed, FRAMED);
        }
        return ask();
      });
      // Nobody has typed here: the text is made once.
      const before = await readSettledPageText(page, { session });
      expect(before.text).toContain("틀 속 링크");
      expect(reads.asked).toBe(1);

      typing = true;
      const read = await readSettledPageText(page, { session });
      // They did type, in both places, and the page around both was read.
      expect(await bare.textContent()).toBe(MAIN);
      expect(await framed.textContent()).toBe(FRAMED);
      expect(read.text).toContain("이름 없는 영역");
      expect(read.text).toContain("틀 속 링크");
      expect(JSON.stringify(read)).not.toContain("CANARY");
      // Made twice, and no more: as asked, and once again with what the record said afterwards.
      expect(reads.asked).toBe(3);
      // From then on a read is told from the start, and makes the text once.
      expect(
        JSON.stringify(await readSettledPageText(page, { session })),
      ).not.toContain("CANARY");
      expect(reads.asked).toBe(4);
      await page.close();
    }, 60_000);

    /*
     * THE RECORD OF WHERE A PERSON TYPED FORGETS, AND WHAT A READ IS HELD TO DOES NOT. A frame is
     * forgotten when it goes, and a tab typed into blind when its document does; so a read that
     * looked at the record again after its text was made found nothing to say of a frame a person
     * had typed into while it was being read and whose widget had closed since — and handed on
     * the text it had made of that frame, their typing in it. What it looks at now is a count of
     * the times a person began typing on the tab, which only ever grows.
     */
    test("a frame a person typed into while the page was being read, gone before the read looks again, leaves nothing of theirs in the text", async () => {
      const page = await (browser as Browser).newPage();
      await page.goto(`${fixture?.url}takeover-editable`);
      const session = sessionFor("typed-frame-gone-bot");
      const FRAMED = "CANARY-frame-gone-7391";
      const framed = page
        .frameLocator("iframe")
        .locator('[data-shape="framedBare"]');
      await framed.waitFor();
      const inner = page
        .frames()
        .find((frame) => frame !== page.mainFrame()) as Frame;

      // The main frame is read first, and the person types into the frame while it is.
      const reads = inFrontOf(
        page.mainFrame(),
        THE_READER,
        async (ask, nth) => {
          if (nth === 1) await personTypes(session, page, framed, FRAMED);
          return ask();
        },
      );
      // The frame is read next, their typing in it — and its widget closes as it answers.
      let framedText = "";
      inFrontOf(inner, THE_READER, async (ask) => {
        const answer = await ask();
        framedText = String(answer);
        await page.evaluate(() => document.querySelector("iframe")?.remove());
        return answer;
      });
      const read = await readSettledPageText(page, { session });

      // The text made of the frame did hold it, and the frame is gone: nothing can be asked of it.
      expect(framedText).toContain(FRAMED);
      expect(await page.locator("iframe").count()).toBe(0);
      expect(read.text).toContain("이름 없는 영역");
      expect(JSON.stringify(read)).not.toContain("CANARY");
      // Not handed on, and made again.
      expect(reads.asked).toBe(2);
      await page.close();
    }, 60_000);

    /*
     * A LOOK IS HELD TO THE SAME COUNT. Its tree is one moment's; a person types into a frame just
     * before it, the tree reads the link around their typing, and the frame is gone when the look
     * asks the page a second time — which then has nothing near anything, in a frame that is not
     * there. The tree's name stood. A look a person's first key overtook is one where which node
     * cannot be said: every control is asked about, and one that cannot answer has no name.
     */
    test("a frame a person typed into while a look took its tree, gone before the look asks again, leaves nothing of theirs in the list", async () => {
      const page = await (browser as Browser).newPage();
      await page.goto(`${fixture?.url}takeover-editable`);
      const session = sessionFor("looked-frame-gone-bot");
      const FRAMED = "CANARY-looked-frame-gone-7391";
      const framed = page
        .frameLocator("iframe")
        .locator('[data-shape="framedBare"]');
      await framed.waitFor();
      const tree = page.ariaSnapshot.bind(page);
      let read = "";
      page.ariaSnapshot = async (options) => {
        if (read) return tree(options);
        await personTypes(session, page, framed, FRAMED);
        read = await tree(options);
        await page.evaluate(() => document.querySelector("iframe")?.remove());
        return read;
      };
      const shot = await snapshotPage(session, page, async () => []);

      expect(read).toContain(`틀 속 링크 ${FRAMED}`);
      expect(JSON.stringify(shot)).not.toContain("CANARY");
      // What the tree read inside the frame is in the list, and called nothing.
      const inFrame = shot.elements.filter(({ ref }) => /^f\d+e/.test(ref));
      expect(inFrame.length).toBeGreaterThan(0);
      expect(inFrame.map(({ name }) => name).join("")).toBe("");
      // And the page around it is called what the page calls it.
      expect(
        shot.elements.some(
          ({ role, name }) => role === "textbox" && name === "기준 칸",
        ),
      ).toBe(true);
      await page.close();
    }, 60_000);

    /*
     * AND AN ANSWER A PERSON'S TYPING OVERTOOK FORGETS NOTHING. A frame's document says `gone` when
     * it is not one a person typed into, and the frame is forgotten on that word. The word is
     * heard some time after it was said — every frame's answer is waited for — and a person who
     * types into that document in between was forgotten with it: nothing they typed there was
     * left out of any read from then on.
     */
    test("a frame that said nobody had typed in it, heard after somebody did, is not forgotten", async () => {
      const page = await (browser as Browser).newPage();
      await page.goto(`${fixture?.url}takeover-editable`);
      const session = sessionFor("stale-gone-bot");
      const TYPED = "CANARY-stale-gone-7391";
      const framed = page
        .frameLocator("iframe")
        .locator('[data-shape="framedBare"]');
      await framed.waitFor();
      const inner = page
        .frames()
        .find((frame) => frame !== page.mainFrame()) as Frame;
      // They typed in the frame once, and the frame went on to another document: the record still
      // names the frame, until that document is asked and says it is not the one.
      await personTypes(session, page, framed, "CANARY-earlier-document-7391");
      await inner.goto(`${inner.url().split("#")[0]}?again=1`);
      await framed.waitFor();
      expect(await framed.textContent()).toBe("");
      const scans = inFrontOf(inner, THE_SCAN, async (ask, nth) => {
        const answer = await ask();
        if (nth === 1) {
          expect(answer).toBe("gone");
          await personTypes(session, page, framed, TYPED);
        }
        return answer;
      });

      const first = await readSettledPageText(page, { session });
      const second = await readSettledPageText(page, { session });
      expect(await framed.textContent()).toBe(TYPED);
      expect(JSON.stringify([first, second])).not.toContain("CANARY");
      expect(first.text).toContain("틀 속 링크");
      // Still asked at every read after: the frame is one a person typed in.
      expect(session.typedFrames.has(inner)).toBe(true);
      expect(scans.asked).toBeGreaterThan(1);
      await page.close();
    }, 60_000);

    /*
     * A BOX IS WHAT THE TREE CALLS A BOX: by the first of its `role` words that is a role at all.
     * A marked node was taken for a box if ANY of them was a text box's — so a tab that also says
     * `textbox`, plain again after a rename, was "a box, never named by its contents", was not
     * near itself, and kept the name the tree gave it.
     */
    test("a renamed control whose first role is not a box's is near itself, whatever its other roles say", async () => {
      const page = await (browser as Browser).newPage();
      await page.setContent(
        `<!doctype html><html lang="ko"><body><div role="tablist"><div role="tab textbox" tabindex="0" contenteditable="true" style="width:300px;height:30px"></div></div><button type="button">곁의 버튼</button></body></html>`,
      );
      const session = sessionFor("two-roles-bot");
      const TYPED = "CANARY-two-roles-7391";
      await personTypes(session, page, '[role~="tab"]', TYPED);
      await page.evaluate(() =>
        document
          .querySelector('[role~="tab"]')
          ?.removeAttribute("contenteditable"),
      );
      const tree = await page.ariaSnapshot({ mode: "ai" });
      expect(tree).toContain(`tab "${TYPED}"`);
      const shot = await snapshotPage(session, page, async () => []);

      expect(JSON.stringify(shot)).not.toContain(TYPED);
      expect(shot.elements.map(({ role, name }) => ({ role, name }))).toEqual([
        { role: "tab", name: "" },
        { role: "button", name: "곁의 버튼" },
      ]);
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
