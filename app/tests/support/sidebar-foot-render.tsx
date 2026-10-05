/**
 * THE SIDEBAR'S FOOT, IN KOREAN, WITH ITS BUTTON PRESSED.
 *
 * The foot is one button with no word beside it — the account's picture and the menu's icon, one
 * control since 2026-10-06 — so what it opens is the whole of what it says, and its list cannot be
 * seen from `sidebar-rail.test.tsx`: Base UI decides once, when it is first evaluated, whether
 * there is a DOM to draw a popup into (`confirm-dialog.test.tsx`), and in the shared test process
 * some earlier file has already made that answer no. Here the DOM and the language are settled
 * before any app module is imported, so the list is the real one, in the words a person reads.
 *
 * Prints one line, `SIDEBAR_FOOT <json>`. Not a test file (no `.test.` in the name), so the runner
 * never collects it on its own — and nothing may import a value from it, which would run it: types
 * only.
 *
 *     bun app/tests/support/sidebar-foot-render.tsx
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export type FootShown = {
  /** The foot as it stands, before anything is pressed. */
  foot: {
    /** Every character drawn in it: the picture's one letter, and nothing else. */
    text: string;
    menu: { label: string | null; title: string | null; text: string };
  };
  /** What the button opens, in order: each item's words and, for one that goes somewhere, where. */
  items: [name: string, to: string | null][];
};

process.env.NODE_ENV = "test";
GlobalRegistrator.register({ url: "http://localhost:3110/" });
// Chosen before a single app module is imported: this is what `storedLocale()` reads.
window.localStorage.setItem("laf.locale", "ko");
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// Wide: the full column, which is the one whose foot is a single row.
window.matchMedia = ((query: string) => ({
  matches: query.startsWith("(min-width"),
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => true,
})) as unknown as typeof window.matchMedia;

const { stubFetch } = await import("./fetch");
const { json, routerAt } = await import("./mount");
const { agentFixture } = await import("./app-router");
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
  "@tanstack/react-query"
);
const { RouterProvider } = await import("@tanstack/react-router");

globalThis.fetch = stubFetch(async (input) => {
  const url = String(input);
  if (url === "/api/agents") {
    return json({ agents: [agentFixture({ id: "bot-1", name: "초롱" })] });
  }
  if (url === "/api/agents?hidden=true") return json({ agents: [] });
  if (url === "/api/agents/working") return json({ working: [] });
  if (url === "/api/channels") return json({ channels: [] });
  if (url === "/api/me") {
    return json({
      user: {
        id: "u1",
        email: "kim@example.com",
        name: "김기범",
        role: "user",
        onboarded: true,
      },
    });
  }
  return json({ error: "laf:not_stubbed" }, 404);
});

const { BotSidebar } = await import(
  "../../src/components/app-sidebar/bot-sidebar"
);

const settle = (ms = 60) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

const PATHS = [
  "/",
  "/agents",
  "/notebook",
  "/routines",
  "/skills",
  "/help",
  "/settings",
  "/settings/connected-accounts",
  "/admin",
  "/feed",
  "/ideas",
  "/goals",
  "/made",
  "/channel/$channelId",
  "/channel/new",
  "/sign",
];

/** The column, mounted on its own; what `use` reads is read while it is. */
async function mounted<T>(use: (host: HTMLElement) => Promise<T>): Promise<T> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = await routerAt("/help", PATHS, () =>
    createElement(QueryClientProvider, { client }, createElement(BotSidebar)),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(RouterProvider, { router }));
  });
  await settle(120);
  try {
    return await use(host);
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    document.body.innerHTML = "";
  }
}

async function press(element: Element | null) {
  if (!element) throw new Error("nothing to press");
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  await settle(120);
}

const items = () => [
  ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];

const shown: FootShown = await mounted(async (host) => {
  const foot = host.querySelector("[data-sidebar-nav]");
  const menu = host.querySelector("[data-sidebar-menu]");
  const standing = {
    text: foot?.textContent ?? "",
    menu: {
      label: menu?.getAttribute("aria-label") ?? null,
      title: menu?.getAttribute("title") ?? null,
      text: menu?.textContent ?? "",
    },
  };
  await press(menu);
  const opened = items().map((item): [string, string | null] => [
    item.textContent ?? "",
    item.getAttribute("href"),
  ]);
  return { foot: standing, items: opened };
});

console.log(`SIDEBAR_FOOT ${JSON.stringify(shown)}`);
process.exit(0);
