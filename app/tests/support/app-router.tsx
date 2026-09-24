import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AgentProfile } from "../../src/lib/agents/queries";
import { stubFetch } from "./fetch";

/**
 * THE WHOLE APP, MOUNTED ON A MEMORY HISTORY, WITH THE SERVER STUBBED.
 *
 * Route modules cannot be rendered on their own: `Route.useSearch()` and `Route.useParams()` resolve
 * by route id, which only exists inside the generated tree, and `_authed`'s `beforeLoad` decides
 * whether the screen is drawn at all. So this mounts the REAL `routeTree.gen` under a
 * `RouterProvider`, exactly as `main.tsx` does, and points the history at the path under test.
 *
 * Everything the shell asks the server for on the way to that screen — `/api/me` for the door,
 * the roster, the channel list, the working ledger, the notification outbox, the Bot's tools — has
 * a default answer here, so a test only says what is different about the screen it is about.
 *
 * WHY NOTHING THAT RENDERS IS IMPORTED AT THE TOP — not the route tree, not React DOM, not the
 * router or the query client. Each decides at module evaluation whether a DOM exists, once for the
 * whole `bun test` process: Base UI whether popups can render (see `confirm-dialog.test.tsx`), React
 * DOM whether the `input` event exists (`isInputEventSupported`), TanStack whether it is a server.
 * This file used to import `react-dom/client` at the top, so the first file to import it evaluated
 * React DOM with no DOM registered — and from then on a typed character raised no `onChange` in ANY
 * later file. Measured: `sidebar-rail.test.tsx`'s search passed alone and failed after any file that
 * mounts the app, in the gate's sorted order.
 */

/** A socket that never connects. `_authed` opens one on mount and would reach for a real server. */
class FakeSocket {
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  close() {
    this.onclose?.();
  }
}

/**
 * Call from `beforeAll(installAppDom, APP_DOM_TIMEOUT_MS)`. Pairs with `removeAppDom`.
 *
 * It also pays for the route tree up front. Measured: the first import of `routeTree.gen` takes
 * about six seconds — every route, CopilotKit, KaTeX — which is past bun's five-second test
 * timeout, so a file whose first test did the importing failed on the clock and then overlapped
 * its leftover work with the next test's `act()`. A hook may be given a longer timeout; a test
 * should not have to.
 */
export async function installAppDom(): Promise<void> {
  // A real origin: the socket hook resolves against `window.location`, and `about:blank` throws.
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  await import("../../src/routeTree.gen");
}

/** The route tree's first import is the slow part; the hook that pays for it needs this long. */
export const APP_DOM_TIMEOUT_MS = 30_000;

/** Call from `afterAll`. */
export async function removeAppDom(): Promise<void> {
  await unmountApps();
  await GlobalRegistrator.unregister();
}

/**
 * Every app still mounted, so a test that never reached its own `unmount` does not outlive itself.
 *
 * A test that times out is abandoned where it stood — inside a `waitFor`, before its `finally` — and
 * what it leaves behind is a mounted route tree with its polls still running and `fetch` still
 * stubbed. Measured: one timeout in the first file of a full run failed 135 tests in the files after
 * it, none of which had anything wrong with them.
 */
const mounted = new Set<() => Promise<void>>();

/** Unmount whatever a test left. `removeAppDom` calls it; a file may call it `afterEach` too. */
export async function unmountApps(): Promise<void> {
  for (const unmount of [...mounted]) await unmount();
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One request as the stub saw it. `path` carries the query string; `pathname` does not. */
export type ApiRequest = {
  method: string;
  path: string;
  pathname: string;
  url: URL;
  body: unknown;
};

/**
 * A test's answers. Return `undefined` to let the shell's default answer that route; return a
 * promise that never resolves to hold a screen in its pending state.
 */
export type ApiAnswer = (
  request: ApiRequest,
) => Response | Promise<Response> | undefined;

export const CURRENT_USER = {
  id: "user-1",
  email: "dev@laf.local",
  name: "Dev",
  image: null,
};

/** A roster entry with every field the type requires, so a fixture cannot drift into `undefined`. */
export function agentFixture(
  overrides: Partial<AgentProfile> & { id: string; name: string },
): AgentProfile {
  return {
    roleDescription: "",
    avatarSeed: `s:${overrides.id}`,
    effort: "balanced",
    autoReview: "",
    endpoint: "http://bot.local",
    hasAuth: false,
    hidden: false,
    notify: true,
    systemOwned: false,
    canManage: true,
    mine: true,
    ...overrides,
  };
}

/** What the shell needs to reach any screen, answered as an account with nothing in it yet. */
function shellAnswer(
  request: ApiRequest,
  role: "user" | "admin",
): Response | undefined {
  const { pathname } = request;
  if (pathname === "/api/me") {
    return json({
      user: { ...CURRENT_USER, role, onboarded: true },
      deployment: { effort: true, autoReview: true },
    });
  }
  if (pathname === "/api/agents") return json({ agents: [] });
  if (pathname === "/api/agents/working") return json({ working: [] });
  if (pathname === "/api/channels") return json({ channels: [] });
  if (pathname === "/api/me/notifications") return json({ notifications: [] });
  if (pathname.startsWith("/api/approvals/")) return json({ approvals: [] });
  if (pathname.startsWith("/api/plugins/for/")) {
    return json({ tools: [], skills: [] });
  }
  if (pathname === "/api/plugins") {
    return json({ catalogue: [], servers: [], skills: [] });
  }
  if (pathname.startsWith("/api/components/for-agent/")) {
    return json({ components: [] });
  }
  if (pathname === "/api/components") return json({ components: [] });
  if (pathname === "/api/components/functions") return json({ functions: [] });
  if (pathname === "/api/connections/overview") {
    return json({
      generatedAt: new Date().toISOString(),
      accounts: [],
      sites: [],
      bots: [],
    });
  }
  if (pathname === "/api/admin/audit-events") return json({ events: [] });
  // CopilotKit asks the runtime what it serves before it will settle; a 404 here is logged as an
  // error on every mount. A version and no agents is a runtime with nothing to say.
  if (pathname === "/api/copilotkit/info") {
    return json({ version: "0.0.0-test", agents: {} });
  }
  // The gallery announces its catalogue on mount; an empty answer means nothing was added.
  if (pathname === "/api/components/catalogue") return json({ added: [] });
  return undefined;
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (body === null || body === undefined) return null;
  try {
    return JSON.parse(String(body));
  } catch {
    return String(body);
  }
}

/**
 * React ignores a plain `value =` on a controlled input: its own value tracker sees no change and
 * swallows the `input` event. Setting through the prototype's setter is what a keystroke does.
 */
function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype = Object.getPrototypeOf(element) as object;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
}

