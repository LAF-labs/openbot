import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * OUR POINTER ON THE BOT'S SCREEN, AS THE STYLESHEET AND THE PICTURES HAVE TO AGREE.
 *
 * A cursor is the one picture a test cannot look at: no screenshot holds it. What can be held is
 * what makes a press land where the picture points — the hotspot is written once per value and the
 * pictures are the sizes that hotspot was measured in — and what an engine falls back on when it
 * will not draw one.
 */

const app = resolve(import.meta.dir, "..");
const sheet = readFileSync(resolve(app, "src/styles.css"), "utf8");

/** Every value given to `cursor` in a rule for `selector`, whitespace folded. */
function cursorValuesOf(selector: string): string[] {
  const values: string[] = [];
  const rule = new RegExp(`\\.${selector} \\{\\s*cursor:([^;]+);\\s*\\}`, "g");
  for (const match of sheet.matchAll(rule)) {
    values.push((match[1] ?? "").replace(/\s+/g, " ").trim());
  }
  return values;
}

/** A PNG's pixel size, read from its header. */
function sizeOf(file: string): [number, number] {
  const bytes = readFileSync(resolve(app, "src/assets/cursors", file));
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("the pointer a person drives the Bot's browser with", () => {
  test("every value points with the tip, and ends on the system's crosshair", () => {
    for (const selector of ["cursor-wheel", "cursor-wheel-pressed"]) {
      const values = cursorValuesOf(selector);
      // The plain picture, the pair under WebKit's older name, the pair under its own.
      expect([selector, values.length]).toEqual([selector, 3]);
      for (const value of values) {
        expect([selector, value.endsWith(") 4 3, crosshair")]).toEqual([
          selector,
          true,
        ]);
      }
      expect(values[0]?.startsWith("url(")).toBe(true);
      expect(values[1]?.startsWith("-webkit-image-set(")).toBe(true);
      expect(values[2]?.startsWith("image-set(")).toBe(true);
    }
  });

  test("a pair is the picture and the same picture at twice the pixels, each a file of its own", () => {
    for (const [selector, name] of [
      ["cursor-wheel", "wheel"],
      ["cursor-wheel-pressed", "wheel-pressed"],
    ] as const) {
      for (const value of cursorValuesOf(selector).slice(1)) {
        // Not folded into the stylesheet: measured, the four pictures inline added 11 kB gzipped
        // to a 38 kB sheet every screen loads, for a pointer only a takeover draws.
        expect(value).toContain(
          `url("./assets/cursors/${name}.png?no-inline") 1x`,
        );
        expect(value).toContain(
          `url("./assets/cursors/${name}-2x.png?no-inline") 2x`,
        );
      }
      // The hotspot 4 3 is measured in this box; the second picture is the same box, twice as fine.
      expect(sizeOf(`${name}.png`)).toEqual([32, 32]);
      expect(sizeOf(`${name}-2x.png`)).toEqual([64, 64]);
    }
  });

  test("the pair is behind a question the engine answers, so a minifier cannot leave only the last", () => {
    expect(
      sheet.match(/@supports \(\s*cursor:\s*-webkit-image-set\(/g)?.length,
    ).toBe(1);
    expect(sheet.match(/@supports \(\s*cursor:\s*image-set\(/g)?.length).toBe(
      1,
    );
  });
});
