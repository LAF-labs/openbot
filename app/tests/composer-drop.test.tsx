import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createElement } from "react";
import { ignoreStrayDrops } from "../src/lib/stray-drop";
import { mount, unmountAll } from "./support/mount";

/**
 * A FILE LET GO OVER THE WINDOW.
 *
 * The composer took a drop on its own form and nowhere else: a strip 49px tall at the bottom of a
 * 760px window (measured at 1200 wide, 2026-10-02), under a conversation that is where anybody
 * aims a file. A file let go over the transcript was not attached, and a Chromium tab then opened
 * it in place of the app, which is what a browser does with a file nothing took.
 *
 * Two things now, and they have to agree about who answers:
 *
 *  - the composer listens on the DOCUMENT, so a file is attached wherever in the window it lands;
 *  - the app listens on the WINDOW (`ignoreStrayDrops`) and refuses any file nobody below it took,
 *    so no screen can be replaced by a dropped file.
 *
 * What a real drag does in each webview is not something this runtime can say. This pins the
 * page's half: which handler answers, in which order, and that neither answers for a drag that
 * carries no file.
 */

const realFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await unmountAll();
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Carried = { types: string[]; files: File[]; dropEffect: string };

/** A drag event as a webview sends one: it bubbles, it can be refused, and it carries something. */
function dragEvent(type: "dragover" | "drop", carried: Carried): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: carried });
  return event;
}

const aFile = (name = "report.csv") =>
  new File(["a,b\n1,2\n"], name, { type: "text/csv" });
const holding = (...files: File[]): Carried => ({
  types: ["Files"],
  files,
  dropEffect: "none",
});
/** A sentence dragged from one place in the page to another: no file in it. */
const holdingText = (): Carried => ({
  types: ["text/plain"],
  files: [],
  dropEffect: "none",
});

async function composer(options: { attach: boolean }) {
  const { Composer } = await import("../src/components/channels/composer");
  // Every upload is taken: the chip is what is looked at, not the server.
  const sent: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    return new Response(
      JSON.stringify({
        attachment: {
          id: "attachment-1",
          name: "report.csv",
          mimeType: "text/csv",
          kind: "document",
          bytes: 8,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const mounted = await mount();
  await mounted.render(
    createElement(Composer, {
      compact: true,
      onSubmit: () => {},
      ...(options.attach
        ? { attach: { channelId: "channel-1", images: true } }
        : {}),
    }),
  );
  await mounted.settle(10);
  const { act } = await import("react");
  return {
    ...mounted,
    sent,
    /** Hand the event to whatever the pointer is over, and say what became of it. */
    over: async (target: EventTarget, event: Event) => {
      await act(async () => {
        target.dispatchEvent(event);
      });
      return event;
    },
    cue: () => mounted.host.querySelector('[data-testid="composer-drop-cue"]'),
  };
}

describe("a file held over the window", () => {
  test("is offered a place wherever it is held, and the cue says so in words", async () => {
    const { host, over, cue } = await composer({ attach: true });
    expect(cue()).toBeNull();

    // Over the page's body — the transcript, the header, anywhere — not over the box.
    const carried = holding(aFile());
    const event = await over(document.body, dragEvent("dragover", carried));
    expect(event.defaultPrevented).toBe(true);
    expect(carried.dropEffect).toBe("copy");
    expect(cue()?.textContent).toBe("Let go to attach it.");
    // The box still shows it too, for somebody looking there.
    expect(host.querySelector('[data-testid="composer"]')?.className).toContain(
      "border-dashed",
    );
  });

  test("the cue is put away once the file is no longer held over the page", async () => {
    const { over, cue, settle } = await composer({ attach: true });
    await over(document.body, dragEvent("dragover", holding(aFile())));
    expect(cue()).not.toBeNull();
    // No `dragleave` is waited for — WebKit's says nothing about where the file went. The
    // `dragover`s stop arriving, and that is the signal.
    await settle(750);
    expect(cue()).toBeNull();
  });

  test("a drag that carries no file is none of the composer's business", async () => {
    const { over, cue } = await composer({ attach: true });
    const carried = holdingText();
    const event = await over(document.body, dragEvent("dragover", carried));
    expect(event.defaultPrevented).toBe(false);
    expect(carried.dropEffect).toBe("none");
    expect(cue()).toBeNull();
  });
});

describe("a file let go over the window", () => {
  test("is attached, wherever in the window it lands", async () => {
    const { host, over, cue, settle, sent } = await composer({ attach: true });
    await over(document.body, dragEvent("dragover", holding(aFile())));

    const event = await over(
      document.body,
      dragEvent("drop", holding(aFile())),
    );
    // Taken: the webview must not do what it does with a file nobody took.
    expect(event.defaultPrevented).toBe(true);
    expect(cue()).toBeNull();
    await settle(30);
    expect(host.textContent).toContain("report.csv");
    expect(sent).toEqual(["/api/channels/channel-1/attachments"]);
  });

  test("is attached once when it lands on the box itself", async () => {
    // The form used to take the drop as well: with both listening, one file became two chips.
    const { host, over, settle, sent } = await composer({ attach: true });
    const form = host.querySelector('[data-testid="composer"]');
    if (!form) throw new Error("no composer on screen");
    await over(form, dragEvent("drop", holding(aFile())));
    await settle(30);
    expect(sent).toHaveLength(1);
  });

  test("is not taken by a composer that has nowhere to keep it", async () => {
    const { over, sent, settle } = await composer({ attach: false });
    const event = await over(
      document.body,
      dragEvent("drop", holding(aFile())),
    );
    await settle(30);
    expect(event.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
  });

  test("stops being listened for when the composer leaves the screen", async () => {
    const { over, unmount, sent, settle } = await composer({ attach: true });
    await unmount();
    const event = await over(
      document.body,
      dragEvent("drop", holding(aFile())),
    );
    await settle(30);
    expect(event.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("a file nobody took", () => {
  test("is refused at the window, so the page is never replaced by it", () => {
    const stop = ignoreStrayDrops(window);
    try {
      for (const type of ["dragover", "drop"] as const) {
        const carried = holding(aFile());
        const event = dragEvent(type, carried);
        document.body.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        // The pointer says no while the file is still held.
        expect(carried.dropEffect).toBe("none");
      }
    } finally {
      stop();
    }
  });

  test("is left alone when something below the window took it", async () => {
    const { over } = await composer({ attach: true });
    const stop = ignoreStrayDrops(window);
    try {
      // The composer answers on the document, the guard on the window: the composer first.
      const carried = holding(aFile());
      const event = await over(document.body, dragEvent("dragover", carried));
      expect(event.defaultPrevented).toBe(true);
      expect(carried.dropEffect).toBe("copy");
    } finally {
      stop();
    }
  });

  test("a drag with no file in it keeps the browser's own behaviour", () => {
    const stop = ignoreStrayDrops(window);
    try {
      const event = dragEvent("drop", holdingText());
      document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      stop();
    }
  });

  test("stops being refused when the guard is taken down", () => {
    const stop = ignoreStrayDrops(window);
    stop();
    const event = dragEvent("drop", holding(aFile()));
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  test("the guard is on from the first line of the app", async () => {
    const main = await Bun.file(
      new URL("../src/main.tsx", import.meta.url),
    ).text();
    expect(main).toContain("ignoreStrayDrops();");
  });
});
