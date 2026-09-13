import type { ReactElement } from "react";

/**
 * Mounting a component into happy-dom the way `settings-rows.test.tsx` and `first-task-chips.test.tsx`
 * each did by hand: `createRoot` + `act`, a host appended to the body, and a few gestures.
 *
 * EVERYTHING IS IMPORTED LAZILY, INSIDE THE CALL. The DOM is registered in each file's `beforeAll`
 * and taken down in its `afterAll`, so a module-level `import { createRoot }` here would run
 * react-dom's own "is there a document" check before any file had installed one. The same
 * arrangement as the files above, for the same reason.
 *
 * Roots are remembered so a file can `afterEach(unmountAll)`: a component left mounted keeps its
 * timers — a 4s refetch interval, a 1 Hz control poll — and the next test's fetch stub answers
 * requests the previous test's tree is still making.
 */

type Root = { unmount(): void };

const live: { host: HTMLElement; root: Root }[] = [];

export type Mounted = {
  host: HTMLElement;
  render(element: ReactElement): Promise<void>;
  /** Lets effects, resolved fetches and React Query settle. */
  settle(ms?: number): Promise<void>;
  press(target: Element): Promise<void>;
  /** Types into a React-controlled field, through the native setter so React sees the change. */
  type(target: HTMLInputElement, value: string): Promise<void>;
  unmount(): Promise<void>;
};

export async function mount(element?: ReactElement): Promise<Mounted> {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  live.push({ host, root });

  const settle = async (ms = 30) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  const mounted: Mounted = {
    host,
    render: async (next) => {
      await act(async () => {
        root.render(next);
      });
    },
    settle,
    press: async (target) => {
      await act(async () => {
        target.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      await settle();
    },
    type: async (target, value) => {
      /*
       * React keeps its own record of the field's last value and ignores an `input` event whose
       * value has not moved past it, so writing `target.value` directly is a change React never
       * sees. The prototype's setter bypasses that record.
       */
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      await act(async () => {
        setter?.call(target, value);
        target.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      const at = live.findIndex((entry) => entry.root === root);
      if (at >= 0) live.splice(at, 1);
    },
  };

  if (element) {
    await mounted.render(element);
    await settle();
  }
  return mounted;
}

export async function unmountAll(): Promise<void> {
  const { act } = await import("react");
  for (const { host, root } of live.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
}

/**
 * A memory-history router that draws `component` at every one of `paths`.
 *
 * `Link` refuses to render outside a router, and which link is lit is decided against the
 * router's location — so a test about active states needs one route per address it visits, even
 * though every route draws the same thing.
 */
export async function routerAt(
  at: string,
  paths: string[],
  component: () => ReactElement | null,
) {
  const { createMemoryHistory, createRootRoute, createRoute, createRouter } =
    await import("@tanstack/react-router");
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren(
    paths.map((path) =>
      createRoute({ getParentRoute: () => rootRoute, path, component }),
    ),
  );
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [at] }),
  });
}

/** A JSON `Response`, the shape every API route here answers with. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
