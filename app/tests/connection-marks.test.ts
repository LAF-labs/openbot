import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUSINESS_SITES } from "../src/lib/sites/catalogue";
import {
  GENERIC_MARK,
  MARKS,
} from "../src/components/connections/connection-mark";
import { CATALOGUE_COPY } from "../src/lib/plugins/catalogue-copy";

/**
 * EVERY ROW ON 연결 SHOWED THE FIRST SYLLABLE OF ITS KOREAN NAME.
 *
 * 노 네 네 네 쿠 배 쿠 요 홈 당 캐 토 네 인 카 카 — sixteen tiles, five of them repeats, on the one
 * screen where somebody decides whether to hand a service their login. The tile was doing no work
 * at all, and the failure was invisible from the code: `name.trim().slice(0, 1)` is correct
 * JavaScript and reads fine in English.
 *
 * So the marks are a table, and this is what keeps the table honest in both directions: a service
 * naming a mark this build cannot draw falls back to a globe, silently, and a mark nothing names is
 * dead code nobody will ever notice. Neither is visible from a screenshot of a screen that mostly
 * looks right.
 */
/**
 * The mark component's source, without the comments explaining what it must not contain.
 *
 * The rules below are about what the component DOES; the block at the top of it names the two
 * things it avoids and why, and a check that could not tell those apart would fail on its own
 * documentation. `design-tokens.test.ts` and `account-state.test.ts` strip comments for the same
 * reason.
 */
function markSource(): string {
  return readFileSync(
    join(import.meta.dir, "../src/components/connections/connection-mark.tsx"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("the marks on the 연결 screen", () => {
  test("every site names a mark this build can draw", () => {
    const unknown = BUSINESS_SITES.filter((site) => !(site.mark in MARKS)).map(
      (site) => `${site.id}: ${site.mark}`,
    );
    expect(unknown).toEqual([]);
    // A catalogue that stopped exporting rows would pass the line above by walking nothing.
    expect(BUSINESS_SITES.length).toBeGreaterThanOrEqual(15);
  });

  test("every connector entry names one too", () => {
    const unknown = Object.entries(CATALOGUE_COPY)
      .filter(([, copy]) => !(copy.mark in MARKS))
      .map(([key, copy]) => `${key}: ${copy.mark}`);
    expect(unknown).toEqual([]);
    expect(Object.keys(CATALOGUE_COPY).length).toBeGreaterThanOrEqual(8);
  });

  test("no mark is drawn for nothing", () => {
    const used = new Set<string>([
      GENERIC_MARK,
      ...BUSINESS_SITES.map((site) => site.mark),
      ...Object.values(CATALOGUE_COPY).map((copy) => copy.mark),
    ]);
    const orphans = Object.keys(MARKS).filter((mark) => !used.has(mark));
    expect(orphans).toEqual([]);
  });

  test("no mark is a Korean syllable, and none is a single letter", () => {
    /*
     * The two halves of the bug, stated. One letter is what a "monogram" degenerates into when
     * nobody is looking, and 노 is what happens when the letter is taken off the front of the
     * translated name. Google and Naver keep a single Latin letter on purpose — that IS their mark
     * — so the rule is about Korean, plus a floor on the rest.
     */
    for (const [id, mark] of Object.entries(MARKS)) {
      if (!mark.letters) continue;
      expect({ id, korean: /[가-힣]/.test(mark.letters) }).toEqual({
        id,
        korean: false,
      });
      expect({ id, length: mark.letters.length >= 1 }).toEqual({
        id,
        length: true,
      });
    }
  });

  test("nothing is fetched to draw one", () => {
    /*
     * The reason the initial existed in the first place, and it has not gone away: twenty-four
     * remote logos on one screen is twenty-four ways for a row to be blank at the moment somebody
     * is deciding whether to trust it. Everything here is geometry in this bundle.
     */
    const source = markSource();
    expect(source).not.toInclude("http");
    expect(source).not.toInclude("<img");
    expect(source).not.toInclude("url(");
  });

  test("the ground is an attribute, never a style or an arbitrary class", () => {
    // Tailwind cannot emit a class it has not seen, and a `style` attribute is against the house
    // rule. An SVG `fill` is neither — which is why the tile is a rect rather than a div.
    const source = markSource();
    expect(source).not.toInclude("style={{");
    expect(source).not.toMatch(/\bbg-\[/);
  });
});
