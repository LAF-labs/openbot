import { afterEach, describe, expect, test } from "bun:test";
import { PANEL_SIZES } from "../src/components/computer/live-view";
import {
  CONVERSATION_MIN,
  DEFAULT_SCREEN_PANEL,
  forgetScreenPanel,
  parseScreenPanel,
  readScreenPanel,
  SCREEN_PANEL_WIDTHS,
  type ScreenPanel,
  screenPanelWidth,
  setScreenOpen,
  setScreenPanel,
} from "../src/lib/computer/screen-panel";
import { ko } from "../src/lib/i18n-ko";

/**
 * WHETHER THE BOT'S SCREEN IS OPEN, HOW MUCH ROOM IT TAKES, AND WHAT A NARROW WINDOW GETS INSTEAD.
 *
 * Three things are held here. The STORE — what a stored value that is not this module's shape reads
 * as, and that a browser with no usable `localStorage` still answers with something drawable rather
 * than throwing on the way to a render. OPEN — that it starts closed, and that an old stored value
 * from when the screen opened itself does not open it. And the WIDTH — a sheet the width of a phone
 * and a chosen size on a wide window.
 */

/** A `localStorage` that behaves however a case needs, installed on `globalThis` for that case. */
function storage(
  behaviour: "works" | "throws-reading" | "throws-writing" | "absent",
  seed?: string,
) {
  const kept = new Map<string, string>();
  if (seed !== undefined) kept.set("laf.screen-panel", seed);
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const fake =
    behaviour === "absent"
      ? undefined
      : {
          getItem(key: string) {
            if (behaviour === "throws-reading") {
              throw new Error("SecurityError: site data is blocked");
            }
            return kept.get(key) ?? null;
          },
          setItem(key: string, value: string) {
            if (behaviour === "throws-writing") {
              throw new Error("QuotaExceededError");
            }
            kept.set(key, value);
          },
        };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: fake,
  });
  return {
    kept,
    restore() {
      if (real) Object.defineProperty(globalThis, "localStorage", real);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

afterEach(() => {
  forgetScreenPanel();
});

describe("what was stored", () => {
  test("nothing stored is a closed screen at the middle size", () => {
    expect(parseScreenPanel(null)).toEqual({ size: "medium", isOpen: false });
    expect(DEFAULT_SCREEN_PANEL).toEqual({ size: "medium", isOpen: false });
  });

  test("a value that is not this module's shape reads as the default, field by field", () => {
    // Half-written, an older shape, or somebody else's key on the same origin.
    expect(parseScreenPanel("{")).toEqual(DEFAULT_SCREEN_PANEL);
    expect(parseScreenPanel("null")).toEqual(DEFAULT_SCREEN_PANEL);
    expect(parseScreenPanel('"large"')).toEqual(DEFAULT_SCREEN_PANEL);
    expect(parseScreenPanel('{"size":"enormous"}')).toEqual({
      size: "medium",
      isOpen: false,
    });
    // One good field and one bad one keeps the good one.
    expect(parseScreenPanel('{"size":"large","isOpen":"yes"}')).toEqual({
      size: "large",
      isOpen: false,
    });
  });

  test("a value from the screen that opened itself does not open this one", () => {
    // What the old pane wrote: a size and a fold. Neither says the person opened anything.
    expect(parseScreenPanel('{"size":"small","isFolded":false}')).toEqual({
      size: "small",
      isOpen: false,
    });
  });

  test("a storage that throws on the getter answers the default rather than the render", () => {
    // A private window, or site data blocked: the throw is on `getItem` itself, before any value.
    const store = storage("throws-reading");
    expect(readScreenPanel()).toEqual(DEFAULT_SCREEN_PANEL);
    expect(() => setScreenPanel({ size: "large", isOpen: true })).not.toThrow();
    forgetScreenPanel();
    store.restore();
  });

  test("a storage that throws on the setter still applies the choice to this tab", () => {
    const store = storage("throws-writing");
    setScreenPanel({ size: "small", isOpen: true });
    // Nothing was kept — and the module is still holding what was pressed.
    expect(store.kept.size).toBe(0);
    expect(readScreenPanel()).toEqual({ size: "small", isOpen: true });
    store.restore();
  });

  test("no storage at all is not an error", () => {
    const store = storage("absent");
    expect(() =>
      setScreenPanel({ size: "small", isOpen: false }),
    ).not.toThrow();
    store.restore();
  });

  test("what is written is read back as what was pressed", () => {
    const store = storage("works");
    setScreenPanel({ size: "large", isOpen: true });
    expect(
      parseScreenPanel(store.kept.get("laf.screen-panel") ?? null),
    ).toEqual({ size: "large", isOpen: true });
    store.restore();
  });

  test("opening and closing keep the size somebody chose", () => {
    const store = storage("works");
    setScreenPanel({ size: "large", isOpen: false });
    setScreenOpen(true);
    expect(readScreenPanel()).toEqual({ size: "large", isOpen: true });
    setScreenOpen(false);
    expect(
      parseScreenPanel(store.kept.get("laf.screen-panel") ?? null),
    ).toEqual({ size: "large", isOpen: false });
    store.restore();
  });
});

const open = (size: ScreenPanel["size"]): ScreenPanel => ({
  size,
  isOpen: true,
});
/** A 1440px laptop, which leaves every size its room. */
const wide = (panel: ScreenPanel) =>
  screenPanelWidth(panel, { isWide: true, viewportWidth: 1440 });
/** A 375px phone, which the requirement names. */
const phone = (panel: ScreenPanel) =>
  screenPanelWidth(panel, { isWide: false, viewportWidth: 375 });

describe("how wide the screen is allowed to be", () => {
  test("on a window with room, the screen is exactly what was chosen", () => {
    expect(wide(open("small"))).toBe(SCREEN_PANEL_WIDTHS.small);
    expect(wide(open("medium"))).toBe(SCREEN_PANEL_WIDTHS.medium);
    expect(wide(open("large"))).toBe(SCREEN_PANEL_WIDTHS.large);
  });

  test("below lg it is a sheet the width of the window, whatever size was chosen", () => {
    /*
     * The pane lies OVER the conversation below `lg`, so a narrower one gives nothing back — and
     * `large` is wider than the phone. The sheet is the phone, edge to edge, and nothing wider.
     */
    for (const { size } of PANEL_SIZES) {
      expect({ size, width: phone(open(size)) }).toEqual({ size, width: 375 });
    }
  });

  test("the PC app's smallest window spares every size, and the conversation keeps its least beside it", () => {
    /*
     * 1024 is the installed window's floor. Until 2026-10-10 a column stood at the left and this
     * window narrowed the largest size to leave it room; the column is gone, and what stands
     * there now (홈) gives way to the screen instead (`home-panel.test.ts`).
     */
    const at1024 = (panel: ScreenPanel) =>
      screenPanelWidth(panel, { isWide: true, viewportWidth: 1024 });
    for (const { size } of PANEL_SIZES) {
      expect({ size, width: at1024(open(size)) }).toEqual({
        size,
        width: SCREEN_PANEL_WIDTHS[size],
      });
      expect(1024 - at1024(open(size))).toBeGreaterThanOrEqual(
        CONVERSATION_MIN,
      );
    }
  });

  test("a wide window that cannot spare the chosen size narrows it, never below the smallest", () => {
    const at900 = (panel: ScreenPanel) =>
      screenPanelWidth(panel, { isWide: true, viewportWidth: 900 });
    expect(at900(open("large"))).toBe(900 - CONVERSATION_MIN);
    expect(at900(open("small"))).toBe(SCREEN_PANEL_WIDTHS.small);
    expect(
      screenPanelWidth(open("large"), { isWide: true, viewportWidth: 600 }),
    ).toBe(SCREEN_PANEL_WIDTHS.small);
  });

  test("a window with no width to report is treated as one with room", () => {
    // Before the first measurement — the server's snapshot, and a test with no `window`.
    expect(
      screenPanelWidth(open("large"), { isWide: true, viewportWidth: 0 }),
    ).toBe(SCREEN_PANEL_WIDTHS.large);
  });
});

describe("the three widths have Korean", () => {
  test("every label the size control draws is in the dictionary", () => {
    /*
     * Walked by hand because the live view reads these out of a table — `t(label)`, not
     * `t("Small")` — and `i18n-coverage.test.ts` sees only literal calls (CLAUDE.md). Without this a
     * width added later ships as an English word on a Korean screen, and the gate stays green.
     */
    expect(PANEL_SIZES.map(({ label }) => label).filter((l) => !ko[l])).toEqual(
      [],
    );
    // Every size the store knows has a button, so none of them is unreachable.
    expect(PANEL_SIZES.map(({ size }) => String(size)).sort()).toEqual(
      Object.keys(SCREEN_PANEL_WIDTHS).sort(),
    );
  });
});
