import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCREEN_ROUTES, type ScreenRoute } from "../../shared/screen-errors";
import type { FileRoutesByFullPath } from "../src/routeTree.gen";

/**
 * THE ROUTES A SCREEN-ERROR REPORT MAY NAME ARE THE ROUTES THE APP HAS — BOTH WAYS.
 *
 * A report names its route by template, from a list (`shared/screen-errors.ts`), because a template
 * and an address are the same characters and no pattern can tell `/channel/new` from a channel id.
 * A list is only right while it agrees with the route tree. A route added without its line would be
 * reported without a route; a line left behind by a removed route is a template no report can have.
 *
 * Checked twice: by the TYPECHECK, which is where a new route fails first — `Unlisted` and `Stale`
 * are `never` only while the two agree — and here, against the generated file itself, so a run of
 * the tests alone says the same.
 */

type TreeRoute = keyof FileRoutesByFullPath;
type Unlisted = Exclude<TreeRoute, ScreenRoute>;
type Stale = Exclude<ScreenRoute, TreeRoute>;
const listAgreesWithTree: [Unlisted, Stale] extends [never, never]
  ? true
  : false = true;

describe("the routes a report may name", () => {
  test("are exactly the templates of the generated route tree", () => {
    expect(listAgreesWithTree).toBe(true);

    const generated = readFileSync(
      join(import.meta.dir, "../src/routeTree.gen.ts"),
      "utf8",
    );
    const block = /export interface FileRoutesByFullPath \{([\s\S]*?)\n\}/.exec(
      generated,
    )?.[1];
    if (!block) throw new Error("FileRoutesByFullPath is not in the tree");
    const inTree = [...block.matchAll(/^\s+'([^']+)':/gm)].map(
      (match) => match[1] ?? "",
    );
    expect(inTree.length).toBeGreaterThan(20);
    const listed: string[] = [...SCREEN_ROUTES];
    expect(listed.sort()).toEqual(inTree.sort());
  });
});
