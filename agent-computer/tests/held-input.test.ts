import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Browser, chromium, type Page } from "playwright";
import {
  type HeldInput,
  holdAfter,
  type InputMessage,
  mouseEventOf,
  releasesOf,
  startScreencast,
} from "../src/screencast";

/**
 * WHAT A PERSON HOLDS DOWN ON THE BOT'S PAGE IS ALWAYS LET GO OF, AND A HOVER HOLDS NOTHING.
 *
 * Three defects in the take-over path, found 2026-10-01 by reading another project's live view
 * beside ours and then measuring ours against Chromium 151:
 *
 *   1. Every hover reached the page as a drag: the surface sent `button: "left"` on a move (a DOM
 *      `mousemove` says `button: 0`), this service passed it on, and the page saw `buttons: 1`.
 *   2. A button released outside the picture was never released on the page.
 *   3. A key held when focus left was never released.
 *
 * The surface now says what is really down and follows the pointer with a capture
 * (`app/src/components/computer/live-screen.tsx`). This file holds the half that is this service's:
 * what a move with nothing held is sent as, and that whatever is still down when the person can no
 * longer say so — the socket closed, the wheel handed back — comes up anyway. The browser cases are
 * the measurements themselves, against Chrome, so a Chrome that changed what `none` means would say
 * so. Skipped where Playwright has no browser.
 */

describe("a mouse message, as Chrome is handed it", () => {
  test("a move that names no button holds none — a hover is not a drag", () => {
    expect(
      mouseEventOf({ type: "mouse", event: "moved", x: 10, y: 20 }),
    ).toEqual({
      type: "mouseMoved",
      x: 10,
      y: 20,
      button: "none",
      clickCount: 0,
      modifiers: 0,
    });
  });

  test("a move carries the button the surface says is down, and none when it says none", () => {
    expect(
      mouseEventOf({
        type: "mouse",
        event: "moved",
        x: 1,
        y: 2,
        button: "left",
      }).button,
    ).toBe("left");
    expect(
      mouseEventOf({
        type: "mouse",
        event: "moved",
        x: 1,
        y: 2,
        button: "none",
      }).button,
    ).toBe("none");
  });

  test("a press or a release that names no button is the left one, with a click count", () => {
    expect(
      mouseEventOf({ type: "mouse", event: "pressed", x: 1, y: 2 }),
    ).toMatchObject({ type: "mousePressed", button: "left", clickCount: 1 });
    expect(
      mouseEventOf({
        type: "mouse",
        event: "released",
        x: 1,
        y: 2,
        button: "right",
        modifiers: 8,
      }),
    ).toMatchObject({
      type: "mouseReleased",
      button: "right",
      clickCount: 1,
      modifiers: 8,
    });
  });
});

const nothingHeld = (): HeldInput => ({ buttons: new Map(), keys: new Map() });

function after(messages: InputMessage[]): HeldInput {
  const held = nothingHeld();
  for (const message of messages) holdAfter(held, message);
  return held;
}

