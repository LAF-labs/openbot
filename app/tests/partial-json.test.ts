import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { partialJSONParse } from "../src/lib/copilot/partial-json";

/**
 * WHAT A CARD SHOWS WHILE THE BOT IS STILL WRITING IT.
 *
 * `partial-json-prefixes.txt` is what the parser the app used until 2026-10-13 (`partial-json`
 * 0.1.7, through `@copilotkit/shared`) answered for EVERY prefix of ten sets of arguments shaped
 * like the ones the app draws — Korean text, quotes and newlines inside strings, a `</script>`,
 * negative and fractional and exponent numbers, `null`, empty lists. Each row is the whole text
 * and the lengths at which the answer changed. The port has to give the same answer at every
 * length: a card that grows a chunk later, or cuts a figure somewhere else, is a different card.
 */
type Row = { text: string; steps: [number, string][] };
const rows: Row[] = readFileSync(
  join(import.meta.dir, "partial-json-prefixes.txt"),
  "utf8",
)
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => JSON.parse(line) as Row);

describe("arguments read as far as they have been written", () => {
  test.each(rows.map((row) => [row.text.slice(0, 48), row] as const))(
    "every prefix of %s",
    (_label, row) => {
      expect(row.steps.length).toBeGreaterThan(0);
      let expected = "";
      let step = 0;
      for (let length = 0; length <= row.text.length; length++) {
        while (step < row.steps.length && row.steps[step]?.[0] === length) {
          expected = row.steps[step]?.[1] ?? "";
          step += 1;
        }
        expect({
          length,
          read: JSON.stringify(partialJSONParse(row.text.slice(0, length))),
        }).toEqual({ length, read: expected });
      }
      // Whole, it is what the Bot wrote.
      expect(partialJSONParse(row.text)).toEqual(JSON.parse(row.text));
    },
  );

  test("a string is shown as far as it goes, and a figure grows", () => {
    expect(
      partialJSONParse('{"title":"다음 주 예상","metrics":[{"value":"1,3'),
    ).toEqual({
      title: "다음 주 예상",
      metrics: [{ value: "1,3" }],
    });
    expect(partialJSONParse('{"n":12')).toEqual({ n: 12 });
    expect(partialJSONParse('{"n":123')).toEqual({ n: 123 });
  });

  test("a key with no value yet is not there, and neither is half a key", () => {
    expect(partialJSONParse('{"a":1,"b":')).toEqual({ a: 1 });
    expect(partialJSONParse('{"a":1,"b')).toEqual({ a: 1 });
    expect(partialJSONParse('{"a":-')).toEqual({});
  });

  test("an escape cut in two ends the string before it", () => {
    expect(partialJSONParse('{"a":"x\\u12')).toEqual({ a: "x" });
    expect(partialJSONParse('{"a":"x\\')).toEqual({ a: "x" });
  });

  test("a literal is completed from its first letters", () => {
    expect(partialJSONParse('{"a":tr')).toEqual({ a: true });
    expect(partialJSONParse('{"a":fal')).toEqual({ a: false });
    expect(partialJSONParse('{"a":nu')).toEqual({ a: null });
  });

  test("the oddities are the old parser's, kept", () => {
    // What follows a closed value is not read.
    expect(partialJSONParse('{"a":1} and more')).toEqual({ a: 1 });
    // A number that does not parse falls back to the text before the last `e` anywhere — here
    // not a number, so the value is left out and what came before it stays.
    expect(partialJSONParse('{"e": 5, "b": 1.')).toEqual({ e: 5 });
  });

  test.each([
    ["nothing yet", ""],
    ["blank", "  \n"],
    ["a list", "[1,2]"],
    ["a string", '"words"'],
    ["a number", "42"],
    ["not JSON", "<html>"],
  ])("%s is no arguments: an empty object", (_label, text) => {
    expect(partialJSONParse(text)).toEqual({});
  });

  test("what is not text at all is an empty object too", () => {
    expect(partialJSONParse(undefined)).toEqual({});
    expect(partialJSONParse({ a: 1 })).toEqual({});
  });
});
