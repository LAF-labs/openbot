import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Every refusal the server answers with is a fact code, never a sentence.
 *
 * Audit A1-3 (2026-09-10) counted the wire: of thirty-six refusals the server core could produce,
 * fourteen carried a `laf:` code and twenty-two were English prose — "Channel not found.", "The
 * daily time must be HH:MM.", "You do not have permission to manage this agent." A Korean surface
 * cannot name a sentence; it renders whatever the server wrote, in the wrong language, on the
 * screen of somebody who runs a shop. "The server sends facts; the surface owns the words"
 * (CLAUDE.md) was half kept.
 *
 * AND THEN IT WAS KEPT ONLY WHERE IT WAS LOOKED FOR. This walk began with six directories (W1-e),
 * and the rehearsal VM measured the difference between the walk and the wire on 2026-09-13: the
 * walk said none, and every protected route on the VM answered an anonymous caller
 * `{"error":"Authentication required."}` — from `auth/guards.ts`, outside all six. The same walker
 * pointed at the whole of `server/src` found 103 more. So it walks all of it now, and a file is
 * left out only by name, below, with the reason beside it.
 *
 * The shapes a sentence took to the wire, and what this refuses:
 *
 *   - ANY `error:` property written as a string that is not a `laf:` code. A parser's refusal is
 *     a response body one careless line away, so it is held to the same rule as the body.
 *   - A response body — the first argument of `.json(…)`, or a mapper's `body:` — whose `error` or
 *     `message` is anything but a code: a `laf:` literal, something's `.code`, or a constant.
 *     `.message`, `.reason`, `.error`, a template, a call: each of those is how a sentence decided
 *     somewhere else arrives on the wire, and each was on the wire.
 *   - A `message:` written as a sentence in the options an error is CONSTRUCTED with —
 *     better-auth's `new APIError("FORBIDDEN", { message })` is sent to the browser as the body.
 *   - A sentence answered as plain text beside an error status: `.text("…", 4xx)` and
 *     `new Response("…", { status: 4xx })`.
 *
 * NOT HERE: what a Bot's tool hands back to the MODEL as a successful call's result
 * (`McpCallResult.text` from a vendor adapter, 200). That is the model's reading, the vendor's own
 * words are kept in it on purpose (`plugins/rest-support.ts`), and the model-facing codes have their
 * own table and walk (`shared/prompt/tool-results.ko.ts`, `app/tests/tool-result-codes.test.ts`).
 *
 * A source walk rather than a live server: it sees every branch, including the ones a test server
 * never happens to take — the same shape as the app's `agent-refusals.test.ts`. The live half is the
 * authorization matrix, which asserts a code on every refusal its 568 cells meet.
 */

const SRC = join(import.meta.dir, "../src");

/**
 * The files this walk does not read, by path under `server/src`, each with its reason.
 *
 * ONLY THESE TWO, and only while another change has them open: wave 2's W2-b is restructuring
 * `main.ts` and `config.ts` (moving every environment read into `config.ts`) at the same time as
 * this walk was widened, and two changes rewriting the same lines is how one of them is lost. The
 * prose they still hold is listed in that change's hand-off — `main.ts` answers the live screen's
 * socket with "No computer is configured." and "Expected a WebSocket upgrade." — and the line
 * comes out of this table when it lands.
 */
const NOT_WALKED: Record<string, string> = {
  "main.ts": "being restructured by W2-b (wave 2, 2026-09-14)",
  "config.ts": "being restructured by W2-b (wave 2, 2026-09-14)",
};

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

/** The two fields a refusal's words ride in. */
const CARRIERS = new Set(["error", "message"]);

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

/** `new Response(…)`, which is how an answer is written where Hono's context is not there. */
const isNewResponse = (node: ts.Node): node is ts.NewExpression =>
  ts.isNewExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "Response";

