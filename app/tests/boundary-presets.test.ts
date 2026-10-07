import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { BOUNDARY_REFUSALS } from "../src/lib/computer/refusals";
import { ko } from "../src/lib/i18n-ko";

/**
 * NO RULE THE BOUNDARIES SCREEN HANDS A PERSON EXEMPTS BY A MATCH THAT IGNORES LETTER CASE.
 *
 * `matches` and `contains` ignore case on purpose — "never click submit" has to catch SUBMIT — and
 * a deployment's disk does not. That is safe where a rule forbids and unsafe where it exempts: the
 * "ask before writing a file outside notes/" preset was `!matches(file.path, "^notes/")` until
 * 2026-10-07, so a write to `Notes/x.md` was not asked about and made a second folder beside the
 * one the label names (pressed on the real computer, on what v0.5.17 ships). The same expression
 * was the example in the box where a person writes a rule of their own, teaching the shape.
 *
 * So the rules this screen puts in front of somebody are read here — both preset tables, and both
 * boxes' examples — and none may hold a loose match back with a negation. What a rule DOES in
 * front of the real workspace is `server/tests/gateway-file-paths.test.ts`, which reads the notes
 * preset off this same file; this is what keeps the shape from coming back under another label.
 *
 * Read as source, like the tables in `i18n-coverage.test.ts`: a route is a screen, and importing
 * one here would bring the app with it.
 */
const SCREEN = join(
  import.meta.dir,
  "../src/routes/_authed/admin/boundaries.tsx",
);
const TEXT = readFileSync(SCREEN, "utf8");
const SOURCE = ts.createSourceFile(
  SCREEN,
  TEXT,
  ts.ScriptTarget.ESNext,
  true,
  ts.ScriptKind.TSX,
);

type Preset = { label: string; rule: string; cost: string };

/** The entries of one preset table, by the keys a row is drawn from. */
function presetsIn(table: string): Preset[] {
  const found: Preset[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(SOURCE) === table &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const entry of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(entry)) continue;
        const said = (key: string) => {
          for (const property of entry.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              property.name.getText(SOURCE) === key &&
              ts.isStringLiteralLike(property.initializer)
            ) {
              return property.initializer.text;
            }
          }
          return "";
        };
        found.push({
          label: said("label"),
          rule: said("rule"),
          cost: said("cost"),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(SOURCE);
  return found;
}

/** The example each rule box shows before anything is typed into it: a rule, written out. */
function examplesInTheBoxes(): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(SOURCE) === "placeholder" &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      found.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(SOURCE);
  return found;
}

/**
 * Whether a rule exempts something by `matches` or `contains`.
 *
 * In `deny` and `ask` a rule holds an action back where it is TRUE, so what it lets through is
 * whatever makes it false — and a loose match does that under a negation, or compared to a
 * boolean. `!=` is not a negation of one: it is the exact comparison that is the way to exempt.
 *
 * COARSER THAN A PARSER, ON PURPOSE. A rule that negates anything and uses a loose match
 * anywhere is held up, whether or not the one covers the other: six rules live here, a false alarm
 * costs somebody one sentence in a diff, and a miss is a boundary that is walked past.
 *
 * AND NOT A PROOF. A pattern can say "everything but" in ways nobody can list — `^[^n]`, an
 * alternation of every other folder. This sees a negation, a comparison to a boolean, a choice
 * between two answers, and a look-around that holds where the text is absent; a rule that exempts
 * some other way is caught by what it does in front of the workspace, or not at all.
 */
