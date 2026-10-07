import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * A rule the boundaries screen offers, read out of the screen's own source.
 *
 * NOT COPIED INTO A TEST. A test that says "the preset" and holds its text is a test of the copy:
 * `gateway-file-paths.test.ts` held `!matches(file.path, "^notes/")` under the comment "as the
 * boundaries screen offers it", and would have gone on passing whatever the screen offered next.
 * The rule a person is handed is the one in `app/src/routes/_authed/admin/boundaries.tsx`, so that
 * is the one the real workspace is asked about — and the one the migration that rewrites a stored
 * copy is held to.
 *
 * Read as source, the way `app/tests/i18n-coverage.test.ts` reads these tables: the route is a
 * screen, and importing it here would bring the app with it.
 */
const SCREEN = join(
  import.meta.dir,
  "../../../app/src/routes/_authed/admin/boundaries.tsx",
);

export function presetOnTheScreen(label: string): string {
  const source = ts.createSourceFile(
    SCREEN,
    readFileSync(SCREEN, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );
  const rules: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const said = (key: string) => {
        for (const property of node.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            property.name.getText(source) === key &&
            ts.isStringLiteralLike(property.initializer)
          ) {
            return property.initializer.text;
          }
        }
        return undefined;
      };
      const rule = said("rule");
      if (said("label") === label && rule !== undefined) rules.push(rule);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const [rule, ...more] = rules;
  // None is a label that was reworded; two is a table this can no longer tell apart.
  if (rule === undefined || more.length > 0) {
    throw new Error(
      `The boundaries screen offers ${rules.length} rules labelled "${label}", and a test wants exactly one.`,
    );
  }
  return rule;
}

/** The label of the preset that exempts one folder from a question about writing. */
export const NOTES_PRESET = "Ask before writing a file outside notes/";

/**
 * What that preset wrote until 2026-10-07, and what v0.5.17 and everything before it ships.
 *
 * `matches` ignores letter case and a deployment's disk does not, so this does not ask about
 * `Notes/x.md`. ONE CONSTANT, the server's own (`policy-store.ts`): the parser that refuses the
 * rule, the tests that show its fault and the test that holds the migration's text to it all read
 * the same string.
 */
export { RETIRED_NOTES_RULE } from "../../src/computer/policy-store";

/**
 * Migration 0062's two statements, as its file has them — the comment lines gone, split where the
 * migrator splits, and each without its semicolon: the policy row's, then the allowances'.
 *
 * Read out of the file for the same reason the preset is read off the screen: the statements that
 * are held to their text, and the ones that are run over rows, are the ones a deployment runs.
 */
export function notesPresetMigration(): { policy: string; allowances: string } {
  const statements = readFileSync(
    join(import.meta.dir, "../../drizzle/0062_notes_preset_to_the_letter.sql"),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .map((part) =>
      part
        .split("\n")
        .filter((line) => !line.startsWith("--"))
        .join("\n")
        .trim()
        .replace(/;$/, ""),
    );
  const [policy, allowances, ...more] = statements;
  // A file that grew a third statement, or lost one, is not what a test here is about.
  if (
    policy === undefined ||
    allowances === undefined ||
    more.length > 0 ||
    !policy.startsWith('UPDATE "action_policy"') ||
    !allowances.startsWith('UPDATE "computer_standing_approvals"') ||
    statements.some((statement) => statement.includes(";"))
  ) {
    throw new Error(
      "Migration 0062 is no longer one UPDATE of action_policy and one of computer_standing_approvals.",
    );
  }
  return { policy, allowances };
}
