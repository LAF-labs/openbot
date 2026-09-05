import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ko } from "../src/lib/i18n-ko";

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

/**
 * The other half of the dictionary's promise: strings a screen reads through `t(variable)`.
 *
 * The walk above cannot see them, and neither can a person reviewing the diff, because the English
 * sits in a table that looks like configuration rather than like copy. Four such tables were
 * shipping untranslated — every heading and blurb on `/admin`, every filter button on the audit
 * trail, and both boundary preset lists, which is the screen where somebody decides what a Bot may
 * never do.
 *
 * Parsed from the source rather than imported, so this stays a read of files another change owns:
 * a table only has to be a table to be checked, not exported for the test's benefit.
 */
const TABLES: { file: string; table: string; least: number }[] = [
  { file: "routes/_authed/admin/index.tsx", table: "SECTIONS", least: 20 },
  { file: "routes/_authed/admin/audit.tsx", table: "FILTERS", least: 6 },
  { file: "routes/_authed/admin/boundaries.tsx", table: "PRESETS", least: 8 },
  {
    file: "routes/_authed/admin/boundaries.tsx",
    table: "ASK_PRESETS",
    least: 4,
  },
];

/**
 * The prose in one table literal, by key.
 *
 * By key and not "every string in the block" on purpose: a boundary preset carries its CEL `rule`
 * beside its `label`, and translating a rule would break the boundary rather than the sentence.
 */
function tableProse(file: string, table: string): string[] {
  const text = readFileSync(join(SOURCE, file), "utf8");
  const start = text.indexOf(`const ${table}`);
  if (start < 0) throw new Error(`${file} no longer declares ${table}`);
  const end = text.indexOf("\n]", start);
  if (end < 0) throw new Error(`${table} in ${file} has no end`);
  const block = text.slice(start, end);
  return [
    ...block.matchAll(
      /\b(?:label|title|description|cost)\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"/g,
    ),
  ]
    .map((match) => match[1] as string)
    .filter((value) => value.length > 0);
}

describe("tables the screens read through t(variable)", () => {
  test("every sentence in them has Korean", () => {
    const missing: string[] = [];
    for (const { file, table } of TABLES) {
      for (const value of tableProse(file, table)) {
        if (!(value in ko)) missing.push(`${table}: ${value}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("each table still parses to something", () => {
    // A renamed table or a reshaped entry would otherwise make the test above pass on nothing.
    for (const { file, table, least } of TABLES) {
      expect({
        table,
        found: tableProse(file, table).length >= least,
      }).toEqual({ table, found: true });
    }
  });
});

/**
 * The gallery's card names, which reach a person only when something has gone wrong.
 *
 * `t(spec.title)` is what a refusal card is headed with, so "Approval" in English is the heading
 * over the explanation of why a Korean reader was not asked. Loaded from the directory rather than
 * from `GALLERY_COMPONENTS`, whose `import.meta.glob` is a Vite transform and finds nothing here —
 * which would have made this test pass by walking an empty list.
 */
describe("the gallery's card names", () => {
  const directory = join(SOURCE, "components/gallery");
  const modules = readdirSync(directory).filter((entry) =>
    entry.endsWith(".tsx"),
  );

  test("every one has Korean", async () => {
    const missing: string[] = [];
    let found = 0;
    for (const entry of modules) {
      const module = (await import(join(directory, entry))) as {
        GALLERY?: { title: string }[];
      };
      for (const component of module.GALLERY ?? []) {
        found += 1;
        if (!(component.title in ko)) missing.push(component.title);
      }
    }
    expect({ missing, enough: found >= 12 }).toEqual({
      missing: [],
      enough: true,
    });
  });
});
