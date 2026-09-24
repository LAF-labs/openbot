import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { focusRing } from "../src/components/ui/focus";
import { activeLocale } from "../src/lib/i18n";
import { ko } from "../src/lib/i18n-ko";
import { stubFetch } from "./support/fetch";
import { json, mount, routerAt, unmountAll } from "./support/mount";

/**
 * The roster's column, rendered.
 *
 * It was walked as source — `RAIL_WIDTH = "4rem"` as a substring, the count of `style={{`, the
 * string `"(min-width: 64rem)"` somewhere in the file — which passes on a column that reads the
 * breakpoint and never uses it, and on a width constant nothing is ever set to. So `BotSidebar` is
 * mounted here against a stub server and a stub `matchMedia`, and what is asserted is what the
 * column does: its inline width at each viewport, the button that appears below `lg` and what it
 * does when pressed, the query the component actually subscribed to, and one `Link` per row.
 *
 * THE BREAKPOINT IS THE STUB'S RECORD, NOT THE FILE'S. `lg` is 1024px because a media query
 * resolves `rem` against the INITIAL root font size, not this app's 14px root. Reading a different
 * query in JavaScript than `lg:` compiles to in CSS would put the rail and everything else that is
 * responsive on either side of a 128px no-man's-land, and the only honest witness is the string
 * `matchMedia` was handed.
 *
 * Popups — the context menu, the account menu, every tooltip — render nothing here (see
 * `confirm-dialog.test.tsx`), so nothing below asserts on their contents.
 */

/**
 * A stand-in `matchMedia` that answers `wide` to every `min-width` question, and remembers which
 * queries were asked and which were subscribed to. The avatar asks about reduced motion on every
 * face; only the column subscribes, and the breakpoint it subscribed to is the fact under test.
 */
const viewport = {
  wide: true,
  queries: [] as string[],
  subscriptions: new Map<string, Set<() => void>>(),
};

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => {
    viewport.queries.push(query);
    const listeners = () => {
      const held = viewport.subscriptions.get(query) ?? new Set();
      viewport.subscriptions.set(query, held);
      return held;
    };
    return {
      matches: query.startsWith("(min-width") ? viewport.wide : false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        listeners().add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners().delete(listener);
      },
      addListener() {},
      removeListener() {},
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountAll();
  globalThis.fetch = realFetch;
  viewport.wide = true;
  viewport.queries = [];
  viewport.subscriptions.clear();
});

const NOW = new Date();
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();
/** A minute past midnight today, so "today" holds whatever the hour the suite runs at. */
const TODAY = new Date(
  NOW.getFullYear(),
  NOW.getMonth(),
  NOW.getDate(),
  0,
  1,
).toISOString();

const agent = (id: string, name: string, title: string) => ({
  id,
  name,
  title,
  roleDescription: "",
  avatarSeed: id,
  effort: "balanced",
  autoReview: "",
  endpoint: null,
  hasAuth: false,
  hidden: false,
  pinnedAt: null,
  notify: true,
  systemOwned: false,
  canManage: true,
  mine: true,
});

/**
 * An account from before 2026-09-24: three Bots, two of them with a conversation, and a room. A
 * person has one Bot now; an account like this keeps them all, and the sidebar is how it reaches
 * them. The room is not listed — rooms were removed — and a Bot's job title is not drawn.
 */
