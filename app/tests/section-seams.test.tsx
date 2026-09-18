import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { ScreenErrorReport } from "../../shared/screen-errors";
import {
  APP_DOM_TIMEOUT_MS,
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
} from "./support/app-router";

/**
 * THE REAL SEAMS, IN THE REAL ROUTE TREE: THE ROSTER BREAKS WHILE THE APP IS OPEN.
 *
 * `section-boundary.test.tsx` holds the boundary to its promises in a small router of its own. This
 * is the same promise kept where the app keeps it — the whole route tree, `_app.tsx`'s two columns,
 * the query client the screens share — against the way a column actually breaks: the server's
 * answer changes under a page that is already drawn, and the roster throws on it.
 *
 * WHY A CONVERSATION WITH NO `agentIds`. The roster files every conversation under its Bot by
 * reading `agentIds.length`, and Home reads the Bots but not the conversations, so this answer
 * breaks exactly one column. If the roster ever learns to survive it, this needs another shape that
 * breaks the roster alone — not a weaker assertion.
 */

const BROKEN_CHANNELS = [
  {
    id: "channel-broken",
    name: "초롱",
    agentIds: null,
    unread: false,
    createdAt: "2026-09-18T00:00:00.000Z",
    lastMessage: null,
    lastMessageAt: null,
  },
];

let consoleError: ReturnType<typeof spyOn> | undefined;

beforeAll(async () => {
  await installAppDom();
  // The roster is broken on purpose; React prints every error a boundary catches.
  consoleError = spyOn(console, "error").mockImplementation(() => {});
}, APP_DOM_TIMEOUT_MS);

afterAll(async () => {
  consoleError?.mockRestore();
  const { configureScreenErrorReports } = await import(
    "../src/lib/support/screen-errors"
  );
  configureScreenErrorReports(null);
  await removeAppDom();
});

