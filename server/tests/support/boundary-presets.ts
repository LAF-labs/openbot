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
 * `Notes/x.md`. Kept here, spelled out, for the two things that are about the old text itself: the
 * test that shows the fault, and the migration that rewrites a stored copy of it.
 */
export const RETIRED_NOTES_RULE =
  'intent == "write_file" && !matches(file.path, "^notes/")';