function exemptsByALooseMatch(rule: string): boolean {
  const STRINGS = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  // What is inside a string is data: an `!` there negates nothing…
  const bare = rule.replace(STRINGS, '""');
  const isLoose = /\b(?:matches|contains)\s*\(/.test(bare);
  const negates = /!(?!=)/.test(bare);
  const comparesToABoolean =
    /(?:==|!=)\s*(?:true|false)\b|\b(?:true|false)\s*(?:==|!=)/.test(bare);
  // …or picks between two answers by one, which is the same thing said with `? :`.
  const choosesBetween = bare.includes("?");
  // …unless the string is a PATTERN that says "not" itself: `^(?!notes/)` matches where the
  // folder is absent. An independent read wrote the old preset that way and this let it by.
  const patternSaysNot = (rule.match(STRINGS) ?? []).some((text) =>
    /\(\?<?!/.test(text),
  );
  return (
    isLoose &&
    (negates || comparesToABoolean || choosesBetween || patternSaysNot)
  );
}

const NOTES = "Ask before writing a file outside notes/";
/** What that preset wrote, and what both boxes' sibling taught, until 2026-10-07. */
const RETIRED = 'intent == "write_file" && !matches(file.path, "^notes/")';

describe("the rules the boundaries screen hands a person", () => {
  const offered = [...presetsIn("PRESETS"), ...presetsIn("ASK_PRESETS")];
  const taught = examplesInTheBoxes();

  test("none of them — in either table or as either box's example — exempts by a match that ignores letter case", () => {
    // A table renamed, or a box redrawn, would otherwise leave this passing on nothing.
    expect(offered.length).toBeGreaterThanOrEqual(6);
    expect(offered.every((preset) => preset.label && preset.rule)).toBe(true);
    expect(taught.length).toBeGreaterThanOrEqual(2);
    expect(
      [
        ...offered.map((preset) => `${preset.label}: ${preset.rule}`),
        ...taught.map((rule) => `a box's example: ${rule}`),
      ].filter(exemptsByALooseMatch),
    ).toEqual([]);
  });

  test("the check still sees every shape it was written about", () => {
    for (const caught of [
      RETIRED,
      'intent == "write_file" && ! matches(file.path, "^notes/")',
      'intent == "write_file" && !(matches(file.path, "^notes/"))',
      'intent == "write_file" && !matches(file.folder, "^notes$")',
      'intent == "navigate" && !contains(page.host, "ourshop.kr")',
      '!(intent == "read_file" || contains(file.path, "notes/"))',
      'intent == "write_file" && matches(file.path, "^notes/") == false',
      'intent == "write_file" && matches(file.path, "^notes/") != true',
      'false == contains(file.name, "draft")',
      // The negation inside the pattern, and the same exemption as a choice.
      'intent == "write_file" && matches(file.path, "^(?!notes/)")',
      'intent == "write_file" && matches(file.path, "(?<!notes)/x[.]md$")',
      'intent == "write_file" && (matches(file.path, "^notes/") ? false : true)',
    ]) {
      expect(`${caught} · ${exemptsByALooseMatch(caught)}`).toBe(
        `${caught} · true`,
      );
    }
    for (const fine of [
      // The exact comparison, which is the way to exempt — a `!` followed by `=` negates nothing.
      'intent == "write_file" && file.folder != "notes"',
      'bot.id != "bot-1" && contains(element.name, "submit")',
      // A loose match that forbids, as every other rule on the screen is.
      'intent == "navigate" && (contains(page.host, "facebook.com") || contains(page.host, "x.com"))',
      '(intent == "activate" && contains(element.name, "submit")) || (tool.name == "computer_key" && key == "Enter") || submit',
      // A negation with no loose match beside it, and an `!` that is only a letter of a string.
      'intent == "type" && !submit',
      'contains(element.name, "지금 결제!")',
      "repeat.count >= 10",
    ]) {
      expect(`${fine} · ${exemptsByALooseMatch(fine)}`).toBe(`${fine} · false`);
    }
  });

  test("the expression the notes preset used to write is nowhere on the screen: not offered, not taught, not given a name", () => {
    // `glossOf` puts a preset's label over a rule that equals the preset's. The old expression
    // under "…outside notes/" would be a label saying what the rule does not do — so it is not in
    // the file at all, and a stored one shows bare, as the hand-written rule it now is.
    expect(TEXT.includes(RETIRED)).toBe(false);
    expect(offered.filter((preset) => preset.rule === RETIRED)).toEqual([]);
    expect(taught).not.toContain(RETIRED);
  });

  test("the notes preset compares the folder exactly, and says so in both languages", () => {
    const [preset, ...more] = offered.filter(
      (preset) => preset.label === NOTES,
    );
    expect(more).toEqual([]);
    expect(preset?.rule).toBe(
      'intent == "write_file" && file.folder != "notes"',
    );
    // The one thing a person has to be told about it: another lettering is another folder.
    const cost = preset?.cost ?? "";
    expect(cost).toContain("to the letter");
    expect(cost).toContain("Notes/");
    expect(ko[cost]).toContain("글자 그대로");
    expect(ko[cost]).toContain("Notes/");
    // And it is the example the box for a rule of one's own shows, in place of the old one.
    expect(taught).toContain(preset?.rule);
    // The label says "writing a file", and the cost says which files that is not: the ones the
    // computer or the server puts in the folder, with no question of this kind in front of them.
    // (What a small program makes is not among them: it is filed through the same decision as a
    // write, which `server/tests/workbench-gateway.test.ts` holds.)
    expect(cost).toContain("a download");
    expect(cost).toContain("attaches");
    expect(cost).toContain("set aside");
    expect(cost).not.toContain("script");
    expect(cost).not.toContain("program");
    expect(ko[cost]).toContain("내려받은 파일");
    expect(ko[cost]).toContain("첨부");
    expect(ko[cost]).toContain("따로 보관한");
  });

  test("the words for the rule the server no longer takes name the rule this preset writes, to the letter", () => {
    // Somebody who typed the old rule in by hand is told what to type instead, and it is the rule
    // this screen offers — a sentence that named another would send them to a third.
    const [preset] = offered.filter((preset) => preset.label === NOTES);
    const said = BOUNDARY_REFUSALS["laf:policy_rule_retired"] ?? "";
    expect(preset?.rule).toBeTruthy();
    expect(said.endsWith(`: ${preset?.rule}`)).toBe(true);
    expect((ko[said] ?? "").endsWith(`: ${preset?.rule}`)).toBe(true);
    // It describes the old rule and does not spell it out: this screen holds it nowhere.
    expect(said).not.toContain("!matches");
    expect(ko[said]).not.toContain("!matches");
  });
});
