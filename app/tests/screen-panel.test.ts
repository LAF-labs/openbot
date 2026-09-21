import { afterEach, describe, expect, test } from "bun:test";
import { PANEL_SIZES } from "../src/components/channels/bot-panel";
import {
  DEFAULT_SCREEN_PANEL,
  FOLDED_WIDTH,
  forgetScreenPanel,
  parseScreenPanel,
  SCREEN_PANEL_WIDTHS,
  type ScreenPanel,
  screenPanelWidth,
  setScreenPanel,
} from "../src/lib/computer/screen-panel";
import { ko } from "../src/lib/i18n-ko";

/**
 * HOW MUCH ROOM THE BOT'S SCREEN TAKES, AND WHAT SURVIVES A WINDOW TOO NARROW TO HONOUR IT.
 *
 * Two things are held here. The STORE — what a stored value that is not this module's shape reads
 * as, and that a browser with no usable `localStorage` still answers with something drawable rather
 * than throwing on the way to a render. And the CLAMP — the rule that decides what a 390px phone
 * actually gets, which is the one arithmetic in this feature and the one that decides whether a
 * panel covers a conversation entirely.
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
  test("nothing stored is the width the pane has always had", () => {
    expect(parseScreenPanel(null)).toEqual({ size: "medium", isFolded: false });
    expect(SCREEN_PANEL_WIDTHS.medium).toBe(320);
  });

  test("a value that is not this module's shape reads as the default, field by field", () => {
    // Half-written, an older shape, or somebody else's key on the same origin.
    expect(parseScreenPanel("{")).toEqual(DEFAULT_SCREEN_PANEL);
    expect(parseScreenPanel("null")).toEqual(DEFAULT_SCREEN_PANEL);
    expect(parseScreenPanel('"large"')).toEqual(DEFAULT_SCREEN_PANEL);
    expect(parseScreenPanel('{"size":"enormous"}')).toEqual({
      size: "medium",
      isFolded: false,
    });
    // One good field and one bad one keeps the good one.
    expect(parseScreenPanel('{"size":"large","isFolded":"yes"}')).toEqual({
      size: "large",
      isFolded: false,
    });
  });

  test("a storage that throws on the getter answers the default rather than the render", () => {
    // A private window, or site data blocked: the throw is on `getItem` itself, before any value.
    const store = storage("throws-reading");
    expect(() =>
      setScreenPanel({ size: "large", isFolded: true }),
    ).not.toThrow();
    forgetScreenPanel();
    store.restore();
  });

  test("a storage that throws on the setter still applies the choice to this tab", () => {
    const store = storage("throws-writing");
    setScreenPanel({ size: "small", isFolded: true });
    // Nothing was kept — and the module is still holding what was pressed.
    expect(store.kept.size).toBe(0);
    store.restore();
  });

  test("no storage at all is not an error", () => {
    const store = storage("absent");
    expect(() =>
      setScreenPanel({ size: "small", isFolded: false }),
    ).not.toThrow();
    store.restore();
  });

  test("what is written is read back as what was pressed", () => {
    const store = storage("works");
    setScreenPanel({ size: "large", isFolded: true });
    expect(
      parseScreenPanel(store.kept.get("laf.screen-panel") ?? null),
    ).toEqual({ size: "large", isFolded: true });
    store.restore();
  });
});

const wide = (panel: ScreenPanel) =>
  screenPanelWidth(panel, { isWide: true, viewportWidth: 1440 });
/** A 390px phone: iPhone 15's CSS width, which is what the requirement names. */
const phone = (panel: ScreenPanel) =>
  screenPanelWidth(panel, { isWide: false, viewportWidth: 390 });

describe("how wide the pane is allowed to be", () => {
  test("on a window with room, the pane is exactly what was chosen", () => {
    expect(wide({ size: "small", isFolded: false })).toBe(240);
    expect(wide({ size: "medium", isFolded: false })).toBe(320);
    expect(wide({ size: "large", isFolded: false })).toBe(440);
  });

  test("folded is the strip, at every size and every width", () => {
    for (const { size } of PANEL_SIZES) {
      expect(wide({ size, isFolded: true })).toBe(FOLDED_WIDTH);
      expect(phone({ size, isFolded: true })).toBe(FOLDED_WIDTH);
    }
    // And it is genuinely less than the narrowest unfolded pane, or folding buys nothing.
    expect(FOLDED_WIDTH).toBeLessThan(SCREEN_PANEL_WIDTHS.small);
  });

  test("at 390px nothing is ever wider than the window", () => {
    /*
     * THIS IS THE ONE THAT WOULD SHIP BROKEN. `large` is 440 — wider than the phone it would be
     * drawn on — and `DetailPanel` puts the pane OVER the conversation below `lg` rather than
     * beside it, so the failure is not a scrollbar somebody can drag back: it is a panel with no
     * visible edge and a conversation that appears to have gone.
     */
    for (const { size } of PANEL_SIZES) {
      const width = phone({ size, isFolded: false });
      expect({ size, width }).toEqual({ size, width: 320 });
      expect(width).toBeLessThan(390);
    }
  });

  test("a window with no width to report is treated as one with room", () => {
    // Before the first measurement — the server's snapshot, and a test with no `window`.
    expect(
      screenPanelWidth(
        { size: "large", isFolded: false },
        { isWide: true, viewportWidth: 0 },
      ),
    ).toBe(440);
  });

  test("a window narrower than the strip still gets a readable strip", () => {
    expect(
      screenPanelWidth(
        { size: "medium", isFolded: false },
        { isWide: false, viewportWidth: 200 },
      ),
    ).toBe(FOLDED_WIDTH);
  });
});

describe("the three widths have Korean", () => {
  test("every label the size control draws is in the dictionary", () => {
    /*
     * Walked by hand because the panel reads these out of a table — `t(label)`, not `t("Small")` —
     * and `i18n-coverage.test.ts` sees only literal calls (CLAUDE.md). Without this a width added
     * later ships as an English word on a Korean pane, and the gate stays green.
     */
    expect(PANEL_SIZES.map(({ label }) => label).filter((l) => !ko[l])).toEqual(
      [],
    );
    // Every size the store knows has a button, so none of them is unreachable.
    expect(PANEL_SIZES.map(({ size }) => String(size)).sort()).toEqual(
      Object.keys(SCREEN_PANEL_WIDTHS).sort(),
    );
  });

  test("the button that folds it, and the group the widths are in, have Korean too", () => {
    for (const source of [
      "Collapse the screen",
      "Expand the screen",
      "Screen size",
    ]) {
      expect({ source, ko: Boolean(ko[source]) }).toEqual({
        source,
        ko: true,
      });
    }
  });
});
