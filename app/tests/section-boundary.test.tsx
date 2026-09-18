import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { ScreenErrorReport } from "../../shared/screen-errors";
import type { ReactElement } from "react";
import { mount, unmountAll } from "./support/mount";

/**
 * ONE PART OF THE SCREEN FAILS, AND ONLY THAT PART — RENDERED, PRESSED AND NAVIGATED.
 *
 * What a green typecheck cannot see: that the part beside a failed one still draws AND still
 * answers a press; that 다시 불러오기 brings the part back, including when what broke it was the
 * data it was handed, which only comes back right if it is fetched again BEFORE the part is drawn;
 * that a query the failed part shared with a part still on screen is only fetched again when the
 * seam names it; that a route change tries again by itself; where the keyboard's focus lands; and
 * that the failure is reported once, as facts.
 *
 * The boundary is mounted inside a real memory router and query client, as every seam in the app
 * is, because it reads both.
 */

const PASSWORD = "hunter2-canary";
const KOREAN = "사장님 리뷰에 답글 달아 줘";

let consoleError: ReturnType<typeof spyOn> | undefined;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(async () => {
  await unmountAll();
  consoleError?.mockRestore();
  consoleError = undefined;
  const { configureScreenErrorReports } = await import(
    "../src/lib/support/screen-errors"
  );
  configureScreenErrorReports(null);
});

/** React prints every error a boundary catches; these tests throw on purpose. */
function quietly() {
  consoleError = spyOn(console, "error").mockImplementation(() => {});
}

/** A switch a part reads while drawing, flipped from the test the way data changes under a page. */
function createSwitch(initial: boolean) {
  let on = initial;
  const listeners = new Set<() => void>();
  return {
    get on() {
      return on;
    },
    set(next: boolean) {
      on = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * `Root` drawn at `at` inside a memory router with two pages and a query client.
 *
 * `Root` is the root route's component, so whatever it draws OUTSIDE the outlet stays mounted
 * across a navigation — the position the roster is in, and the one a route change has to reset.
 */
async function drawn(at: string, Root: () => ReactElement) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
  } = await import("@tanstack/react-router");
  const rootRoute = createRootRoute({ component: Root });
  const routeTree = rootRoute.addChildren(
    ["/", "/elsewhere"].map((path) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        component: () => <p data-page={path}>{`page ${path}`}</p>,
      }),
    ),
  );
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = await mount(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.settle(50);
  const { act } = await import("react");
  return {
    ...view,
    router,
    queryClient,
    alerts: () => [...view.host.querySelectorAll('[role="alert"]')],
    reloadButton: () =>
      [...view.host.querySelectorAll("button")].find(
        (button) => button.textContent === "Reload",
      ),
    failed: (section: string) =>
      view.host.querySelector(`[data-failed-section="${section}"]`),
    act: async (work: () => void) => {
      await act(async () => {
        work();
      });
      await view.settle(30);
    },
  };
}

describe("a part that throws while drawing", () => {
  test("is replaced by a sentence and a button, and the part beside it still draws and still answers", async () => {
    quietly();
    const { SectionBoundary } = await import(
      "../src/components/layout/section-boundary"
    );
    const { useState } = await import("react");
    const Broken = (): ReactElement => {
      throw new Error(`${PASSWORD} ${KOREAN}`);
    };
    const Counter = () => {
      const [count, setCount] = useState(0);
      return (
        <button onClick={() => setCount((value) => value + 1)} type="button">
          {`pressed ${count}`}
        </button>
      );
    };
    const view = await drawn("/", () => (
      <>
        <SectionBoundary section="sidebar">
          <Broken />
        </SectionBoundary>
        <SectionBoundary section="main">
          <Counter />
        </SectionBoundary>
      </>
    ));

    expect(view.failed("sidebar")).not.toBeNull();
    expect(view.failed("main")).toBeNull();
    expect(view.alerts().map((alert) => alert.textContent)).toEqual([
      "This part of the screen ran into an unexpected problem.",
    ]);
    // The message is never what threw.
    expect(view.host.textContent).not.toContain(PASSWORD);
    expect(view.host.textContent).not.toContain(KOREAN);

    const counter = [...view.host.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("pressed"),
    );
    if (!counter) throw new Error("the part beside the failed one is gone");
    await view.press(counter);
    await view.press(counter);
    expect(counter.textContent).toBe("pressed 2");
  });

  test("the button is a real, enabled button in the tab order", async () => {
    quietly();
    const { SectionBoundary } = await import(
      "../src/components/layout/section-boundary"
    );
    const Broken = (): ReactElement => {
      throw new TypeError("x");
    };
    const view = await drawn("/", () => (
      <SectionBoundary section="detail">
        <Broken />
      </SectionBoundary>
    ));
    const button = view.reloadButton();
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("tabindex")).not.toBe("-1");
  });
});

