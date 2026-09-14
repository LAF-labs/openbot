import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * The environment is read in one place: `server/src/config.ts`.
 *
 * Audit A1 §7 (2026-09-10) counted twenty-four reads of `process.env` outside it, and measured what
 * they cost: `PORT=abc` opened a random port behind a boot line that looked healthy,
 * `BOT_SEATS_PER_ACCOUNT=abc` was silently five, `AUDIT_RETENTION_DAYS=abc` was refused only after
 * the port had opened, and `BOT_TIME_ZONE` had two readers that each fell back on their own. A
 * variable read in two places is parsed two ways, and the second reader is always the one nothing
 * tests. So this walks `server/src` and fails on a read anywhere else.
 *
 * By the syntax tree, not by grep: a comment that says `process.env` is not a read, and
 * `process["env"]`, `Bun.env`, `import.meta.env` and `const { env } = process` are.
 */

const root = join(import.meta.dir, "../..");
const SOURCE = join(root, "server/src");

/** The one reader. */
const CONFIG = "server/src/config.ts";

/**
 * Not configuration, and so not temporary.
 *
 * `telemetry-off.ts` WRITES a variable, for a vendored library, before that library loads: the
 * CopilotKit runtime phones home unless `COPILOTKIT_TELEMETRY_DISABLED` is set, and it has to be set
 * by the first import of the entrypoint or it is too late. Nothing in the server reads it back, and
 * moving it into `config.ts` would make whether telemetry stays off depend on which modules
 * `config.ts` happens to import.
 */
const PERMANENT: Record<string, { reads: number; why: string }> = {
  "server/src/telemetry-off.ts": {
    reads: 1,
    why: "sets COPILOTKIT_TELEMETRY_DISABLED for the vendored runtime before it loads",
  },
};

/**
 * TEMPORARY: the files other workstreams own in the same wave (2026-09-14), with the reads each held
 * when the rest of the server moved to `config.ts`. A ceiling, like `tests/log-discipline.test.ts`:
 * moving a read into `config.ts` lowers the count and passes, adding one fails. Delete an entry once
 * its file reads nothing.
 *
 * Only `computer/assignment.ts` reads anything — `BOT_SEATS_PER_ACCOUNT`, at module load, the one
 * variable `config.ts` does not declare yet. `channels/routes.ts` and `routines/service.ts` were
 * measured at zero and are named so that the split landing in them cannot bring a read along.
 */
const TEMPORARY: Record<string, { reads: number; owner: string }> = {
  "server/src/computer/assignment.ts": {
    reads: 1,
    owner: "the server/src/computer/** split",
  },
  "server/src/channels/routes.ts": {
    reads: 0,
    owner: "the channels/routes.ts split",
  },
  "server/src/routines/service.ts": {
    reads: 0,
    owner: "the routines/service.ts split",
  },
};

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

const isIdentifier = (node: ts.Node, name: string) =>
  ts.isIdentifier(node) && node.text === name;

/** The lines of `text` that read the environment, by what the code does rather than what it says. */
function environmentReads(text: string, file = "source.ts"): number[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const at = (node: ts.Node) =>
    lines.push(
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    );
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "env") {
      const target = node.expression;
      if (
        isIdentifier(target, "process") ||
        isIdentifier(target, "Bun") ||
        (ts.isMetaProperty(target) && target.name.text === "meta")
      ) {
        at(node);
      }
    }
    if (
      ts.isElementAccessExpression(node) &&
      isIdentifier(node.expression, "process") &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "env"
    ) {
      at(node);
    }
    // `const { env } = process`
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isIdentifier(node.initializer, "process") &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some(
        (element) =>
          (element.propertyName ?? element.name).getText(source) === "env",
      )
    ) {
      at(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

describe("one reader of the environment", () => {
  test("the walk sees every spelling of a read, and not a comment that names one", () => {
    expect(
      environmentReads(
        [
          "const a = process.env.PORT;",
          'const b = process["env"].PORT;',
          "const c = Bun.env.PORT;",
          "const d = import.meta.env.PORT;",
          "const { env } = process;",
          "// process.env.PORT, in a comment",
          "/** `process.env` in a doc comment */",
          'const e = "process.env in a string";',
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5]);
    // And on the real tree: the reader itself is seen, or the walk proves nothing.
    expect(
      environmentReads(readFileSync(join(root, CONFIG), "utf8")).length,
    ).toBeGreaterThan(0);
  });

  test("server/src reads process.env in config.ts and nowhere else", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SOURCE)) {
      const name = relative(root, path);
      if (name === CONFIG) continue;
      const lines = environmentReads(readFileSync(path, "utf8"), path);
      const allowed = PERMANENT[name]?.reads ?? TEMPORARY[name]?.reads ?? 0;
      if (lines.length > allowed) {
        offenders.push(
          `${name}:${lines.join(",")} (${lines.length} read(s), ${allowed} allowed)`,
        );
      }
    }
    // A read here belongs in config.ts: declare the variable in ENVIRONMENT, parse it in
    // loadConfig, and hand the typed value to whatever needs it.
    expect(offenders).toEqual([]);
  });

  test("names only files that still exist in its exceptions", () => {
    // A file deleted or renamed takes its exception with it, rather than leaving a name here that
    // permits nothing and misleads the next reader.
    for (const name of [...Object.keys(PERMANENT), ...Object.keys(TEMPORARY)]) {
      expect(statSync(join(root, name)).isFile()).toBe(true);
    }
  });
});
