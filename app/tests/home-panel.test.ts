import { afterEach, describe, expect, test } from "bun:test";
import {
  CONVERSATION_MIN,
  SCREEN_PANEL_WIDTHS,
} from "../src/lib/computer/screen-panel";
import {
  DEFAULT_HOME_PANEL,
  forgetHomePanel,
  HOME_PANEL_MIN,
  type HomePanel,
  homePanelMax,
  homePanelWidth,
  parseHomePanel,
  readHomePanel,
  setHomeOpen,
  setHomePanel,
  setHomeWidth,
} from "../src/lib/home/home-panel";

/*
 * 홈, THE PANEL AT THE LEFT OF THE WINDOW: HOW WIDE, AND WHEN IT STEPS ASIDE (2026-10-10,
 * `docs/laf/redesign-2026-10.md` §1, piece 3-2).
 *
 * The record's sentence is arithmetic — a fifth of the window and never under 280; dragged, no more
 * than seven tenths and never so far that the conversation is left under 360 — and arithmetic that
 * only a picture checks is arithmetic nobody checks. These are the numbers, at the two windows the
 * PC app is looked at in (1280, and its floor, 1024).
 */

const STORAGE_KEY = "laf.home-panel";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const realStorage = (globalThis as { localStorage?: Storage }).localStorage;

/** A `localStorage` of this test's own: the store reads `globalThis.localStorage` and nothing else. */
function useStorage(store: Store | undefined): void {
  (globalThis as { localStorage?: unknown }).localStorage = store;
  forgetHomePanel();
}

function memoryStorage(seed: Record<string, string> = {}): Store & {
  held: Map<string, string>;
} {
  const held = new Map(Object.entries(seed));
  return {
    held,
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

afterEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = realStorage;
  forgetHomePanel();
});

const open = (width: number | null = null): HomePanel => ({
  isOpen: true,
  width,
});
const at = (viewportWidth: number) => ({ isWide: true, viewportWidth });

describe("how wide 홈 is drawn", () => {
  test("undragged it is a fifth of the window, and never under 280", () => {
    expect(homePanelWidth(open(), at(1920))).toBe(384);
    expect(homePanelWidth(open(), at(1400))).toBe(280);
    // A fifth of these is 256 and 205: the least holds.
    expect(homePanelWidth(open(), at(1280))).toBe(HOME_PANEL_MIN);
    expect(homePanelWidth(open(), at(1024))).toBe(HOME_PANEL_MIN);
  });

  test("dragged, no more than seven tenths — and never so far that the conversation is left under 360", () => {
    // 1280: seven tenths is 896 and the conversation would keep 384, so seven tenths binds.
    expect(homePanelMax(1280)).toBe(896);
    expect(homePanelWidth(open(5000), at(1280))).toBe(896);
    // 1024, the PC app's floor: seven tenths is 716 and would leave 308. The conversation binds.
    expect(homePanelMax(1024)).toBe(1024 - CONVERSATION_MIN);
    expect(homePanelWidth(open(5000), at(1024))).toBe(664);
    for (const window of [1024, 1280, 1400, 1920, 2560]) {
      expect(
        window - homePanelWidth(open(5000), at(window)),
      ).toBeGreaterThanOrEqual(CONVERSATION_MIN);
      expect(homePanelWidth(open(5000), at(window))).toBeLessThanOrEqual(
        window * 0.7,
      );
    }
  });

  test("a width somebody dragged it to is what is drawn, inside those two ends", () => {
    expect(homePanelWidth(open(420), at(1280))).toBe(420);
    expect(homePanelWidth(open(100), at(1280))).toBe(HOME_PANEL_MIN);
    // Chosen on a wide window, then the window is narrowed: drawn at what this window allows.
    expect(homePanelWidth(open(800), at(1024))).toBe(664);
  });

  test("folded it is nothing, and a window narrower than the PC app can be has none", () => {
    expect(homePanelWidth({ isOpen: false, width: 420 }, at(1280))).toBe(0);
    expect(
      homePanelWidth(open(420), { isWide: false, viewportWidth: 900 }),
    ).toBe(0);
    expect(homePanelWidth(open(), { isWide: false, viewportWidth: 375 })).toBe(
      0,
    );
  });

  test("a window that has not said how wide it is draws it at its least, or at what was chosen", () => {
    expect(homePanelWidth(open(), at(0))).toBe(HOME_PANEL_MIN);
    expect(homePanelWidth(open(420), at(0))).toBe(420);
  });
});

