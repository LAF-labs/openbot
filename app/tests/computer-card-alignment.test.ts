import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The card that shows the Bot's screen: one left rule, one rounded picture, and a ring on every
 * control a keyboard can reach.
 *
 * MEASURED IN A BROWSER AT 1440x900, IN BOTH THEMES, AND NONE OF IT WAS VISIBLE FROM A GREEN GATE.
 * In the 287px column the pane leaves, `getBoundingClientRect().left` reported three different
 * starts inside one card: the picture at 1138, every row's words at 1150, and the recorded-steps
 * list at 1162 with its text at 1173. They are all 1146 now. The picture also had square bottom
 * corners inside a rounded, clipped card, so the panel under it cut straight across where the
 * screen's shape should have continued; it is its own complete `rounded-xl` box now, inset from the
 * card, and nothing can cross a corner it no longer shares.
 *
 * WALKED RATHER THAN RENDERED, the call `approve-centring.test.ts` makes: a render proves the class
 * list, and the class list is not what was wrong. What a browser measured is written above; this
 * holds the facts a later edit could quietly undo.
 */

const DIR = join(import.meta.dir, "../src/components/computer");

/**
 * Each file with its comments removed. The comments RECORD what went wrong — the pixel offsets and
 * the words "left rule" are both in them — so a test that read them would pass on the strength of
 * its own documentation.
 */
const strip = (name: string) =>
  readFileSync(join(DIR, name), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const view = strip("computer-view.tsx");
const teach = strip("teach-a-task.tsx");

describe("one left rule", () => {
  test("no row pads itself away from the card's own padding", () => {
    // `px-3` on a full-bleed row is what put its words 12px right of the picture above them.
    expect(view).not.toContain("px-3");
    expect(teach).not.toContain("px-3");
  });

  test("the recorded steps put their numbers on the rule rather than in a padding well", () => {
    expect(teach).not.toContain("px-6");
    expect(teach).toContain("list-inside");
  });

  test("the card carries the padding, once, for everything inside it", () => {
    expect(view).toContain('const CARD_PADDING = "p-2"');
    expect(view).toMatch(/rounded-2xl border \$\{CARD_PADDING\}/);
  });
});

describe("the picture is a complete rectangle", () => {
  test("it rounds and clips itself instead of borrowing the card's corners", () => {
    expect(view).toMatch(/overflow-hidden rounded-xl/);
  });

  test("the card no longer clips its children, so nothing is cut across", () => {
    // `overflow-hidden` on the figure is what made a panel's straight top edge read as the end of
    // the screen's shape.
    const figure = view.slice(
      view.indexOf("<figure"),
      view.indexOf("</figure>"),
    );
    expect(figure.slice(0, 200)).not.toContain("overflow-hidden");
  });
});

describe("what a keyboard sees", () => {
  test("every hand-rolled button in the card asks for a ring", () => {
    // Before: the browser's own `outline: auto 1px`, in the colour the base layer sets to 20%-alpha
    // black — which on the full-size view's black scrim is nothing at all.
    /*
     * Everything from one `<button` to the next, which is where its own props live. Matching the
     * opening tag itself does not work: the first `>` after `<button` belongs to the arrow in
     * `onClick={() => …}`, so a naive match stops before the class list and passes on nothing.
     */
    const handRolled = view.split("<button").slice(1);
    expect(handRolled.length).toBeGreaterThan(0);
    for (const button of handRolled) {
      expect(
        button.includes("FOCUS_RING") || button.includes("focus-visible:"),
      ).toBe(true);
    }
  });

  test("the ring is the one ui/button.tsx draws, not a second invention", () => {
    const primitive = readFileSync(
      join(import.meta.dir, "../src/components/ui/button.tsx"),
      "utf8",
    );
    for (const cls of [
      "focus-visible:border-ring",
      "focus-visible:ring-3",
      "focus-visible:ring-ring/50",
    ]) {
      expect(primitive).toContain(cls);
      expect(view).toContain(cls);
    }
  });

  test("the full-size view's backdrop rings inside itself, in white", () => {
    // It is the whole viewport: an ordinary ring is drawn outside it and clipped away.
    expect(view).toContain("focus-visible:ring-inset");
    expect(view).toContain("focus-visible:ring-white/70");
  });

  test("the pill controls are the shared primitive rather than more bespoke buttons", () => {
    expect(view).toContain('from "@/components/ui/button"');
    expect(teach).toContain('from "@/components/ui/button"');
    // Every filled control that used to be a hand-rolled `bg-primary` pill.
    expect(view).not.toContain("rounded-md bg-primary px-3 py-1");
    expect(teach).not.toContain("rounded-md bg-primary px-3 py-1");
  });
});

describe("waiting looks like everything else that is loading", () => {
  test("the first frame is a Skeleton, not a plain grey rectangle", () => {
    expect(view).toContain('from "@/components/ui/skeleton"');
    expect(view).toMatch(/<Skeleton[\s\S]{0,120}absolute inset-0/);
  });

  test("the frame keeps its aspect ratio while it waits", () => {
    // The Skeleton fills a box the ratio already reserved, so nothing reflows when a frame lands.
    expect(view).toContain("const DEFAULT_ASPECT_RATIO");
    expect(view).toContain("aspectRatio, minWidth, minHeight");
  });

  test("a person reading the page rather than looking at it is still told", () => {
    expect(view).toMatch(/sr-only[\s\S]{0,80}Waiting for the Bot's screen/);
  });

  test("waiting is only ever the state with nothing and no problem", () => {
    // A failed read is not a load: it says so in words instead of pulsing forever.
    expect(view).toContain(
      "const isLoadingFirstFrame = shot === null && problem === null",
    );
  });
});