describe("the roster, broken under an open window", () => {
  test("fails alone, is reported as the roster on its route's template, and comes back with 다시 불러오기", async () => {
    const { channelKeys } = await import("../src/lib/channels/queries");
    const { configureScreenErrorReports, routeTemplateOf } = await import(
      "../src/lib/support/screen-errors"
    );

    let channels: unknown[] = [];
    const view = await mountApp({
      path: "/",
      api: ({ method, pathname }) => {
        if (pathname === "/api/channels") return json({ channels });
        if (pathname === "/api/agents") {
          return json({
            agents: [agentFixture({ id: "bot-chorong", name: "초롱" })],
          });
        }
        if (method === "POST" && pathname === "/api/support/help-opened") {
          return new Response(null, { status: 204 });
        }
        return undefined;
      },
    });
    const roster = () => view.host.querySelector('nav[aria-label="Your team"]');
    const failedRoster = () =>
      view.host.querySelector('[data-failed-section="sidebar"]');
    await view.waitFor(() => roster() !== null, "the roster");

    const reports: ScreenErrorReport[] = [];
    configureScreenErrorReports({
      route: () => routeTemplateOf(view.router),
      build: async () => ({ version: "edge", revision: "eeea9853c2d1" }),
      surface: () => "shell",
      isSignedIn: () => true,
      send: async (report) => {
        reports.push(report);
      },
    });

    // The server's answer changes under the open window, and the roster throws on it.
    channels = BROKEN_CHANNELS;
    await view.queryClient.invalidateQueries({ queryKey: channelKeys.list() });
    await view.waitFor(() => failedRoster() !== null, "the roster to fail");

    expect(roster()).toBeNull();
    expect(failedRoster()?.querySelector('[role="alert"]')?.textContent).toBe(
      "This part of the screen ran into an unexpected problem.",
    );
    // Home, beside it, is still drawn.
    expect(view.main()?.textContent).toContain(
      "What should the team take off your hands?",
    );
    await view.waitFor(() => reports.length === 1, "the report");
    expect(reports[0]).toMatchObject({
      section: "sidebar",
      route: "/",
      kind: "TypeError",
      build: "edge",
      surface: "shell",
    });

    // And the rest of the window still goes places: the page beside the roster changes.
    await view.navigate("/help");
    expect(routeTemplateOf(view.router)).toBe("/help");
    expect(view.main()?.textContent).toContain("Help");
    // The route changed, so the roster tried again — on the same broken answer, and failed again,
    // from the same place, which is not a second report.
    expect(failedRoster()).not.toBeNull();
    expect(reports).toHaveLength(1);

    // The answer is right again; 다시 불러오기 fetches it and draws the roster.
    channels = [];
    const reload = [...(failedRoster()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Reload",
    );
    if (!reload) throw new Error("no 다시 불러오기 where the roster was");
    await view.click(reload);
    await view.waitFor(() => roster() !== null, "the roster to come back");
    expect(failedRoster()).toBeNull();

    await view.unmount();
  }, 30_000);

  test("a route is named by its template, never by the address with its id", async () => {
    const { routeTemplateOf } = await import(
      "../src/lib/support/screen-errors"
    );
    const view = await mountApp({ path: "/channel/channel-0f9c2d4e" });
    expect(view.router.state.location.pathname).toBe(
      "/channel/channel-0f9c2d4e",
    );
    expect(routeTemplateOf(view.router)).toBe("/channel/$channelId");
    await view.navigate("/settings/account");
    expect(routeTemplateOf(view.router)).toBe("/settings/account");
    await view.unmount();
  }, 30_000);

  /*
   * A PAGE'S OWN FAILURE, NOT A PART BESIDE IT. The router puts a catch boundary around every route,
   * so a page that throws is caught one level below a seam that wraps its outlet — the router drew
   * its whole-screen error inside the pane, and the seam never knew. Each page here is broken by its
   * own answer (the roster and the rail read neither), and must be caught by the seam it sits in.
   */
  test.each([
    {
      path: "/routines",
      section: "main",
      broken: "/api/routines",
      queryKey: ["routines"],
      brokenBody: { routines: [null] },
      goodBody: { routines: [] },
      stillThere: 'nav[aria-label="Your team"]',
    },
    {
      path: "/settings/connected-accounts",
      section: "settings_page",
      broken: "/api/connections/overview",
      queryKey: ["connections", "overview"],
      brokenBody: {
        generatedAt: "2026-09-18T00:00:00.000Z",
        accounts: [null],
        sites: [],
        bots: [],
      },
      goodBody: {
        generatedAt: "2026-09-18T00:00:00.000Z",
        accounts: [],
        sites: [],
        bots: [],
      },
      stillThere: 'a[href="/settings/account"]',
    },
  ])(
    "a page that throws on its own data is caught by its seam, $section, and comes back",
    async ({
      path,
      section,
      broken,
      queryKey,
      brokenBody,
      goodBody,
      stillThere,
    }) => {
      const { configureScreenErrorReports, routeTemplateOf } = await import(
        "../src/lib/support/screen-errors"
      );
      let body: unknown = goodBody;
      const view = await mountApp({
        path,
        api: ({ pathname }) => (pathname === broken ? json(body) : undefined),
      });
      const reports: ScreenErrorReport[] = [];
      configureScreenErrorReports({
        route: () => routeTemplateOf(view.router),
        build: async () => null,
        surface: () => "browser",
        isSignedIn: () => true,
        send: async (report) => {
          reports.push(report);
        },
      });
      const failed = () =>
        view.host.querySelector(`[data-failed-section="${section}"]`);

      // The page's answer changes under it, and the page throws on it.
      body = brokenBody;
      await view.queryClient.invalidateQueries({ queryKey });
      await view.waitFor(
        () =>
          failed() !== null ||
          (view.host.textContent ?? "").includes("Something went wrong."),
        "the page to fail",
      );

      // The section's sentence, not the router's whole-screen one, and the way around still drawn.
      expect(view.host.textContent).not.toContain("Something went wrong.");
      expect(view.host.querySelector(stillThere)).not.toBeNull();
      await view.waitFor(() => reports.length > 0, "the report");
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        section,
        route: path,
        kind: "TypeError",
      });

      body = goodBody;
      const reload = [...(failed()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === "Reload",
      );
      if (!reload) throw new Error(`no 다시 불러오기 on ${section}`);
      await view.click(reload);
      await view.waitFor(
        () => failed() == null,
        `the ${section} seam to recover`,
      );
      expect(view.host.textContent).not.toContain("Something went wrong.");
      await view.unmount();
    },
    30_000,
  );

  test("what reaches the router's own error screen is reported too, and its message is not", async () => {
    const { configureScreenErrorReports } = await import(
      "../src/lib/support/screen-errors"
    );
    const { router } = await import("../src/router");
    const { mount } = await import("./support/mount");
    const ErrorScreen = router.options.defaultErrorComponent;
    if (!ErrorScreen) throw new Error("the router has no error screen");

    const reports: ScreenErrorReport[] = [];
    configureScreenErrorReports({
      route: () => "/welcome",
      build: async () => null,
      surface: () => "browser",
      isSignedIn: () => true,
      send: async (report) => {
        reports.push(report);
      },
    });
    const view = await mount(
      <ErrorScreen
        error={new SyntaxError("비밀번호는 hunter2-canary 입니다")}
        reset={() => {}}
      />,
    );
    await view.settle(30);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      section: "route_screen",
      route: "/welcome",
      kind: "SyntaxError",
    });
    expect(JSON.stringify(reports)).not.toContain("hunter2");
    // The screen says its own sentence, never the error's.
    expect(view.host.textContent).not.toContain("hunter2");
    await view.unmount();
  }, 30_000);
});