function server() {
  globalThis.fetch = stubFetch(async (input) => {
    const url = String(input);
    if (url === "/api/agents") {
      return json({
        agents: [
          agent("bot-1", "초롱", "주문 담당"),
          agent("bot-2", "두리", "리뷰 담당"),
          agent("bot-3", "세모", ""),
        ],
      });
    }
    if (url === "/api/agents?hidden=true") return json({ agents: [] });
    if (url === "/api/agents/working") return json({ working: [] });
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
    if (url === "/api/channels") {
      return json({
        channels: [
          {
            id: "ch-1",
            name: "초롱",
            agentIds: ["bot-1"],
            threadId: "t1",
            active: true,
            lastMessage: "3 orders are sorted, take a look",
            lastMessageAt: TODAY,
            lastMessageAgentId: "bot-1",
            unread: true,
            createdAt: daysAgo(3),
          },
          {
            id: "ch-2",
            name: "두리",
            agentIds: ["bot-2"],
            threadId: "t2",
            active: true,
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            unread: false,
            createdAt: daysAgo(2),
          },
          {
            // A room whose last message is its own title: the second line must still say something.
            id: "ch-3",
            name: "초롱, 두리",
            agentIds: ["bot-1", "bot-2"],
            threadId: "t3",
            active: true,
            lastMessage: "초롱, 두리",
            lastMessageAt: null,
            lastMessageAgentId: null,
            unread: false,
            createdAt: daysAgo(10),
          },
        ],
      });
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

/** What Tailwind's `lg:` compiles to, and so what the column must ask about. */
const WIDE = "(min-width: 64rem)";

const PATHS = [
  "/",
  "/agents",
  "/routines",
  "/skills",
  "/help",
  "/settings",
  "/admin",
  "/channel/$channelId",
  "/channel/new",
  "/sign",
];

async function roster(options: { wide?: boolean } = {}) {
  viewport.wide = options.wide ?? true;
  server();
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { RouterProvider } = await import("@tanstack/react-router");
  const { BotSidebar } = await import(
    "../src/components/app-sidebar/bot-sidebar"
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = await routerAt("/channel/ch-1", PATHS, () => (
    <QueryClientProvider client={client}>
      <BotSidebar />
    </QueryClientProvider>
  ));
  const view = await mount(<RouterProvider router={router} />);
  // The room's faces mount once the rows do and refetch the roster on their own; wait past that.
  await view.settle(60);
  const column = () => view.host.querySelector("nav") as HTMLElement;
  return {
    ...view,
    column,
    width: () => column().style.width,
    rows: () => [...column().querySelectorAll<HTMLAnchorElement>("ul a")],
    rowNamed: (name: string) =>
      [...column().querySelectorAll<HTMLAnchorElement>("ul a")].find(
        (row) =>
          row.querySelector(".text-base")?.textContent === name ||
          row.getAttribute("aria-label")?.startsWith(name),
      ),
    footerLinks: () => [
      ...column().querySelectorAll<HTMLAnchorElement>(
        ":scope > div:last-child a",
      ),
    ],
    toggle: () =>
      column().querySelector<HTMLButtonElement>(
        'button[aria-label="Expand the sidebar"], button[aria-label="Collapse the sidebar"]',
      ),
    /** The window crosses `lg`, and the media query's own event says so. */
    resizeTo: async (wide: boolean) => {
      viewport.wide = wide;
      const { act } = await import("react");
      await act(async () => {
        for (const listener of viewport.subscriptions.get(WIDE) ?? []) {
          listener();
        }
      });
      await view.settle();
    },
  };
}

const classes = (element: Element | null | undefined) =>
  (element?.className ?? "").split(/\s+/);

describe("the roster collapses to a rail", () => {
  test("the full column above lg, 64px below it", async () => {
    const wide = await roster({ wide: true });
    expect(wide.width()).toBe("var(--sand-sidebar-width)");
    await wide.unmount();
    const narrow = await roster({ wide: false });
    expect(narrow.width()).toBe("4rem");
  });

  test("reads the same breakpoint Tailwind's lg compiles to", async () => {
    await roster();
    expect(viewport.queries).toContain(WIDE);
    // No second breakpoint anywhere in the column: one `min-width`, and it is `lg`'s.
    expect(
      new Set(viewport.queries.filter((query) => query.includes("min-width"))),
    ).toEqual(new Set([WIDE]));
    // Subscribed, not just read once: a query nobody listens to is a column that never notices.
    expect([...viewport.subscriptions.keys()]).toEqual([WIDE]);
    expect(viewport.subscriptions.get(WIDE)?.size).toBeGreaterThan(0);
  });

  test("a window dragged across lg moves the column", async () => {
    const view = await roster({ wide: true });
    await view.resizeTo(false);
    expect(view.width()).toBe("4rem");
    await view.resizeTo(true);
    expect(view.width()).toBe("var(--sand-sidebar-width)");
  });

  test("and it notices a resize even when the media query's own event never comes", async () => {
    /*
     * Measured: with the window emulated from 800 to 1280 while the tab was backgrounded,
     * `matchMedia(…).matches` read true and the column stayed a rail until the next reload — the
     * `change` never arrived. `resize` is the second ear.
     */
    const view = await roster({ wide: false });
    viewport.wide = true;
    const { act } = await import("react");
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(view.width()).toBe("var(--sand-sidebar-width)");
  });

  test("the person can open the full list at a narrow width too", async () => {
    const view = await roster({ wide: false });
    const expand = view.toggle();
    expect(expand?.getAttribute("aria-label")).toBe("Expand the sidebar");
    expect(expand?.getAttribute("aria-expanded")).toBe("false");
    expect(ko["Expand the sidebar"]).toBeTruthy();

    if (expand) await view.press(expand);
    expect(view.width()).toBe("var(--sand-sidebar-width)");
    const collapse = view.toggle();
    expect(collapse?.getAttribute("aria-label")).toBe("Collapse the sidebar");
    expect(collapse?.getAttribute("aria-expanded")).toBe("true");
    expect(ko["Collapse the sidebar"]).toBeTruthy();
    // The list's heading came back with the words: this account still has several.
    expect(view.column().textContent).toContain("Your Bots");

    if (collapse) await view.press(collapse);
    expect(view.width()).toBe("4rem");
    expect(view.column().textContent).not.toContain("Your Bots");
  });

  test("above lg there is no toggle, because there is nothing to give back", async () => {
    const view = await roster({ wide: true });
    expect(view.toggle()).toBeNull();
  });

  test("the width is the one value in the column, and the rows carry none", async () => {
    /*
     * TAILWIND CLASSES ONLY, WITH ONE EXPLAINED EXCEPTION: `--sand-sidebar-width` written into a
     * class is `w-[var(--sand-…)]`, a raw palette variable in a class string, which is what
     * `design-tokens.test.ts` counts as drift. So the width stays a value on the column, and it is
     * the ONLY inline style between the column and its rows.
     */
    const view = await roster();
    expect(view.column().getAttribute("style")).toBe(
      "width: var(--sand-sidebar-width);",
    );
    const styled = [...view.column().querySelectorAll("li, a, ul, nav > div")]
      .filter((element) => element.hasAttribute("style"))
      .map((element) => element.tagName);
    expect(styled).toEqual([]);
  });

  test("a face in the rail still has a name, on screen and in the tree", async () => {
    /*
     * A face with no words beside it is a link with no accessible name, so the rail hands every row
     * an `aria-label` and a tooltip. Losing either turns the whole column into unlabelled graphics.
     */
    const view = await roster({ wide: false });
    const rows = view.rows();
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "초롱 · Unread",
      "두리",
      "세모",
    ]);
    for (const row of rows) {
      expect(row.dataset.slot).toBe("tooltip-trigger");
      expect(classes(row)).toContain("justify-center");
    }
  });
});

describe("one row layout", () => {
  test("every row is one Link to the Bot's own conversation, and a room from before is not a row", async () => {
    const view = await roster();
    const items = [...view.column().querySelectorAll("ul > li")];
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.querySelectorAll("a")).toHaveLength(1);
      expect(item.querySelectorAll("button")).toHaveLength(0);
    }
    expect(view.rowNamed("초롱")?.getAttribute("href")).toBe("/channel/ch-1");
    expect(view.rowNamed("두리")?.getAttribute("href")).toBe("/channel/ch-2");
    // A Bot nobody has spoken to yet leads to the compose screen for it.
    expect(view.rowNamed("세모")?.getAttribute("href")).toBe(
      "/channel/new?agent=bot-3",
    );
    expect(view.rowNamed("초롱, 두리")).toBeUndefined();
  });

  test("that layout is name, last line and time", async () => {
    const view = await roster();
    expect(
      view.rows().map((row) => row.querySelector(".text-base")?.textContent),
    ).toEqual(["초롱", "두리", "세모"]);
    const first = view.rowNamed("초롱");
    expect(first?.textContent).toContain("3 orders are sorted, take a look");
    expect(first?.querySelector(".tabular-nums")?.textContent).toBe(
      new Date(TODAY).toLocaleTimeString(activeLocale, {
        hour: "numeric",
        minute: "2-digit",
      }),
    );
    // The row you are in is the one that is lit.
    expect(first?.getAttribute("data-status")).toBe("active");
  });

  test("a conversation's time is when it was last spoken in, or when it began", async () => {
    /*
     * The server's own `coalesce(last_message_at, created_at)`. 두리's conversation has no message
     * yet and still has a time; 세모 has no conversation at all, and no time is the only honest
     * answer for that.
     */
    const view = await roster();
    const weekday = (iso: string) =>
      new Date(iso).toLocaleDateString(activeLocale, { weekday: "short" });
    expect(
      view.rowNamed("두리")?.querySelector(".tabular-nums")?.textContent,
    ).toBe(weekday(daysAgo(2)));
    expect(
      view.rowNamed("세모")?.querySelector(".tabular-nums")?.textContent,
    ).toBe("");
  });

  test("a Bot's job title is not drawn under its name — the profile is a name and a face", async () => {
    // "리뷰 담당" is what an older Bot's row said before anything had been said to it. The title
    // stays in the row it was saved in; nothing draws it (2026-09-24).
    const view = await roster();
    expect(view.rowNamed("두리")?.textContent).not.toContain("리뷰 담당");
    expect(view.rowNamed("초롱")?.textContent).not.toContain("주문 담당");
  });
});

describe("the roster's controls", () => {
  test("every roster row and footer link carries the house ring", async () => {
    // Neither row had a ring at all: a keyboard walking the roster moved through five colleagues
    // with nothing on screen saying which one it was on.
    const view = await roster();
    const links = [...view.rows(), ...view.footerLinks()];
    expect(links.length).toBeGreaterThanOrEqual(8);
    const bare = links
      .filter((link) =>
        focusRing.split(" ").some((cls) => !classes(link).includes(cls)),
      )
      .map((link) => link.getAttribute("href"));
    expect(bare).toEqual([]);
  });

  test("there is no way to start another conversation, search a roster or tidy one away", async () => {
    const view = await roster();
    expect(
      view.column().querySelector('a[aria-label="Start a new channel"]'),
    ).toBeNull();
    expect(view.column().querySelector("input[type=search]")).toBeNull();
    expect(
      view.column().querySelector('button[aria-label="Show hidden Bots"]'),
    ).toBeNull();
  });

  test("the profile nav item is the Bot's own, not a list of people", async () => {
    const view = await roster();
    const profile = view
      .footerLinks()
      .find((link) => link.getAttribute("href") === "/agents");
    expect(
      profile?.querySelector("svg.tabler-icon-user-circle"),
    ).not.toBeNull();
    expect(view.column().querySelector(".tabler-icon-users")).toBeNull();
  });
});

describe("the roster speaks the app's language", () => {
  /*
   * Whether every time down the roster is written in the app's language rather than the machine's
   * is rendered in Korean by `korean-render.test.ts`: this process's locale is English whichever way
   * the call is written, so only a Korean process can tell the two apart.
   */
  test("the footer's labels are all translated", async () => {
    // `t(label)` is invisible to `i18n-coverage.test.ts`, which only sees a literal `t("…")`.
    const view = await roster();
    const labels = view.footerLinks().map((link) => link.textContent);
    expect(labels).toEqual([
      "Bot profile",
      "Routines",
      "Skills",
      "Connections",
      "Help",
    ]);
    for (const label of labels) {
      expect(ko[label as string]).toBeTruthy();
    }
    await view.unmount();
    // In the rail the same five words move into the labels.
    const rail = await roster({ wide: false });
    expect(
      rail.footerLinks().map((link) => link.getAttribute("aria-label")),
    ).toEqual(labels);
  });
});
