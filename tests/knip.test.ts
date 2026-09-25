import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * Nothing in the tree is unreachable: no file, export or dependency that no entry point leads to.
 *
 * A test rather than a fifth gate command, so the four in CLAUDE.md stay four and CI runs it
 * without a workflow change. It is cheap enough to belong here — about two seconds over the whole
 * monorepo — and deterministic: knip is pinned in the root `package.json`, reads only the tree and
 * `node_modules`, and touches no network. What it counts as an entry, and the few things it is told
 * to look past, are written down with their reasons in `knip.jsonc`.
 *
 * When this fails, the output names the file and the export. Delete what nothing reaches; if
 * something reaches it that knip cannot follow (a subprocess, a namespace read through a map), say
 * so in `knip.jsonc` or with a `@public` tag that says why, not by widening an ignore.
 */

const root = join(import.meta.dir, "..");

describe("the import graph", () => {
  test("reaches every file, export and dependency in the tree", () => {
    const run = Bun.spawnSync(
      [
        join(root, "node_modules/.bin/knip"),
        "--no-progress",
        "--no-config-hints",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const said = `${run.stdout.toString()}${run.stderr.toString()}`.trim();
    expect({ exitCode: run.exitCode, said }).toEqual({ exitCode: 0, said: "" });
  }, 60_000);
});