/**
 * Whether this object literal is a response body: `.json(it, …)`, a mapper's `body: it`,
 * `new Response(JSON.stringify(it), …)` — or the object a body's own `error` or `message` holds,
 * which is the same sentence one level down.
 */
function isResponseBody(node: ts.ObjectLiteralExpression): boolean {
  const parent = node.parent;
  if (
    ts.isCallExpression(parent) &&
    parent.arguments[0] === node &&
    ts.isPropertyAccessExpression(parent.expression)
  ) {
    const callee = parent.expression;
    if (callee.name.text === "json") return true;
    if (
      callee.name.text === "stringify" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "JSON" &&
      isNewResponse(parent.parent) &&
      parent.parent.arguments?.[0] === parent
    ) {
      return true;
    }
  }
  if (!ts.isPropertyAssignment(parent)) return false;
  const name = propertyName(parent);
  if (name === "body") return true;
  return (
    name !== null &&
    CARRIERS.has(name) &&
    ts.isObjectLiteralExpression(parent.parent) &&
    isResponseBody(parent.parent)
  );
}

/** Whether this object literal is an argument an error is constructed with: `new X(…, { … })`. */
const isConstructorOptions = (node: ts.ObjectLiteralExpression) =>
  ts.isNewExpression(node.parent) &&
  (node.parent.arguments ?? []).some((argument) => argument === node);

/** The text of a string written in place, or null for anything computed. */
function writtenText(
  value: ts.Expression,
  source: ts.SourceFile,
): string | null {
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return value.text;
  }
  return ts.isTemplateExpression(value) ? value.getText(source) : null;
}

/** A numeric literal of 400 or more, which is what makes a plain-text answer a refusal. */
const isErrorStatus = (expression: ts.Expression | undefined) =>
  !!expression &&
  ts.isNumericLiteral(expression) &&
  Number(expression.text) >= 400;

/** `{ status: 4xx }`, the second argument of `new Response(…)`. */
const hasErrorStatus = (expression: ts.Expression | undefined) =>
  !!expression &&
  ts.isObjectLiteralExpression(expression) &&
  expression.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyName(property) === "status" &&
      isErrorStatus(property.initializer),
  );

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
      const constructed = isConstructorOptions(node);
      for (const property of node.properties) {
        const name = propertyName(property);
        if (name === null || !CARRIERS.has(name)) continue;
        // A `message` is somebody's chat line or a log field until it is on its way out.
        if (name === "message" && !body && !constructed) continue;
        if (ts.isShorthandPropertyAssignment(property)) {
          if (body) offenders.push({ where: at(property), text: name });
          continue;
        }
        if (!ts.isPropertyAssignment(property)) continue;
        if (body && name === "error") bodies += 1;
        const value = property.initializer;
        const written = writtenText(value, source);
        if (written !== null && !written.startsWith("laf:")) {
          offenders.push({ where: at(value), text: written });
          continue;
        }
        // An object is not a sentence — a vendor's request `body: { message: {…} }` is not an
        // answer — and what it holds is walked as a body of its own (see `isResponseBody`).
        if (ts.isObjectLiteralExpression(value)) continue;
        if (body && !isCodeShaped(value)) {
          offenders.push({ where: at(value), text: value.getText(source) });
        }
      }

      /*
       * And the code is in `code`. `{ error: "laf:feedback_empty" }` passes every rule above, and a
       * reader that looks where the rest of the server puts the fact finds nothing. A spread may
       * carry it (`...refusal.facts`), so a body with one is taken at its word.
       */
      const named = new Set(node.properties.map(propertyName));
      if (
        body &&
        named.has("error") &&
        !named.has("code") &&
        !node.properties.some(ts.isSpreadAssignment)
      ) {
        offenders.push({ where: at(node), text: "an error with no code" });
      }
    }

    // Plain text beside an error status: `.text("…", 4xx)` and `new Response("…", { status })`.
    const plain =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "text" &&
      isErrorStatus(node.arguments[1])
        ? node.arguments[0]
        : isNewResponse(node) && hasErrorStatus(node.arguments?.[1])
          ? node.arguments?.[0]
          : undefined;
    if (
      plain &&
      plain.kind !== ts.SyntaxKind.NullKeyword &&
      // `JSON.stringify({ … })` is a body, and its object is walked as one above.
      !(
        ts.isCallExpression(plain) &&
        plain.expression.getText(source) === "JSON.stringify"
      ) &&
      !isCodeShaped(plain)
    ) {
      offenders.push({
        where: at(plain),
        text: writtenText(plain, source) ?? plain.getText(source),
      });
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return { offenders, bodies };
}