describe("다시 불러오기", () => {
  test("draws the part again once whatever broke it is gone", async () => {
    quietly();
    const { SectionBoundary } = await import(
      "../src/components/layout/section-boundary"
    );
    let isBroken = true;
    const Part = () => {
      if (isBroken) throw new Error("x");
      return <p>drawn again</p>;
    };
    const view = await drawn("/", () => (
      <SectionBoundary section="computer">
        <Part />
      </SectionBoundary>
    ));
    expect(view.failed("computer")).not.toBeNull();

    isBroken = false;
    const button = view.reloadButton();
    if (!button) throw new Error("no 다시 불러오기 on the failed part");
    await view.press(button);
    await view.settle(50);

    expect(view.failed("computer")).toBeNull();
    expect(view.host.textContent).toContain("drawn again");
    expect(view.alerts()).toEqual([]);
  });

  test("fetches the part's data again BEFORE drawing it, which is what brings back a part the data broke", async () => {
    quietly();
    const { SectionBoundary } = await import(
      "../src/components/layout/section-boundary"
    );
    const { useQuery } = await import("@tanstack/react-query");
    let answer: { items: string[] | null } = { items: null };
    let fetches = 0;
    const Reader = () => {
      const { data } = useQuery({
        queryKey: ["reader"],
        queryFn: async () => {
          fetches += 1;
          return structuredClone(answer);
        },
      });
      if (!data) return <p>loading</p>;
      // What a screen does with a field the server stopped sending: it throws.
      return <p>{(data.items as string[]).join(",")}</p>;
    };
    const view = await drawn("/", () => (
      <SectionBoundary section="settings_page">
        <Reader />
      </SectionBoundary>
    ));
    await view.settle(50);
    expect(view.failed("settings_page")).not.toBeNull();
    expect(fetches).toBe(1);

    answer = { items: ["fixed"] };
    const button = view.reloadButton();
    if (!button) throw new Error("no 다시 불러오기 on the failed part");
    await view.press(button);
    await view.settle(80);

    expect(view.failed("settings_page")).toBeNull();
    expect(view.host.textContent).toContain("fixed");
    expect(fetches).toBeGreaterThanOrEqual(2);
  });

  test("a query the part shared with a part still on screen is fetched again only when the seam names it", async () => {
    quietly();
    const { SectionBoundary } = await import(
      "../src/components/layout/section-boundary"
    );
    const { useQuery } = await import("@tanstack/react-query");

    const run = async (named: boolean) => {
      let answer: { items: string[] | null } = { items: null };
      const key = ["shared", named];
      const read = async () => structuredClone(answer);
      // The part on screen that reads the same query and does not break on it.
      const Watcher = () => {
        const { data } = useQuery({ queryKey: key, queryFn: read });
        return <p>{`watching ${data ? "yes" : "no"}`}</p>;
      };
      const Reader = () => {
        const { data } = useQuery({ queryKey: key, queryFn: read });
        if (!data) return <p>loading</p>;
        return <p>{(data.items as string[]).join(",")}</p>;
      };
      const view = await drawn("/", () => (
        <>
          <Watcher />
          <SectionBoundary
            section="sidebar"
            {...(named ? { queryKeys: [key] } : {})}
          >
            <Reader />
          </SectionBoundary>
        </>
      ));
      await view.settle(50);
      expect(view.failed("sidebar")).not.toBeNull();

      answer = { items: ["fixed"] };
      const button = view.reloadButton();
      if (!button) throw new Error("no 다시 불러오기 on the failed part");
      await view.press(button);
      await view.settle(80);
      const recovered = view.failed("sidebar") === null;
      await view.unmount();
      return recovered;
    };

    // Watched by the part beside it, the query is not one nobody is watching, so only the name finds it.
    expect(await run(false)).toBe(false);
    expect(await run(true)).toBe(true);
  });
});

