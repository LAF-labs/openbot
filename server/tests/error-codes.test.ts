import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Every refusal these routes answer with is a fact code, never a sentence.
 *
 * Audit A1-3 (2026-09-10) counted the wire: of thirty-six refusals the server core could produce,
 * fourteen carried a `laf:` code and twenty-two were English prose — "Channel not found.", "The
 * daily time must be HH:MM.", "You do not have permission to manage this agent." A Korean surface
 * cannot name a sentence; it renders whatever the server wrote, in the wrong language, on the
 * screen of somebody who runs a shop. "The server sends facts; the surface owns the words"
 * (CLAUDE.md) was half kept.
 *
 * So this walks the route and service files and refuses the two shapes a sentence took:
 *
 *   - ANY `error:` property written as a string that is not a `laf:` code. A parser's refusal is
 *     a response body one careless line away, so it is held to the same rule as the body.
 *   - A response body — the first argument of `.json(…)`, or a mapper's `body:` — whose `error`
 *     is anything but a code: a `laf:` literal, something's `.code`, or a constant. `.message`,
 *     `.reason`, `.error`, a template, a call: each of those is how a sentence decided somewhere
 *     else arrives on the wire, and each was on the wire.
 *
 * A source walk rather than a live server: it sees every branch, including the ones a test server
 * never happens to take — the same shape as the app's `agent-refusals.test.ts`.
 */

const SRC = join(import.meta.dir, "../src");
const ROOTS = [
  "channels",
  "rooms",
  "routines",
  "account",
  "notifications",
  "agents",
];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

type Offender = { where: string; text: string };

const propertyName = (property: ts.ObjectLiteralElementLike) =>
  (ts.isPropertyAssignment(property) ||
    ts.isShorthandPropertyAssignment(property)) &&
  (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ? property.name.text
    : null;

/** Whether an expression can only ever be a code. See the module note for the three shapes. */
function isCodeShaped(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isCodeShaped(expression.expression);
  }
  if (ts.isStringLiteral(expression)) return expression.text.startsWith("laf:");
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "code";
  }
  if (ts.isIdentifier(expression)) {
    return (
      expression.text === "code" || /^[A-Z][A-Z0-9_]*$/.test(expression.text)
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      isCodeShaped(expression.whenTrue) && isCodeShaped(expression.whenFalse)
    );
  }
  return false;
}

/** Whether this object literal is a response body: `.json(it, …)` or a mapper's `body: it`. */
function isResponseBody(node: ts.ObjectLiteralExpression): boolean {
  const parent = node.parent;
  if (
    ts.isCallExpression(parent) &&
    parent.arguments[0] === node &&
    ts.isPropertyAccessExpression(parent.expression) &&
    parent.expression.name.text === "json"
  ) {
    return true;
  }
  return (
    ts.isPropertyAssignment(parent) &&
    ts.isIdentifier(parent.name) &&
    parent.name.text === "body"
  );
}

function offendersIn(
  file: string,
  text = readFileSync(file, "utf8"),
): { offenders: Offender[]; bodies: number } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const offenders: Offender[] = [];
  let bodies = 0;
  const at = (node: ts.Node) =>
    `${relative(SRC, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const body = isResponseBody(node);
      for (const property of node.properties) {
        if (propertyName(property) !== "error") continue;
        if (ts.isShorthandPropertyAssignment(property)) {
          if (body) offenders.push({ where: at(property), text: "error" });
          continue;
        }
        if (!ts.isPropertyAssignment(property)) continue;
        if (body) bodies += 1;
        const value = property.initializer;
        const written =
          ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
            ? value.text
            : ts.isTemplateExpression(value)
              ? value.getText(source)
              : null;
        if (written !== null && !written.startsWith("laf:")) {
          offenders.push({ where: at(value), text: written });
          continue;
        }
        if (body && !isCodeShaped(value)) {
          offenders.push({ where: at(value), text: value.getText(source) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { offenders, bodies };
}

describe("route refusals are fact codes", () => {
  test("no refusal in the server core is a sentence", () => {
    const offenders: Offender[] = [];
    let files = 0;
    let bodies = 0;
    for (const root of ROOTS) {
      for (const file of sourceFiles(join(SRC, root))) {
        files += 1;
        const found = offendersIn(file);
        offenders.push(...found.offenders);
        bodies += found.bodies;
      }
    }

    expect(offenders.map(({ where, text }) => `${where}: ${text}`)).toEqual([]);
    // The walk reached the files and found the bodies, so green is coverage and not an empty glob.
    expect(files).toBeGreaterThan(40);
    expect(bodies).toBeGreaterThan(30);
  });

  test("the walk refuses each shape a sentence took to the wire", () => {
    // The walker is checked against the shapes the audit found, so a regression in the walker
    // cannot pass as a clean tree.
    const { offenders, bodies } = offendersIn(
      join(SRC, "fixture.ts"),
      [
        'context.json({ error: "Channel not found." }, 404);',
        "context.json({ error: error.message, code: error.code }, 400);",
        "context.json({ error: parsed.error, code: parsed.code }, 400);",
        "const mapped = { body: { error: error.message }, status: 400 };",
        "const parsed = { ok: false, error: `Days must be ${low} to ${high}.` };",
        'context.json({ error: "laf:channel_not_found", code: "laf:channel_not_found" }, 404);',
        "context.json({ error: error.code, code: error.code }, error.status);",
        "context.json({ error: NOT_FOUND, code: NOT_FOUND }, 404);",
      ].join("\n"),
    );
    expect(offenders.map(({ where }) => where)).toEqual(
      [1, 2, 3, 4, 5].map((line) => `fixture.ts:${line}`),
    );
    expect(bodies).toBe(7);
  });
});
