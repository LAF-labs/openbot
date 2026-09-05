import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
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

/**
 * THE HALF THE DICTIONARY CANNOT SEE: ENGLISH THAT NEVER ASKED FOR A TRANSLATION.
 *
 * Everything above checks that a string handed to `t()` has Korean. It says nothing whatsoever about
 * a string that was never handed to `t()` at all, which is the failure that actually shipped — and
 * it shipped repeatedly, in every shape:
 *
 *   - a sentence sitting in JSX with no call around it (`/admin/boundaries`, three of them, one of
 *     them the line telling somebody their boundary had saved);
 *   - a ternary between two English strings (`"true, anything not refused above"`);
 *   - a paragraph assembled from JSX fragments around a `<strong>`, which `t()` structurally could
 *     not have reached (`/admin/computers`);
 *   - two words in a `title` attribute nobody reads until they hover.
 *
 * None of it is visible from a typecheck, from the coverage walk above, or from a screenshot of a
 * screen that is otherwise Korean. So this walks the JSX itself.
 *
 * WHAT IT LOOKS AT: text between tags, and the four attributes a person actually reads —
 * `placeholder`, `aria-label`, `title`, `alt`. Everything else on an element is machinery.
 *
 * WHAT COUNTS AS ENGLISH: two or more bare Latin words. One is a name, an identifier, a unit or a
 * `·`; two in a row is a sentence somebody wrote. That threshold is why `OK`, `refund_card`, a CEL
 * expression and a Tailwind class list do not trip it.
 *
 * WHAT IT DELIBERATELY DOES NOT REACH: a model-facing tool description, a JSON-schema `description`,
 * a `new Error(...)` message. Those are objects rather than JSX, and several of them are English on
 * purpose — the model reads them. A rule stretched to cover them would need an allowlist longer than
 * the thing it is checking, which is how a rule stops being read.
 *
 * The allowance below can only shrink: an entry for a file that is clean fails, so a fix cannot
 * leave its excuse behind.
 */
const JSX_SOURCE = join(import.meta.dir, "../src");

/** The attributes whose value is read by a person rather than by the browser. */
const SAID_TO_A_PERSON = new Set([
  "placeholder",
  "aria-label",
  "title",
  "alt",
  "aria-description",
  "aria-placeholder",
]);

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/**
 * A string being COMPARED is not a string being shown.
 *
 * `tool.reviewReason === "appeared after registration"` is the surface reading a code the server
 * sent, beside the `t()` call that says what it means. Flagging it would teach people that the rule
 * is noise, which is the only way a rule like this dies.
 */
function isComparison(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    ts.isBinaryExpression(parent) &&
    EQUALITY.has(parent.operatorToken.kind)
  ) {
    return true;
  }
  if (ts.isCaseClause(parent)) return true;
  if (
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression)
  ) {
    return ["includes", "startsWith", "endsWith", "has"].includes(
      parent.expression.name.text,
    );
  }
  return false;
}

function englishWords(value: string): number {
  return value
    .trim()
    .split(/\s+/)
    .filter((token) => /^[A-Za-z][A-Za-z'’-]*[.,!?:;]?$/.test(token)).length;
}

const isTranslateCall = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "t";

/** Every bare English string one `.tsx` file puts in front of a person. */
export function bareEnglishIn(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const say = (node: ts.Node, value: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    found.push(
      `${line + 1}: ${value.trim().replace(/\s+/g, " ").slice(0, 80)}`,
    );
  };

  /** Strings inside one expression, leaving anything a nested element owns to its own visit. */
  const stringsIn = (node: ts.Node): ts.StringLiteralLike[] => {
    const strings: ts.StringLiteralLike[] = [];
    const collect = (inner: ts.Node) => {
      if (isTranslateCall(inner)) return;
      if (ts.isJsxAttributes(inner) || ts.isJsxElement(inner)) return;
      if (
        (ts.isStringLiteral(inner) ||
          ts.isNoSubstitutionTemplateLiteral(inner)) &&
        !isComparison(inner)
      ) {
        strings.push(inner);
      }
      ts.forEachChild(inner, collect);
    };
    ts.forEachChild(node, collect);
    return strings;
  };

  const walk = (node: ts.Node) => {
    if (isTranslateCall(node)) return;

    if (ts.isJsxText(node) && englishWords(node.text) >= 2) {
      say(node, node.text);
    }

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText();
      const value = node.initializer;
      if (SAID_TO_A_PERSON.has(name) && value) {
        if (ts.isStringLiteral(value) && englishWords(value.text) >= 2) {
          say(node, `${name}="${value.text}"`);
        } else if (ts.isJsxExpression(value)) {
          for (const literal of stringsIn(value)) {
            if (englishWords(literal.text) >= 2) {
              say(literal, `${name}={"${literal.text}"}`);
            }
          }
        }
      }
      // Every other attribute is machinery: className, data-*, href, viewBox, d…
      return;
    }

    if (
      ts.isJsxExpression(node) &&
      node.parent &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      for (const literal of stringsIn(node)) {
        if (englishWords(literal.text) >= 2) say(literal, literal.text);
      }
    }

    ts.forEachChild(node, walk);
  };

  walk(source);
  return found;
}

/**
 * NOTHING IS ALLOWED TO BE BARE, and this is where that stopped being aspirational.
 *
 * There was one line, `tool-boundary.tsx`, and it was here because its sentence was built out of
 * JSX fragments around the component's name — the shape `t()` cannot reach, since no literal is
 * ever passed to anything. It is one `t("…{name}…", { name })` call now, and the table is empty.
 *
 * Empty and kept, not deleted. The two tests below are a ratchet: the budget for an unlisted file
 * is zero, so an empty table is the strictest this can be, and a line added back has to be argued
 * for in a diff rather than appearing as a default.
 */
const ALLOWED_BARE: Record<string, number> = {};

function jsxFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...jsxFiles(path));
      continue;
    }
    if (entry.endsWith(".tsx")) found.push(path);
  }
  return found;
}