describe("on its own", () => {
  test("a part outside the page tries again when the route changes", async () => {
    quietly();
    const { SectionBoundary } = await import(
      "../src/components/layout/section-boundary"
    );
    const { Outlet } = await import("@tanstack/react-router");
    let isBroken = true;
    const Roster = () => {
      if (isBroken) throw new Error("x");
      return <p>roster</p>;
    };
    const view = await drawn("/", () => (
      <>
        <SectionBoundary section="sidebar">
          <Roster />
        </SectionBoundary>
        <Outlet />
      </>
    ));
    expect(view.failed("sidebar")).not.toBeNull();
    expect(view.host.querySelector('[data-page="/"]')).not.toBeNull();

    isBroken = false;
    // Through the history, as a link press does: this little tree is not the app's typed one.
    await view.act(() => {
      view.router.history.push("/elsewhere");
    });
    await view.settle(50);

    expect(view.host.querySelector('[data-page="/elsewhere"]')).not.toBeNull();
    expect(view.failed("sidebar")).toBeNull();
    expect(view.host.textContent).toContain("roster");
  });

  test("focus lost with the part goes to its button; focus elsewhere stays where it was", async () => {
    quietly();
    const { SectionBoundary } = await import(
      "../src/components/layout/section-boundary"
    );
    const { useSyncExternalStore } = await import("react");

    const place = async (focusInside: boolean) => {
      const broken = createSwitch(false);
      const Part = () => {
        const isBroken = useSyncExternalStore(
          broken.subscribe,
          () => broken.on,
        );
        if (isBroken) throw new Error("x");
        return <input aria-label="inside" />;
      };
      const view = await drawn("/", () => (
        <>
          <input aria-label="outside" />
          <SectionBoundary section="transcript">
            <Part />
          </SectionBoundary>
        </>
      ));
      const field = view.host.querySelector<HTMLInputElement>(
        `input[aria-label="${focusInside ? "inside" : "outside"}"]`,
      );
      field?.focus();
      expect(document.activeElement).toBe(field);
      await view.act(() => broken.set(true));
      const where =
        document.activeElement === view.reloadButton()
          ? "button"
          : document.activeElement === field
            ? "where it was"
            : document.activeElement?.tagName;
      await view.unmount();
      return where;
    };

    expect(await place(true)).toBe("button");
    expect(await place(false)).toBe("where it was");
  });

  test("the failure is reported once, as facts, and the message is not among them", async () => {
    quietly();
    const { SectionBoundary } = await import(
      "../src/components/layout/section-boundary"
    );
    const { configureScreenErrorReports } = await import(
      "../src/lib/support/screen-errors"
    );
    const reports: ScreenErrorReport[] = [];
    configureScreenErrorReports({
      route: () => "/",
      build: async () => null,
      surface: () => "browser",
      isSignedIn: () => true,
      send: async (report) => {
        reports.push(report);
      },
    });
    let isBroken = true;
    const Part = () => {
      if (isBroken) throw new TypeError(`${PASSWORD} ${KOREAN}`);
      return <p>fine</p>;
    };
    const view = await drawn("/", () => (
      <SectionBoundary section="notices">
        <Part />
      </SectionBoundary>
    ));
    await view.settle(30);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      section: "notices",
      route: "/",
      kind: "TypeError",
      surface: "browser",
    });
    expect(JSON.stringify(reports)).not.toContain(PASSWORD);
    expect(JSON.stringify(reports)).not.toContain("사장님");

    // Pressed while still broken: it fails again, from the same place, and is not reported again.
    const button = view.reloadButton();
    if (!button) throw new Error("no 다시 불러오기 on the failed part");
    await view.press(button);
    await view.settle(50);
    expect(view.failed("notices")).not.toBeNull();
    expect(reports).toHaveLength(1);

    isBroken = false;
    const again = view.reloadButton();
    if (!again)
      throw new Error("no 다시 불러오기 on the part that failed again");
    await view.press(again);
    await view.settle(50);
    expect(view.host.textContent).toContain("fine");
  });
});
