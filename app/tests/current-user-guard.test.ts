import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const source = join(import.meta.dir, "..", "src");

function everyFile(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return everyFile(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * One door, because the answer on failure is a decision and not a value.
 *
 * `currentUserQueryOptions` can answer UNREACHABLE, and a route that reads it with
 * `ensureQueryData` and does not check for that will hand the string to code expecting a person.
 * `loadCurrentUser` is where that check lives — it turns the answer into a navigation to a screen
 * that renders with the API completely down. A fourth route guard copying the two-line original
 * would compile and would show a blank page, which is exactly how this was found.
 *
 * Screens are unaffected: `select` strips the value before any component sees it.
 */
test("every route guard reads the current user through the one helper", () => {
  const callers = everyFile(source)
    .filter((path) => !path.endsWith(join("auth", "load-current-user.ts")))
    .filter((path) =>
      /ensureQueryData\(\s*currentUserQueryOptions\(\)\s*,?\s*\)/.test(
        readFileSync(path, "utf8"),
      ),
    );

  expect(callers).toEqual([]);
});

/** And the helper is genuinely used, so the rule above cannot pass by nobody asking at all. */
test("the guards do ask", () => {
  const users = everyFile(source).filter((path) =>
    readFileSync(path, "utf8").includes("loadCurrentUser("),
  );

  // The helper itself plus the route guards: authed, sign, admin.
  expect(users.length).toBeGreaterThanOrEqual(4);
});
