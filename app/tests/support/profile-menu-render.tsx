/**
 * THE MENU BEHIND THE PERSON'S PICTURE, IN KOREAN, WITH ITS BUTTON PRESSED.
 *
 * The button draws no word — a picture, and a mark while something is new — so what it opens is
 * the whole of what it says, and its list cannot be seen from the shared test process: Base UI
 * decides once, when it is first evaluated, whether there is a DOM to draw a popup into
 * (`confirm-dialog.test.tsx`), and some earlier file has already made that answer no. Here the DOM
 * and the language are settled before any app module is imported, so the list is the real one, in
 * the words a person reads.
 *
 * Prints one line, `PROFILE_MENU <json>`. Not a test file (no `.test.` in the name), so the runner
 * never collects it on its own — and nothing may import a value from it, which would run it: types
 * only.
 *
 *     bun app/tests/support/profile-menu-render.tsx
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** One account's menu: the button as it stands, and what it opens. */
export type MenuShown = {
  button: {
    label: string | null;
    title: string | null;
    /** Every character drawn in it: the picture's one letter, and nothing else. */
    text: string;
    hasMark: boolean;
  };
  /** In order: each item's words and, for one that goes somewhere, where. */
  items: [name: string, to: string | null][];
  /** The headings between items, in order. */
  labels: string[];
};

export type ProfileMenuShown = {
  /** One Bot, with a new post on 소식, an unread conversation and two goals in progress. */
  oneBot: MenuShown;
  /** The same person with nothing new anywhere. */
  quiet: MenuShown;
  /** An account from before the cap: two Bots in sight and one hidden, one of them working. */
  several: MenuShown;
  /** An administrator's. */
  admin: MenuShown;
};

process.env.NODE_ENV = "test";
GlobalRegistrator.register({ url: "http://localhost:3110/" });
// Chosen before a single app module is imported: this is what `storedLocale()` reads.
window.localStorage.setItem("laf.locale", "ko");
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { stubFetch } = await import("./fetch");
const { json, routerAt } = await import("./mount");
const { agentFixture } = await import("./app-router");
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
  "@tanstack/react-query"
);
const { RouterProvider } = await import("@tanstack/react-router");
const { ProfileMenu } = await import(
  "../../src/components/layout/profile-menu"
);

type Account = {
  role: "user" | "admin";
  agents: ReturnType<typeof agentFixture>[];
  hidden: ReturnType<typeof agentFixture>[];
  channels: unknown[];
  working: unknown[];
  unseen: number;
  activeGoals: number;
};

const conversation = (id: string, agentId: string, unread: boolean) => ({
  id,
  name: agentId,
  agentIds: [agentId],
  threadId: `thread-${id}`,
  active: true,
  lastMessage: "…",
  lastMessageAt: "2026-10-10T00:00:00Z",
  lastMessageAgentId: agentId,
  unread,
  createdAt: "2026-10-10T00:00:00Z",
});

function serve(account: Account) {
  globalThis.fetch = stubFetch(async (input) => {
    const url = String(input);
    if (url === "/api/agents") return json({ agents: account.agents });
    if (url === "/api/agents?hidden=true") {
      return json({ agents: account.hidden });
    }
    if (url === "/api/agents/working") {
      return json({ working: account.working });
    }
    if (url === "/api/channels") return json({ channels: account.channels });
    if (url === "/api/feed/unseen") return json({ count: account.unseen });
    if (url === "/api/goals") {
      return json({ goals: [], active: account.activeGoals, max: 3 });
    }
    if (url === "/api/me") {
      return json({
        user: {
          id: "u1",
          email: "kim@example.com",
          name: "김기범",
          role: account.role,
          onboarded: true,
        },
      });
    }
    return json({ error: "laf:not_stubbed" }, 404);
  });
}

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
  "/settings/logins",
  "/admin",
  "/feed",
  "/ideas",
  "/goals",
  "/made",
  "/channel/$channelId",
  "/channel/new",
  "/sign",
];

async function press(element: Element | null) {
  if (!element) throw new Error("nothing to press");
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  await settle(120);
}

/** The menu, mounted on its own for one account, read closed and then open. */
async function shownFor(account: Account): Promise<MenuShown> {
  serve(account);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = await routerAt("/help", PATHS, () =>
    createElement(QueryClientProvider, { client }, createElement(ProfileMenu)),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(RouterProvider, { router }));
  });
  await settle(160);
  try {
    const button = host.querySelector("[data-profile-menu]");
    const standing = {
      label: button?.getAttribute("aria-label") ?? null,
      title: button?.getAttribute("title") ?? null,
      text: button?.textContent ?? "",
      hasMark: button?.querySelector('[data-mark="new"]') != null,
    };
    await press(button);
    const items = [
      ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].map((item): [string, string | null] => [
      item.textContent ?? "",
      item.getAttribute("href"),
    ]);
    const labels = [
      ...document.body.querySelectorAll<HTMLElement>(
        '[data-slot="dropdown-menu-label"]',
      ),
    ].map((label) => label.textContent ?? "");
    return { button: standing, items, labels };
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    document.body.innerHTML = "";
  }
}

const one: Account = {
  role: "user",
  agents: [agentFixture({ id: "bot-1", name: "초롱" })],
  hidden: [],
  channels: [conversation("c-1", "bot-1", true)],
  working: [],
  unseen: 3,
  activeGoals: 2,
};

const shown: ProfileMenuShown = {
  oneBot: await shownFor(one),
  quiet: await shownFor({
    ...one,
    channels: [conversation("c-1", "bot-1", false)],
    unseen: 0,
    activeGoals: 0,
  }),
  several: await shownFor({
    ...one,
    agents: [
      agentFixture({ id: "bot-1", name: "초롱" }),
      agentFixture({ id: "bot-2", name: "두리" }),
    ],
    hidden: [agentFixture({ id: "bot-3", name: "세모", hidden: true })],
    channels: [
      conversation("c-1", "bot-1", false),
      conversation("c-2", "bot-2", true),
    ],
    unseen: 0,
    activeGoals: 0,
  }),
  admin: await shownFor({ ...one, role: "admin" }),
};

console.log(`PROFILE_MENU ${JSON.stringify(shown)}`);
await GlobalRegistrator.unregister();
process.exit(0);
