import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_NAV } from "../src/components/admin/admin-sidebar";
import { SETTINGS_NAV } from "../src/components/settings/settings-sidebar";
import { ko } from "../src/lib/i18n-ko";

/**
 * The frame Settings and Admin share: which link is lit, and what happens when the window is narrow.
 *
 * WHAT WAS WRONG, AND WHY NONE OF IT WAS VISIBLE FROM A GREEN GATE.
 *
 * `/settings` is a prefix of every route under it, so without `activeOptions.exact` the "일반" row
 * stayed lit on 연결 and on 내 데이터 — the rail said somebody was on a screen they had left. The
 * admin rail had made that argument for `/admin` and this one never had.
 *
 * The rail was 340px and its comment said that was "the same 340px the app shell uses". The app
 * shell is `--sand-sidebar-width`, which is 280.
 *
 * And below `lg` there was no way out of a fixed 280px column: the Sheet that `--sidebar-width-mobile`
 * fed left with the phone decision, and so did `useIsMobile` and Cmd+B, but `md:block` stayed.
 *
 * WALKED RATHER THAN RENDERED, the same call `connections-screen.test.ts` makes: the failures here
 * are properties of a frame — a breakpoint, a width, a table read by two components — and an
 * assertion that some `<div>` exists sees none of them. What a render WOULD prove was measured in a
 * browser instead, at 1200, 900, 700 and 420px.
 */

const APP = join(import.meta.dir, "../src");
const read = (relative: string) => readFileSync(join(APP, relative), "utf8");

/**
 * The file with its comments taken out.
 *
 * Every "this is no longer here" assertion below has to read the code, because the comments are
 * where the old value is RECORDED — `md:block`, 340px and `--sidebar-width-mobile` are all named in
 * the notes explaining why they went, and a test that read those would fail for having been
 * documented.
 */
const code = (relative: string) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SIDEBAR = "components/ui/sidebar.tsx";
const RAIL_NAV = "components/layout/rail-nav.tsx";
const SETTINGS_ROUTE = "routes/_authed/settings/route.tsx";
const ADMIN_ROUTE = "routes/_authed/admin/route.tsx";
const SETTINGS_RAIL = "components/settings/settings-sidebar.tsx";

describe("which link is lit", () => {
  test("Settings is General, 연결 and 내 데이터, in that order", () => {
    expect(SETTINGS_NAV.map((item) => item.linkOptions.to)).toEqual([
      "/settings",
      "/settings/connected-accounts",
      "/settings/account",
    ]);
  });

  test("only the route that is a prefix of the others is matched exactly", () => {
    const exact = SETTINGS_NAV.filter((item) => item.isExact).map(
      (item) => item.linkOptions.to,
    );
    expect(exact).toEqual(["/settings"]);
  });

  test("the admin row does the same for /admin", () => {
    const exact = ADMIN_NAV.filter((item) => item.isExact).map(
      (item) => item.linkOptions.to,
    );
    expect(exact).toEqual(["/admin"]);
  });

  test("the rail itself passes the flag on, or the table decides nothing", () => {
    // The table can say `isExact` all it likes; the row has to hand it to the Link.
    expect(read(SETTINGS_RAIL)).toContain(
      "option.isExact ? { exact: true } : undefined",
    );
    expect(read(RAIL_NAV)).toContain(
      "item.isExact ? { exact: true } : undefined",
    );
  });

  test("both shapes of the navigation read one table", () => {
    // Two copies would be two orders, and sooner two answers about which row is lit.
    expect(read(SETTINGS_ROUTE)).toContain("SETTINGS_NAV");
    expect(read(ADMIN_ROUTE)).toContain("ADMIN_NAV");
    expect(ADMIN_NAV.length).toBeGreaterThan(1);
  });

  test("every link in either table has Korean", () => {
    /*
     * Read through `t(variable)` by `RailNav`, so `i18n-coverage.test.ts` cannot see them — the
     * same hole `agent-presets.test.ts` exists to cover. Under the test runner `t()` answers in
     * English, so a title IS its dictionary key.
     */
    const missing = [...SETTINGS_NAV, ...ADMIN_NAV]
      .map((item) => item.title)
      .filter((title) => !ko[title]);
    expect(missing).toEqual([]);
  });
});

describe("a window that is not wide", () => {
  test("the rail is not drawn below lg", () => {
    const source = code(SIDEBAR);
    expect(source).toContain("lg:block");
    expect(source).toContain("lg:flex");
    // `md:` was the Sheet's breakpoint and the Sheet is gone. Left behind it meant a 280px column
    // beside a pane that had run out of room, from 768px up to the width the rail needs.
    expect(source).not.toContain("md:block");
    expect(source).not.toContain("md:flex");
  });

  test("the handle that collapses the rail leaves with the rail", () => {
    // At `sm` it was a drag handle for a column that was not on screen.
    expect(code(SIDEBAR)).not.toContain("sm:flex");
  });

  test("both screens put the row in its place, and only there", () => {
    for (const route of [SETTINGS_ROUTE, ADMIN_ROUTE]) {
      expect(code(route)).toMatch(/<RailNav[^>]*className="lg:hidden"/s);
    }
  });

  test("the row scrolls sideways instead of widening the page", () => {
    // Admin has nine links. Without this the document scrolls horizontally, which on a narrow
    // window moves the whole screen out from under the reader.
    expect(read(RAIL_NAV)).toContain("overflow-x-auto");
  });

  test("nothing hands in the width the Sheet used to read", () => {
    for (const route of [SETTINGS_ROUTE, ADMIN_ROUTE]) {
      expect(code(route)).not.toContain("--sidebar-width-mobile");
    }
  });
});

describe("the rail is the width it says it is", () => {
  test("both screens are the app shell's own width", () => {
    const shell = readFileSync(join(APP, "styles.css"), "utf8");
    const declared = shell.match(/--sand-sidebar-width:\s*(\d+)px/)?.[1];
    expect(declared).toBe("280");
    for (const route of [SETTINGS_ROUTE, ADMIN_ROUTE]) {
      expect(code(route)).toContain(`"--sidebar-width": "${declared}px"`);
      // The number it used to be, under a comment claiming it matched the shell.
      expect(code(route)).not.toContain("340px");
    }
  });
});
