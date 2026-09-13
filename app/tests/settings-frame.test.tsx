import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { ADMIN_NAV } from "../src/components/admin/admin-sidebar";
import type { RailNavItem } from "../src/components/layout/rail-nav";
import { SETTINGS_NAV } from "../src/components/settings/settings-sidebar";
import { ko } from "../src/lib/i18n-ko";
import { mount, routerAt, unmountAll } from "./support/mount";

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
 * RENDERED, AT EACH ADDRESS. The first version of this file grepped the route files for the
 * strings above, which is a test that passes when `exact: true` is written anywhere in the file
 * and fails when a formatter moves it. Which link is lit is a property of a `Link` against a
 * location, so the row and the column are mounted in a memory router and asked at `/settings`,
 * `/settings/connected-accounts` and `/settings/account` in turn. The breakpoints and the width
 * are read off the rendered elements the same way — the route's own component is lifted out of
 * its file route and drawn, so the `280px` asserted is the one the screen actually gets. What a
 * browser adds on top of that (the column really disappearing at 900px) was measured at 1200,
 * 900, 700 and 420px.
 */

const APP = join(import.meta.dir, "../src");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(unmountAll);

const SETTINGS_PATHS = [
  "/",
  "/settings",
  "/settings/connected-accounts",
  "/settings/account",
];
const ADMIN_PATHS = ["/", "/admin", "/admin/audit", "/admin/credentials"];

/** Draws `element` at `at`, with a route for every address the links target. */
async function drawnAt(
  at: string,
  paths: string[],
  element: () => ReactElement | null,
) {
  const { RouterProvider } = await import("@tanstack/react-router");
  const router = await routerAt(at, paths, element);
  const view = await mount(<RouterProvider router={router} />);
  return {
    ...view,
    links: () => [...view.host.querySelectorAll("a")],
    lit: () =>
      [...view.host.querySelectorAll('a[data-status="active"]')].map(
        (link) => link.textContent,
      ),
  };
}

async function railAt(at: string, items: RailNavItem[], label: string) {
  const { RailNav } = await import("../src/components/layout/rail-nav");
  return drawnAt(
    at,
    at.startsWith("/admin") ? ADMIN_PATHS : SETTINGS_PATHS,
    () => <RailNav items={items} label={label} />,
  );
}

async function settingsColumnAt(at: string) {
  const { SidebarProvider } = await import("../src/components/ui/sidebar");
  const { SettingsSidebar } = await import(
    "../src/components/settings/settings-sidebar"
  );
  return drawnAt(at, SETTINGS_PATHS, () => (
    <SidebarProvider>
      <SettingsSidebar />
    </SidebarProvider>
  ));
}

/** The whole Settings screen, as the route draws it, at `at`. */
async function settingsScreenAt(at: string) {
  const { Route } = await import("../src/routes/_authed/settings/route");
  const Screen = Route.options.component as () => ReactElement;
  return drawnAt(at, SETTINGS_PATHS, () => <Screen />);
}