describe("홈 gives way to what is open at the right of the screen", () => {
  /*
   * The Bot's screen (360 / 480 / 640), a Bot's profile (320) and the routines' form (400) are
   * each a column beside the conversation. 홈 is drawn in what is left after the conversation's
   * least, and not at all where that is less than its own.
   */
  test("at the PC app's smallest window: beside the profile and the smallest screen it narrows, beside anything wider it steps aside", () => {
    const beside = (taken: number, chosen: number | null = null) =>
      homePanelWidth(open(chosen), at(1024), taken);
    expect(beside(320)).toBe(280);
    expect(beside(320, 600)).toBe(344);
    expect(beside(SCREEN_PANEL_WIDTHS.small)).toBe(280);
    expect(beside(SCREEN_PANEL_WIDTHS.small, 600)).toBe(304);
    expect(beside(400)).toBe(0);
    expect(beside(SCREEN_PANEL_WIDTHS.medium)).toBe(0);
    expect(beside(SCREEN_PANEL_WIDTHS.large)).toBe(0);
  });

  test("at 1280 all three fit, and the conversation is never under its least", () => {
    for (const taken of [320, 360, 400, 480, 640]) {
      for (const chosen of [null, 420, 5000]) {
        const home = homePanelWidth(open(chosen), at(1280), taken);
        expect(home).toBeGreaterThanOrEqual(HOME_PANEL_MIN);
        expect(1280 - home - taken).toBeGreaterThanOrEqual(CONVERSATION_MIN);
      }
    }
    // The largest screen leaves 홈 exactly its least: 280 + 360 + 640.
    expect(homePanelWidth(open(5000), at(1280), 640)).toBe(280);
  });

  test("whatever is open, the conversation keeps 360 or 홈 is not drawn — at every window from the floor up", () => {
    for (let window = 1024; window <= 2000; window += 61) {
      for (const taken of [0, 320, 360, 400, 480, 640]) {
        for (const chosen of [null, 280, 500, 5000]) {
          const home = homePanelWidth(open(chosen), at(window), taken);
          if (home === 0) continue;
          expect(home).toBeGreaterThanOrEqual(HOME_PANEL_MIN);
          expect(window - home - taken).toBeGreaterThanOrEqual(
            CONVERSATION_MIN,
          );
        }
      }
    }
  });
});

describe("what is kept, per device", () => {
  test("nothing stored is open and undragged; anything that is not this module's own shape is that too", () => {
    expect(parseHomePanel(null)).toEqual(DEFAULT_HOME_PANEL);
    expect(DEFAULT_HOME_PANEL).toEqual({ isOpen: true, width: null });
    for (const raw of ["", "not json", "null", "[]", '"open"', "42"]) {
      expect({ raw, panel: parseHomePanel(raw) }).toEqual({
        raw,
        panel: DEFAULT_HOME_PANEL,
      });
    }
  });

  test("a width that no window could have is not a width", () => {
    for (const width of ['"420"', "-5", "0", "null", "1e999", "{}"]) {
      expect({
        width,
        panel: parseHomePanel(`{"isOpen":false,"width":${width}}`),
      }).toEqual({ width, panel: { isOpen: false, width: null } });
    }
    expect(parseHomePanel('{"isOpen":"yes","width":420}')).toEqual({
      isOpen: true,
      width: 420,
    });
  });

  test("folding and dragging are written where a reload finds them", () => {
    const storage = memoryStorage();
    useStorage(storage);
    setHomeWidth(420);
    expect(JSON.parse(storage.held.get(STORAGE_KEY) ?? "")).toEqual({
      isOpen: true,
      width: 420,
    });
    setHomeOpen(false);
    // Folding keeps the width it had: opening it again is not starting over.
    expect(JSON.parse(storage.held.get(STORAGE_KEY) ?? "")).toEqual({
      isOpen: false,
      width: 420,
    });
    // A reload: nothing in memory, the same storage.
    forgetHomePanel();
    expect(readHomePanel()).toEqual({ isOpen: false, width: 420 });
    // And what somebody else wrote under the key is not believed.
    storage.held.set(STORAGE_KEY, '{"isOpen":0,"width":"wide"}');
    forgetHomePanel();
    expect(readHomePanel()).toEqual(DEFAULT_HOME_PANEL);
  });

  test("a browser that will not store anything still folds it for as long as the window is open", () => {
    useStorage({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    });
    // Reading it throws too, and what is drawn is the default.
    expect(readHomePanel()).toEqual(DEFAULT_HOME_PANEL);
    expect(() => setHomePanel({ isOpen: false, width: 500 })).not.toThrow();
    expect(readHomePanel()).toEqual({ isOpen: false, width: 500 });
    expect(() => setHomeOpen(true)).not.toThrow();
    expect(readHomePanel()).toEqual({ isOpen: true, width: 500 });
    // No `localStorage` at all: a runtime without one.
    useStorage(undefined);
    expect(() => setHomeWidth(300)).not.toThrow();
    expect(readHomePanel()).toEqual({ isOpen: true, width: 300 });
  });
});
