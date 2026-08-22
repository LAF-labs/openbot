import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every user-facing string has Korean, and this is what says so.
 *
 * `t()` falls back to its English source when an entry is missing, which is the right behaviour at
 * runtime and a silent failure everywhere else: nothing throws, nothing logs, and the first person
 * to find out is a Korean reader looking at an English sentence. It has already happened twice in
 * one day — once when a duplicate key was removed and took the wrong half with it, once when a
 * `t()` was written around a string the server had already filled in.
 *
 * Only literal keys are checked. `t(variable)` and template literals cannot be resolved without
 * running the app, and a check that pretended otherwise would be worse than none.
 */

const DICTIONARY = join(import.meta.dir, "../src/lib/i18n-ko.ts");
const SOURCE = join(import.meta.dir, "../src");

/**
 * Words that are the same in Korean, so an entry would be the word again.
 *
 * Deliberately a short list of proper nouns and formats. Anything a sentence could be written
 * around does not belong here — "translating" it to itself is how a dictionary stops meaning
 * anything.
 */
const SAME_IN_KOREAN = new Set([
  "URL",
  "OpenAI",
  "HTML",
  "CSS",
  "JavaScript",
  "Google Drive",
]);

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !path.endsWith("i18n-ko.ts")) found.push(path);
  }
  return found;
}

describe("the Korean dictionary", () => {
  test("has an entry for every string the app asks it for", () => {
    const dictionary = readFileSync(DICTIONARY, "utf8");
    const translated = new Set([
      // Quoted keys, and bare ones for the words that happen to be valid identifiers.
      ...[...dictionary.matchAll(/^ {2}"((?:[^"\\]|\\.)*)":/gm)].map(
        (match) => match[1],
      ),
      ...[...dictionary.matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)].map(
        (match) => match[1],
      ),
    ]);

    const missing = new Map<string, string>();
    for (const path of sourceFiles(SOURCE)) {
      const text = readFileSync(path, "utf8");
      // `\bt(` does not match `format(`: there is no word boundary inside a word.
      for (const match of text.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        const key = match[1];
        if (!key || translated.has(key) || SAME_IN_KOREAN.has(key)) continue;
        if (!missing.has(key)) missing.set(key, path.replace(SOURCE, "src"));
      }
    }

    expect({
      missing: [...missing].map(([key, where]) => `${where}: ${key}`),
    }).toEqual({ missing: [] });
  });

  test("checks enough of the app to be worth having", () => {
    // A regex that silently stopped matching would make the test above pass for the wrong reason.
    const keys = new Set<string>();
    for (const path of sourceFiles(SOURCE)) {
      for (const match of readFileSync(path, "utf8").matchAll(
        /\bt\(\s*"((?:[^"\\]|\\.)*)"/g,
      )) {
        if (match[1]) keys.add(match[1]);
      }
    }
    expect(keys.size).toBeGreaterThan(400);
  });
});