async function adminScreenAt(at: string) {
  const { Route } = await import("../src/routes/_authed/admin/route");
  const Screen = Route.options.component as () => ReactElement;
  return drawnAt(at, ADMIN_PATHS, () => <Screen />);
}

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

  test("the row lights General on /settings, and nothing else", async () => {
    const view = await railAt("/settings", SETTINGS_NAV, "Settings");
    expect(view.lit()).toEqual(["General"]);
  });

  test("on a screen under /settings, General has gone out", async () => {
    /*
     * THE BUG. The table can say `isExact` all it likes; the row has to hand it to the `Link`, and
     * without it `/settings` is active on every address that starts with it.
     */
    const data = await railAt("/settings/account", SETTINGS_NAV, "Settings");
    expect(data.lit()).toEqual(["Your data"]);
    const connections = await railAt(
      "/settings/connected-accounts",
      SETTINGS_NAV,
      "Settings",
    );
    expect(connections.lit()).toEqual(["Connections"]);
  });

  test("the rail's column agrees with the row, because both read one table", async () => {
    // Two copies would be two orders, and sooner two answers about which row is lit.
    const column = await settingsColumnAt("/settings/connected-accounts");
    expect(column.lit()).toEqual(["Connections"]);
    const row = await railAt(
      "/settings/connected-accounts",
      SETTINGS_NAV,
      "Settings",
    );
    const titles = (links: HTMLAnchorElement[]) =>
      links
        .map((link) => link.textContent)
        .filter((text) => text !== "Back to app" && text !== "");
    expect(titles(row.links())).toEqual(titles(column.links()));
    expect(titles(row.links())).toEqual(SETTINGS_NAV.map((item) => item.title));
  });

  test("the admin row lights Overview on /admin and only there", async () => {
    expect(ADMIN_NAV.length).toBeGreaterThan(1);
    const overview = await railAt("/admin", ADMIN_NAV, "Admin");
    expect(overview.lit()).toEqual(["Overview"]);
    const audit = await railAt("/admin/audit", ADMIN_NAV, "Admin");
    expect(audit.lit()).toEqual(["Audit"]);
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
  test("the rail is not drawn below lg", async () => {
    const view = await settingsColumnAt("/settings");
    const column = view.host.querySelector("[data-slot=sidebar]");
    const container = view.host.querySelector("[data-slot=sidebar-container]");
    expect(column?.className).toContain("hidden");
    expect(column?.className).toContain("lg:block");
    expect(container?.className).toContain("hidden");
    expect(container?.className).toContain("lg:flex");
    // `md:` was the Sheet's breakpoint and the Sheet is gone. Left behind it meant a 280px column
    // beside a pane that had run out of room, from 768px up to the width the rail needs.
    for (const element of [column, container]) {
      expect(element?.className).not.toMatch(/\bmd:(block|flex)\b/);
    }
  });

  test("the handle that collapses the rail leaves with the rail", async () => {
    // At `sm` it was a drag handle for a column that was not on screen.
    const view = await settingsColumnAt("/settings");
    const handle = view.host.querySelector("[data-slot=sidebar-rail]");
    expect(handle?.className).toContain("lg:flex");
    expect(handle?.className).not.toContain("sm:flex");
  });

  test("both screens put the row in its place, and only there", async () => {
    for (const screen of [
      await settingsScreenAt("/settings"),
      await adminScreenAt("/admin"),
    ]) {
      const rows = screen.host.querySelectorAll("main > nav[aria-label]");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.className).toContain("lg:hidden");
      // Above the pane's content, and the way back to the app is its first link.
      expect(screen.host.querySelector("main")?.firstElementChild).toBe(
        rows[0] as Element,
      );
      const back = rows[0]?.querySelector("a");
      expect(back?.getAttribute("aria-label")).toBe("Back to app");
      expect(back?.getAttribute("href")).toBe("/");
    }
  });

  test("the row names its landmark, and scrolls sideways instead of widening the page", async () => {
    // Admin has nine links. Without this the document scrolls horizontally, which on a narrow
    // window moves the whole screen out from under the reader.
    const view = await railAt("/admin", ADMIN_NAV, "Admin");
    const row = view.host.querySelector("nav");
    expect(row?.getAttribute("aria-label")).toBe("Admin");
    expect(row?.firstElementChild?.className).toContain("overflow-x-auto");
    expect(view.links()).toHaveLength(ADMIN_NAV.length + 1);
  });

  test("nothing hands in the width the Sheet used to read", async () => {
    for (const screen of [
      await settingsScreenAt("/settings"),
      await adminScreenAt("/admin"),
    ]) {
      const wrapper = screen.host.querySelector<HTMLElement>(
        "[data-slot=sidebar-wrapper]",
      );
      expect(wrapper?.getAttribute("style") ?? "").not.toContain(
        "--sidebar-width-mobile",
      );
    }
  });
});

describe("the rail is the width it says it is", () => {
  test("both screens are the app shell's own width", async () => {
    // The token itself is a stylesheet's, so that one line is still read as text.
    const shell = readFileSync(join(APP, "styles.css"), "utf8");
    const declared = shell.match(/--sand-sidebar-width:\s*(\d+)px/)?.[1];
    expect(declared).toBe("280");
    for (const screen of [
      await settingsScreenAt("/settings"),
      await adminScreenAt("/admin"),
    ]) {
      const wrapper = screen.host.querySelector<HTMLElement>(
        "[data-slot=sidebar-wrapper]",
      );
      expect(wrapper?.style.getPropertyValue("--sidebar-width")).toBe(
        `${declared}px`,
      );
    }
  });
});