describe("route refusals are fact codes", () => {
  test("no refusal anywhere in the server is a sentence", () => {
    const offenders: Offender[] = [];
    let files = 0;
    let bodies = 0;
    for (const file of sourceFiles(SRC)) {
      if (relative(SRC, file) in NOT_WALKED) continue;
      files += 1;
      const found = offendersIn(file);
      offenders.push(...found.offenders);
      bodies += found.bodies;
    }

    expect(offenders.map(({ where, text }) => `${where}: ${text}`)).toEqual([]);
    // The walk reached the files and found the bodies, so green is coverage and not an empty glob:
    // 206 files and 130 refusal bodies on the day it widened (2026-09-14), where the six-directory
    // walk read 50-odd.
    expect(files).toBeGreaterThan(190);
    expect(bodies).toBeGreaterThan(120);
  });

  test("leaves out only the two files being restructured, and both are still there", () => {
    // A file renamed out from under this table would leave its successor walked and the entry
    // naming nothing; a third entry would be the walk quietly narrowing again.
    expect(Object.keys(NOT_WALKED).sort()).toEqual(["config.ts", "main.ts"]);
    for (const path of Object.keys(NOT_WALKED)) {
      expect({ path, exists: existsSync(join(SRC, path)) }).toEqual({
        path,
        exists: true,
      });
    }
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
        'context.json({ error: "Authentication required." }, 401);',
        'context.json({ message: "Too many requests." }, 429);',
        "context.json({ code: refusal.code, message: refusal.message }, 403);",
        'throw new APIError("FORBIDDEN", { message: "This deployment belongs to someone else." });',
        'return context.text("No computer is configured.", 503);',
        'return new Response("Expected a WebSocket upgrade.", { status: 400 });',
        'return new Response(error instanceof Error ? error.message : "Could not be reached.", { status: 502 });',
        "context.json({ error: { message: failure.message }, code }, 400);",
        'new Response(JSON.stringify({ error: "Not a Bot." }), { status: 400 });',
        'context.json({ error: "laf:feedback_empty" }, 400);',
        'context.json({ error: "laf:channel_not_found", code: "laf:channel_not_found" }, 404);',
        "context.json({ error: error.code, code: error.code }, error.status);",
        "context.json({ error: NOT_FOUND, code: NOT_FOUND }, 404);",
        'context.json({ code: "laf:unauthenticated", message: UNAUTHENTICATED }, 401);',
        'throw new APIError("FORBIDDEN", { message: SIGN_IN_REFUSED, code: SIGN_IN_REFUSED });',
        'const line = { message: "A chat line somebody typed." };',
        'return context.text("ok");',
        'return new Response("laf:screen_unavailable", { status: 503 });',
        "new Response(JSON.stringify({ error: code, code }), { status, headers });",
        "const request = { body: { message: { to, text } } };",
        "context.json({ ...refusal.facts, error: refusal.code }, 400);",
      ].join("\n"),
    );
    // One line can break two rules — a sentence, and no code beside it — and is one line to fix.
    expect([...new Set(offenders.map(({ where }) => where))]).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(
        (line) => `fixture.ts:${line}`,
      ),
    );
    expect(bodies).toBe(13);
  });
});