function measureBare(): Record<string, string[]> {
  const counted: Record<string, string[]> = {};
  for (const path of jsxFiles(JSX_SOURCE)) {
    const file = relative(JSX_SOURCE, path);
    if (file.startsWith("lib/generated/")) continue;
    const leaks = bareEnglishIn(path, readFileSync(path, "utf8"));
    if (leaks.length > 0) counted[file] = leaks;
  }
  return counted;
}

describe("English the dictionary was never asked about", () => {
  const counted = measureBare();

  test("no screen has more bare English than it did", () => {
    const grown: string[] = [];
    for (const [file, leaks] of Object.entries(counted)) {
      const budget = ALLOWED_BARE[file] ?? 0;
      if (leaks.length > budget) {
        grown.push(
          `  ${file}: ${leaks.length} (allowed ${budget})\n${leaks
            .map((leak) => `      ${leak}`)
            .join("\n")}`,
        );
      }
    }
    expect(grown.join("\n")).toBe("");
  });

  test("an allowance that has been earned back is gone", () => {
    const stale = Object.keys(ALLOWED_BARE)
      .filter((file) => !(file in counted))
      .map(
        (file) =>
          `  ${file} is clean now — delete its line from ALLOWED_BARE so it cannot come back.`,
      );
    expect(stale.join("\n")).toBe("");
  });

  test("it still catches every shape this was written about", () => {
    /*
     * The rule is a walk over somebody else's AST, and the quiet way it dies is by silently matching
     * nothing — a renamed helper, a parser that stops recognising TSX, a `return` in the wrong
     * branch. So it is run against a file containing one of each leak this was written after, and
     * against the things that must NOT trip it.
     */
    const leaks = bareEnglishIn(
      "probe.tsx",
      [
        "export const Probe = ({ on, kind }: { on: boolean; kind: string }) => (",
        '  <div className="flex flex-col gap-2 rounded-lg border border-border">',
        "    <p>Saved. It applies to the next action any Bot takes.</p>",
        '    <span>{on ? "Changes apply to the next action" : "true, anything not refused"}</span>',
        '    <input aria-label="Search these rules" placeholder="Type a shop name" />',
        '    <button title="Remove this rule" type="button">OK</button>',
        '    <p>{t("Already translated, and left alone.")}</p>',
        "    <code>{'contains(element.name, \"submit\")'}</code>",
        '    <span>{kind === "appeared after registration" ? t("New") : t("Old")}</span>',
        "  </div>",
        ");",
      ].join("\n"),
    );
    expect(leaks.length).toBe(6);
    expect(leaks.join("\n")).toContain("Saved. It applies");
    expect(leaks.join("\n")).toContain("true, anything not refused");
    expect(leaks.join("\n")).toContain("aria-label=");
    expect(leaks.join("\n")).toContain("placeholder=");
    expect(leaks.join("\n")).toContain("title=");
    // And the four that must not: a `t()` call, a CEL expression, a comparison, and one word.
    expect(leaks.join("\n")).not.toContain("Already translated");
    expect(leaks.join("\n")).not.toContain("element.name");
    expect(leaks.join("\n")).not.toContain("appeared after registration");
  });

  test("it is reading the whole app, not a corner of it", () => {
    // A walker that stopped finding files would make the first test pass on nothing at all.
    expect(jsxFiles(JSX_SOURCE).length).toBeGreaterThan(100);
  });
});