describe("what is held, and what lets go of it", () => {
  test("a press is held until its release, and nothing is left to let go of after", () => {
    const held = after([
      { type: "mouse", event: "pressed", x: 5, y: 5, button: "left" },
      { type: "mouse", event: "released", x: 9, y: 9, button: "left" },
      { type: "key", event: "down", key: "a", code: "KeyA", text: "a" },
      { type: "key", event: "up", key: "a", code: "KeyA" },
    ]);
    expect(releasesOf(held)).toEqual([]);
  });

  test("a button with no release comes up where the pointer last was", () => {
    const held = after([
      { type: "mouse", event: "pressed", x: 5, y: 5, button: "left" },
      { type: "mouse", event: "moved", x: 300, y: 40, button: "left" },
    ]);
    expect(releasesOf(held)).toEqual([
      { type: "mouse", event: "released", x: 300, y: 40, button: "left" },
    ]);
  });

  test("a key is the same key under a Shift that changed what it types", () => {
    // Down as `a`, up as `A`: one physical key, and it is not still held.
    const held = after([
      { type: "key", event: "down", key: "a", code: "KeyA", text: "a" },
      { type: "key", event: "down", key: "Shift", code: "ShiftLeft" },
      { type: "key", event: "up", key: "A", code: "KeyA" },
    ]);
    expect(releasesOf(held)).toEqual([
      { type: "key", event: "up", key: "Shift", code: "ShiftLeft" },
    ]);
  });

  test("a hover, a wheel and a paste hold nothing", () => {
    const held = after([
      { type: "mouse", event: "moved", x: 1, y: 1, button: "none" },
      { type: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 120 },
      { type: "text", text: "한글" },
    ]);
    expect(releasesOf(held)).toEqual([]);
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

type Seen = { type: string; buttons?: number; x?: number; key?: string };

/** A page that writes down every mouse and key event it is given. */
async function listeningPage(): Promise<Page> {
  const page = await (browser as Browser).newPage({
    viewport: { width: 800, height: 600 },
  });
  await page.setContent(
    `<body style="margin:0;height:100vh"><script>
      window.seen = [];
      for (const type of ["mousemove", "mousedown", "mouseup"]) {
        addEventListener(type, (e) => seen.push({ type, buttons: e.buttons, x: e.clientX }));
      }
      for (const type of ["keydown", "keyup"]) {
        addEventListener(type, (e) => seen.push({ type, key: e.key }));
      }
    </script></body>`,
  );
  return page;
}

const seenBy = (page: Page) =>
  page.evaluate(() => (window as unknown as { seen: Seen[] }).seen);

/** What the page has seen once `wanted` is among it, or whatever it has after two seconds. */
async function seenOnce(
  page: Page,
  wanted: (seen: Seen[]) => boolean,
): Promise<Seen[]> {
  const deadline = Date.now() + 2_000;
  let seen = await seenBy(page);
  while (!wanted(seen) && Date.now() < deadline) {
    await page.waitForTimeout(50);
    seen = await seenBy(page);
  }
  return seen;
}

describe.skipIf(!HAS_BROWSER)("against Chrome itself", () => {
  test("a move naming the left button is a drag to the page: what a hover used to be sent as", async () => {
    const page = await listeningPage();
    const cast = await startScreencast(page, (_frame, ack) => ack());
    await cast.send({
      type: "mouse",
      event: "moved",
      x: 100,
      y: 100,
      button: "left",
    });
    const seen = await seenOnce(page, (all) => all.length > 0);
    expect(seen).toEqual([{ type: "mousemove", buttons: 1, x: 100 }]);
    await cast.stop();
    await page.close();
  }, 30_000);

  test("a move that names no button reaches the page with none down", async () => {
    const page = await listeningPage();
    const cast = await startScreencast(page, (_frame, ack) => ack());
    await cast.send({ type: "mouse", event: "moved", x: 100, y: 100 });
    await cast.send({
      type: "mouse",
      event: "moved",
      x: 120,
      y: 100,
      button: "none",
    });
    const seen = await seenOnce(page, (all) => all.length > 1);
    expect(seen).toEqual([
      { type: "mousemove", buttons: 0, x: 100 },
      { type: "mousemove", buttons: 0, x: 120 },
    ]);
    await cast.stop();
    await page.close();
  }, 30_000);

  test("a button and a key with no release come up when the wheel is handed back", async () => {
    const page = await listeningPage();
    const cast = await startScreencast(page, (_frame, ack) => ack());
    await cast.send({
      type: "mouse",
      event: "pressed",
      x: 100,
      y: 100,
      button: "left",
    });
    await cast.send({
      type: "mouse",
      event: "moved",
      x: 400,
      y: 100,
      button: "left",
    });
    await cast.send({
      type: "key",
      event: "down",
      key: "Shift",
      code: "ShiftLeft",
    });
    // Before: the page is waiting on a `mouseup` and a `keyup` nobody is going to send.
    expect((await seenBy(page)).map((event) => event.type)).toEqual([
      "mousedown",
      "mousemove",
      "keydown",
    ]);

    await cast.letGo();
    const seen = await seenOnce(page, (all) => all.length >= 5);
    expect(seen.slice(3)).toEqual([
      // Where the pointer last was, not where it went down.
      { type: "mouseup", buttons: 0, x: 400 },
      { type: "keyup", key: "Shift" },
    ]);

    // Let go of once: asked again, there is nothing to send.
    await cast.letGo();
    await page.waitForTimeout(200);
    expect((await seenBy(page)).length).toBe(5);
    await cast.stop();
    await page.close();
  }, 30_000);

  test("and when the cast is stopped under them — the socket closed — without being asked", async () => {
    const page = await listeningPage();
    const cast = await startScreencast(page, (_frame, ack) => ack());
    await cast.send({
      type: "mouse",
      event: "pressed",
      x: 50,
      y: 50,
      button: "left",
    });
    await cast.stop();
    const seen = await seenOnce(page, (all) =>
      all.some((event) => event.type === "mouseup"),
    );
    expect(seen.map((event) => event.type)).toEqual(["mousedown", "mouseup"]);
    await page.close();
  }, 30_000);
});
