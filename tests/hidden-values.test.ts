import { describe, expect, test } from "bun:test";
import {
  BYTES_AS_TEXT,
  blankerOf,
  HIDDEN,
  patternOf,
} from "../shared/hidden-values";

/*
 * THE ONE RULE FOR HIDING A VALUE IN TEXT (`shared/hidden-values.ts`), read by the Bot's computer
 * for what it put into a page and by the server for a person's saved passwords. How a single value
 * is looked for is written down at length where it was first measured
 * (`agent-computer/tests/filled-values.test.ts`); here is what both readers lean on together.
 * The values are made up for these tests.
 */
describe("values taken out of text by the rule both sides read", () => {
  test("each of them, the longest first, in either case — and nothing when none can be looked for", () => {
    const blank = blankerOf(["hunter2", "hunter2!!", "hunter2"]);
    expect(blank?.("HUNTER2!! and hunter2")).toBe(`${HIDDEN} and ${HIDDEN}`);
    // Too short to hunt through a sentence, each of them: there is nothing to do.
    expect(blankerOf(["abc", "x"])).toBeNull();
    expect(blankerOf([])).toBeNull();
    expect(patternOf("abc")).toBeNull();
  });

  /*
   * The server judges every act by the host it is on. An address answered as
   * `https://[•••].tistory.com/` is no address, and the Bot is shut out of the site it was just
   * signed in to — so the site of a string that is one address is left standing, for both readers.
   */
  test("the site of an address is left standing, and what is written before and after it is looked in", () => {
    const blank = blankerOf(["gibeom"]);
    expect(blank?.("https://gibeom.tistory.com/manage?id=gibeom#gibeom")).toBe(
      `https://gibeom.tistory.com/manage?id=${HIDDEN}#${HIDDEN}`,
    );
    expect(blank?.("https://gibeom:pw@example.com/")).toBe(
      `https://${HIDDEN}:pw@example.com/`,
    );
    // An address in a sentence is the page's words, site and all.
    expect(blank?.("블로그: https://gibeom.tistory.com/")).toBe(
      `블로그: https://${HIDDEN}.tistory.com/`,
    );
  });

  test("bytes written as text are named once, for whoever walks an answer", () => {
    expect([...BYTES_AS_TEXT]).toEqual(["base64"]);
  });
});