export async function mountApp(options: {
  path: string;
  role?: "user" | "admin";
  api?: ApiAnswer;
}) {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { createMemoryHistory, createRouter, RouterProvider } = await import(
    "@tanstack/react-router"
  );
  const role = options.role ?? "user";
  const requests: ApiRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(async (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(href, "http://localhost:3110/");
    const request: ApiRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: `${url.pathname}${url.search}`,
      pathname: url.pathname,
      url,
      body: parseBody(init?.body),
    };
    requests.push(request);
    const answer = (await options.api?.(request)) ?? shellAnswer(request, role);
    // A route nothing stubbed is a 404, never a throw: a throw would read as the server being
    // unreachable, which `/api/me` turns into a redirect away from the screen under test.
    return answer ?? json({ error: "laf:not_stubbed" }, 404);
  });

  const { routeTree } = await import("../../src/routeTree.gen");
  const { PageSkeleton } = await import("../../src/components/ui/skeleton");
  const { router: appRouter } = await import("../../src/router");

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [options.path] }),
    context: { queryClient },
    /*
     * The app's own error screen, as `router.tsx` sets it. Without it the router puts no catch
     * boundary around a route, and a page that throws reaches whatever is above it — which is not
     * what happens in the app, and a seam tested that way passed while the app's router caught the
     * page one level below it (measured 2026-09-18).
     */
    defaultErrorComponent: appRouter.options.defaultErrorComponent,
    defaultPendingComponent: PageSkeleton,
    // Shown at once and released at once: the wait below reads its absence as "the route resolved".
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });

  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  const settle = async (ms = 20) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  const waitFor = async (
    ready: () => boolean,
    label: string,
    timeoutMs = 3000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${label}`);
      }
      await settle(10);
    }
  };

  let isMounted = true;
  const unmount = async () => {
    if (!isMounted) return;
    isMounted = false;
    mounted.delete(unmount);
    await act(async () => {
      root.unmount();
    });
    host.remove();
    queryClient.clear();
    globalThis.fetch = realFetch;
    // The socket's release is deferred by a turn; wait past it so nothing lands in the next test.
    await settle(10);
  };
  mounted.add(unmount);

  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router }),
      ),
    );
  });
  await waitFor(
    () =>
      router.state.status === "idle" &&
      host.querySelector('[data-slot="page-skeleton"]') === null,
    `the route ${options.path} to settle`,
  );
  await settle();

  return {
    host,
    router,
    queryClient,
    requests,
    settle,
    waitFor,
    /**
     * Go somewhere, and wait for the screen to get there.
     *
     * Started inside `act` and then waited for in `act`'s own short scopes, never awaited inside one
     * and never started outside one. Outside `act`, React hands the work to its scheduler, and that
     * scheduler is only alive in the first file of a run to register a DOM: it took its timer from
     * that DOM when react-dom was first evaluated, and every later file unregisters and registers a
     * new one. Measured: an update outside `act` never committed after any other DOM file had run —
     * not even the first render. And awaited INSIDE one `act`, a navigation deadlocks: the router
     * waits for the commit that `act` only flushes once the callback returns.
     */
    navigate: async (to: string) => {
      let arrived = false;
      await act(async () => {
        void router.navigate({ to }).then(() => {
          arrived = true;
        });
      });
      await waitFor(() => arrived, `the navigation to ${to}`, 8000);
      await settle();
    },
    /** The screen's own pane: everything under `<main>`, away from the roster and the rail. */
    main: () => host.querySelector("main"),
    click: async (target: Element) => {
      await act(async () => {
        target.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      await settle();
    },
    type: async (
      target: HTMLInputElement | HTMLTextAreaElement,
      value: string,
    ) => {
      await act(async () => {
        setNativeValue(target, value);
        target.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
    },
    /** Buttons with a visible name, for finding one by what a person reads. */
    buttonNamed: (name: string) =>
      [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === name,
      ),
    unmount,
  };
}
