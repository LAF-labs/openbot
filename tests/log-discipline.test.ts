import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every line an operator reads goes through the one logger, and this is what says so.
 *
 * A walk over the source rather than a test of the logger: the logger is right by construction,
 * and what goes wrong is a new `console.error("… failed:", error)` in a file nobody thought of as
 * logging — which prints the error object whole, stack, provider body and bound SQL included,
 * between the JSON lines every other file writes. A grep is the only thing that sees a call
 * before it is made.
 *
 * `shared/log.ts` is the one place `console` is allowed, because it is where the lines are
 * written. `scripts/` and every `tests/` directory are not walked: a script talks to the person
 * running it, and a test's output is bun's.
 */

const root = join(import.meta.dir, "..");

/** The source trees an operator's log is assembled from. */
const WALKED = ["server/src", "agent-bot/src", "agent-computer/src", "shared"];

const ALLOWED = new Set(["shared/log.ts"]);

/**
 * Files that still write through `console`, with how many calls each is allowed.
 *
 * These belonged to other workstreams landing at the same time (routines and notifications to
 * 3-B, the account routes to 4-A/4-B), and a change here would have landed on top of theirs. 3-B
 * has since landed: what it added writes through the logger, what it left is counted here. Each writes
 * either through an injectable `log` whose default is `console` — which `server/src/index.ts`
 * already overrides with the process log — or a bare line on a path the canary turn does not
 * take. The count is a ceiling: converting one lowers it and passes; adding one fails.
 */
const STILL_ON_CONSOLE: Record<string, number> = {
  "server/src/account/deletion.ts": 1,
  "server/src/account/export.ts": 1,
  "server/src/account/retention.ts": 1,
  "server/src/notifications/alimtalk.ts": 1,
  "server/src/notifications/notify.ts": 2,
  "server/src/notifications/outbox.ts": 1,
  "server/src/routines/service.ts": 2,
};

const CONSOLE_CALL = /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/g;

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "node_modules") yield* sourceFiles(path);
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      yield path;
    }
  }
}

/** The source with its comments taken out, so a comment naming the old call is not a call. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("the operator log", () => {
  test("is written by the one logger, and by nothing else in the service sources", () => {
    const offenders: string[] = [];
    for (const tree of WALKED) {
      for (const path of sourceFiles(join(root, tree))) {
        const name = relative(root, path);
        if (ALLOWED.has(name)) continue;
        const calls = withoutComments(readFileSync(path, "utf8")).match(
          CONSOLE_CALL,
        );
        const count = calls?.length ?? 0;
        const ceiling = STILL_ON_CONSOLE[name] ?? 0;
        if (count > ceiling) offenders.push(`${name} (${count} > ${ceiling})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("names only files that still exist in the list of exceptions", () => {
    // A file that was deleted or renamed takes its exception with it, rather than leaving a name
    // in this list that permits nothing and misleads the next reader.
    for (const name of Object.keys(STILL_ON_CONSOLE)) {
      expect(statSync(join(root, name)).isFile()).toBe(true);
    }
  });
});
