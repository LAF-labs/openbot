import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SHIMMER ON A RUNNING LINE KEEPS ITS WORDS.
 *
 * Measured 2026-09-24: "생각하는 중" and every running tool line were blank in both themes. The rule
 * set `color: transparent` to hollow the glyphs and built its gradient from `currentColor` — which
 * is that same `color` — so the computed gradient was `rgba(0, 0, 0, 0)` at every stop. The glyphs
 * are hollowed with `-webkit-text-fill-color` now, leaving `color` for the gradient and the icon.
 *
 * Read from the stylesheet because happy-dom resolves no gradient and clips no text: what a browser
 * draws was checked in one (computed ink `rgba(20, 20, 20, 0.6)` light, `rgba(252, 252, 252, 0.6)`
 * dark), and this keeps the rule from sliding back.
 */

const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");

/** Every declaration block for `.tool-line-running`, in source order. */
const blocks = [...css.matchAll(/\.tool-line-running\s*\{([^}]*)\}/g)].map(
  (match) => match[1] ?? "",
);

describe("the running line's shimmer", () => {
  test("hollows the glyphs with the fill, never with the colour its gradient is made of", () => {
    expect(blocks.length).toBe(2);
    const [shimmer] = blocks;
    expect(shimmer).toContain("currentColor");
    expect(shimmer).toContain("-webkit-text-fill-color: transparent");
    expect(shimmer).not.toMatch(/(^|[^-])color:\s*transparent/);
  });

  test("is solid again, in its own tone, when motion is reduced", () => {
    const reduced = blocks[1] ?? "";
    expect(reduced).toContain("background-image: none");
    expect(reduced).toContain("-webkit-text-fill-color: currentColor");
    // `color: inherit` here would overrule the tone class: the line would stop being muted.
    expect(reduced).not.toMatch(/(^|[^-])color:/);
  });
});
