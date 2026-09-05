import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Home's block is centred in the window, and a margin is not allowed to move it.
 *
 * `justify-center` was already there and a `mt-8` beside it was pushing everything 32px down inside
 * it: measured at 1280x1080 the greeting had 420px above and the composer 388px below, and the same
 * 32px skew held at every window height. It is the sort of margin that gets added to nudge a block
 * that was never centred, survives the change that centres it, and then reads as a mistake on the
 * one screen a person opens every time they start work. Now above and below match exactly — 264 at
 * 800, 314 at 900, 404 at 1080, 584 at 1440.
 *
 * The class list is read rather than rendered, for the reason `settings-frame.test.ts` gives: this
 * is a property of a frame, and an assertion that some div exists sees nothing about it. The pixels
 * were counted in a browser.
 */

const ROUTE = join(import.meta.dir, "../src/routes/_authed/_app/index.tsx");

/** Comments removed: `mt-8` is named in the note explaining why it went. */
const code = readFileSync(ROUTE, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the home block", () => {
  const outer = code.match(/className="flex w-full flex-1[^"]*"/)?.[0] ?? "";

  test("fills the window and centres in it", () => {
    expect(outer).toContain("flex-1");
    expect(outer).toContain("justify-center");
    expect(outer).toContain("items-center");
  });

  test("carries no top margin to lean the centring", () => {
    expect(outer).not.toMatch(/\bmt-\d/);
  });
});
