import { describe, expect, test } from "bun:test";
import {
  cutAtCodeUnits,
  cutOnGraphemes,
  sliceOnCharacters,
  soundText,
  soundValue,
} from "../shared/sound-text";

/**
 * HALF A CHARACTER IS NOT TEXT, AND NEITHER IS A NUL.
 *
 * `shared/sound-text.ts` has the measurements: Postgres refuses both in `jsonb`, and the Bots' own
 * model answers a request holding half an emoji with a 400. These are the three small functions
 * every cut and both doors are built from.
 */

const SMILE = "😀";
const [HIGH, LOW] = [SMILE.charAt(0), SMILE.charAt(1)];

describe("text made sound", () => {
  test("a half of a character becomes the mark for one, wherever it stands", () => {
    expect(soundText(`가${HIGH}`)).toBe("가�");
    expect(soundText(`${LOW}가`)).toBe("�가");
    expect(soundText(`가${HIGH}나${LOW}다`)).toBe("가�나�다");
    expect(soundText(`가${HIGH}`).isWellFormed()).toBe(true);
  });

  test("a NUL becomes the same mark", () => {
    expect(soundText("안녕\u0000하세요")).toBe("안녕�하세요");
  });

  test("text with neither is the same string, emoji and all", () => {
    for (const text of [
      "",
      "가게 😀 👨‍👩‍👧 🇰🇷",
      "tab\tand\nline",
      "a".repeat(50_000),
    ]) {
      expect(soundText(text)).toBe(text);
    }
  });
});

describe("a whole value made sound", () => {
  test("is the value itself when nothing in it needs mending", () => {
    const value = {
      text: "가게 😀",
      list: ["a", { deep: "b" }],
      when: new Date(0),
      count: 3,
      none: null,
    };
    // The same object, not a copy: the walk costs nothing but the look.
    expect(soundValue(value)).toBe(value);
    const list = ["a", "b"];
    expect(soundValue(list)).toBe(list);
    expect(soundValue(undefined)).toBe(undefined);
  });

  test("mends strings wherever they sit, keys included, and leaves the rest as it was", () => {
    const when = new Date(0);
    const mended = soundValue({
      [`k${HIGH}`]: "v",
      list: ["ok", `x${HIGH}`, { deep: "a\u0000b" }],
      when,
      count: 3,
    }) as Record<string, unknown>;
    expect(mended).toEqual({
      "k\ufffd": "v",
      list: ["ok", "x\ufffd", { deep: "a\ufffdb" }],
      when,
      count: 3,
    });
    // Not an object a serialiser would have to guess at: a Date stays the Date it was.
    expect(mended.when).toBe(when);
  });
});

describe("a cut by length", () => {
  test("lands between characters, never inside one", () => {
    const text = `${"가".repeat(9)}${SMILE}끝`;
    // Units: nine, then the emoji's two, then one. A cut at 10 would keep the emoji's first half.
    expect(cutAtCodeUnits(text, 10)).toBe("가".repeat(9));
    expect(cutAtCodeUnits(text, 11)).toBe(`${"가".repeat(9)}${SMILE}`);
    expect(cutAtCodeUnits(text, 9)).toBe("가".repeat(9));
    expect(cutAtCodeUnits(text, 10).isWellFormed()).toBe(true);
  });

  test("never exceeds what it was asked for, and leaves what fits alone", () => {
    for (let limit = 0; limit <= 14; limit += 1) {
      const cut = cutAtCodeUnits(`가나${SMILE}다${SMILE}${SMILE}라`, limit);
      expect(cut.length).toBeLessThanOrEqual(limit);
      expect(cut.isWellFormed()).toBe(true);
    }
    expect(cutAtCodeUnits(`가${SMILE}`, 3)).toBe(`가${SMILE}`);
    expect(cutAtCodeUnits(`가${SMILE}`, 99)).toBe(`가${SMILE}`);
    // Text that ended in a half before anybody cut it is not this function's to mend.
    expect(cutAtCodeUnits(`가${HIGH}`, 5)).toBe(`가${HIGH}`);
  });
});

describe("a part read out of a longer text", () => {
  const text = `${"a".repeat(9)}${SMILE}${"b".repeat(9)}${SMILE}c`;

  test("an end inside a character stops before it, a start inside one steps back to take it", () => {
    expect(sliceOnCharacters(text, 0, 10)).toBe("a".repeat(9));
    // The reader continues from 10, where the first part was asked to end: the emoji is here.
    expect(sliceOnCharacters(text, 10, 20)).toBe(`${SMILE}${"b".repeat(9)}`);
    expect(sliceOnCharacters(text, 0, 11)).toBe(`${"a".repeat(9)}${SMILE}`);
    expect(sliceOnCharacters(text, 11, 20)).toBe("b".repeat(9));
  });

  test("parts read one after another by their arithmetic hold every character once", () => {
    for (const size of [1, 2, 3, 5, 7, 10]) {
      let whole = "";
      for (let offset = 0; offset < text.length; offset += size) {
        const part = sliceOnCharacters(text, offset, offset + size);
        expect(part.isWellFormed()).toBe(true);
        whole += part;
      }
      expect(whole).toBe(text);
    }
  });

  test("past the end, and on text with no pairs, it is slice", () => {
    expect(sliceOnCharacters("가나다", 1, 99)).toBe("나다");
    expect(sliceOnCharacters("가나다", 5, 9)).toBe("");
    expect(sliceOnCharacters(text, 0, text.length)).toBe(text);
  });
});

describe("a line somebody reads, cut to fit", () => {
  test("holds whole characters as a person sees them, within the code points it was given", () => {
    const flag = "🇰🇷";
    const family = "👨‍👩‍👧";
    // A flag is two code points: room for one of them is room for neither.
    expect(cutOnGraphemes(`가나${flag}다`, 3)).toBe("가나");
    expect(cutOnGraphemes(`가나${flag}다`, 4)).toBe(`가나${flag}`);
    // A family of three is five.
    expect(cutOnGraphemes(`${family}끝`, 4)).toBe("");
    expect(cutOnGraphemes(`${family}끝`, 5)).toBe(family);
    expect(cutOnGraphemes("한글 abc", 99)).toBe("한글 abc");
    expect(cutOnGraphemes("한글", 0)).toBe("");
  });

  test("a character made endlessly long with marks cannot carry the line past its limit", () => {
    const stacked = `e${"\u0301".repeat(500)}`;
    expect(cutOnGraphemes(`가${stacked}나`, 10)).toBe("가");
  });
});
