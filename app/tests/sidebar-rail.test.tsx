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
 * column does: its width class at each viewport, the button that appears below `lg` and what it
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

const agent = (id: string, name: string) => ({
  id,
  name,
  roleDescription: "",
  avatarSeed: id,
  effort: "balanced",
  autoReview: "",
  endpoint: null,
  hasAuth: false,
  hidden: false,
  notify: true,
  systemOwned: false,
  canManage: true,
  mine: true,
});

/**
 * An account from before 2026-09-24: three Bots, two of them with a conversation, and a room. A
 * person has one Bot now; an account like this keeps them all, and the sidebar is how it reaches
 * them. The room is not listed — rooms were removed.
 */
function server(
  bots = [
    agent("bot-1", "초롱"),
    agent("bot-2", "두리"),
    agent("bot-3", "세모"),
  ],
) {
  globalThis.fetch = stubFetch(async (input) => {
    const url = String(input);
    if (url === "/api/agents") {
      return json({ agents: bots });
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

async function roster(
  options: { wide?: boolean; bots?: ReturnType<typeof agent>[] } = {},
) {
  viewport.wide = options.wide ?? true;
  server(options.bots);
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
    /** The column's width, which is a class: `w-sidebar` open, `w-16` as a rail. */
    width: () =>
      classes(column()).find((cls) => cls === "w-sidebar" || cls === "w-16"),
    rows: () => [...column().querySelectorAll<HTMLAnchorElement>("ul a")],
    rowNamed: (name: string) =>
      [...column().querySelectorAll<HTMLAnchorElement>("ul a")].find(
        (row) =>
          row.querySelector(".text-base")?.textContent === name ||
          row.getAttribute("aria-label")?.startsWith(name),
      ),
    footerLinks: () => [
      ...column().querySelectorAll<HTMLAnchorElement>("[data-sidebar-nav] a"),
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
    expect(wide.width()).toBe("w-sidebar");
    await wide.unmount();
    const narrow = await roster({ wide: false });
    expect(narrow.width()).toBe("w-16");
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
    expect(view.width()).toBe("w-16");
    await view.resizeTo(true);
    expect(view.width()).toBe("w-sidebar");
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
    expect(view.width()).toBe("w-sidebar");
  });

  test("the person can open the full list at a narrow width too", async () => {
    const view = await roster({ wide: false });
    const expand = view.toggle();
    expect(expand?.getAttribute("aria-label")).toBe("Expand the sidebar");
    expect(expand?.getAttribute("aria-expanded")).toBe("false");
    expect(ko["Expand the sidebar"]).toBeTruthy();

    if (expand) await view.press(expand);
    expect(view.width()).toBe("w-sidebar");
    const collapse = view.toggle();
    expect(collapse?.getAttribute("aria-label")).toBe("Collapse the sidebar");
    expect(collapse?.getAttribute("aria-expanded")).toBe("true");
    expect(ko["Collapse the sidebar"]).toBeTruthy();
    // The list's heading came back with the words: this account still has several.
    expect(view.column().textContent).toContain("Your Bots");

    if (collapse) await view.press(collapse);
    expect(view.width()).toBe("w-16");
    expect(view.column().textContent).not.toContain("Your Bots");
  });

  test("above lg there is no toggle, because there is nothing to give back", async () => {
    const view = await roster({ wide: true });
    expect(view.toggle()).toBeNull();
  });

  test("the column and everything in it carry no inline style", async () => {
    /*
     * TAILWIND CLASSES ONLY. The width used to be the one exception, written as a style because
     * `w-[var(--sand-sidebar-width)]` is the raw-variable escape `design-tokens.test.ts` counts. It
     * has a name now (`w-sidebar`, from `--spacing-sidebar`), so the exception is gone.
     */
    const view = await roster();
    expect(view.column().hasAttribute("style")).toBe(false);
    const styled = [...view.column().querySelectorAll("*")]
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

describe("one Bot: who it is, then the conversation, then where else to go", () => {
  const one = () => [agent("bot-1", "초롱")];

  test("the Bot is at the top, and pressing it opens its profile", async () => {
    const view = await roster({ bots: one() });
    const identity = view
      .column()
      .querySelector<HTMLAnchorElement>('a[href^="/agents"]');
    expect(identity?.getAttribute("href")).toBe("/agents?agent=bot-1");
    expect(identity?.textContent).toContain("초롱");
    // What it is doing, in a word, under the name — the header's word.
    expect(identity?.getAttribute("aria-label")).toBe(
      "초롱 · Ready. Bot profile",
    );
    // And it is not a row of a list: the list is the conversation.
    expect(identity?.closest("ul")).toBeNull();
  });

  test("its conversation is one row, to its channel, with the last line and the unread mark", async () => {
    const view = await roster({ bots: one() });
    const rows = view.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("href")).toBe("/channel/ch-1");
    expect(rows[0]?.textContent).toContain("Conversation");
    expect(rows[0]?.textContent).toContain("3 orders are sorted, take a look");
    expect(rows[0]?.querySelector(".sr-only")?.textContent).toBe("Unread");
  });

  test("the nav has no second way to the profile, and is pinned below the part that scrolls", async () => {
    const view = await roster({ bots: one() });
    expect(view.footerLinks().map((link) => link.textContent)).toEqual([
      "Routines",
      "Skills",
      "Connections",
      "Help",
    ]);
    /*
     * OUT OF THE SCROLLING PART, PINNED ABOVE THE ACCOUNT. At the PC app's smallest window (1024×640)
     * 오늘 pushed 루틴, 스킬, 연결 and 도움말 below the fold when they scrolled with it (UX review 0.5.4,
     * item 4). The Bot, its conversation and 오늘 scroll; the links do not.
     */
    const nav = view.column().querySelector("[data-sidebar-nav]");
    expect(nav?.className).toContain("shrink-0");
    expect(nav?.closest(".overflow-y-auto")).toBeNull();
    const scroller = view.column().querySelector(".overflow-y-auto");
    expect(scroller?.textContent).toContain("Conversation");
  });

  test("the rail keeps a name on the face and on the conversation", async () => {
    const view = await roster({ bots: one(), wide: false });
    const identity = view
      .column()
      .querySelector<HTMLAnchorElement>('a[href^="/agents"]');
    expect(identity?.getAttribute("aria-label")).toBe("초롱 · Ready");
    expect(view.rows()[0]?.getAttribute("aria-label")).toBe(
      "Conversation · Unread",
    );
  });
});

describe("on a phone the column is a sheet, out only when asked for", () => {
  test("put away until the menu opens it, and then the whole column with its words", async () => {
    const view = await roster({ wide: false });
    expect(classes(view.column())).toContain("max-md:invisible");
    expect(classes(view.column())).toContain("max-md:-translate-x-full");

    const { openMobileNav } = await import("../src/lib/mobile-nav");
    const { act } = await import("react");
    await act(async () => openMobileNav());
    await view.settle();
    expect(classes(view.column())).toContain("max-md:translate-x-0");
    expect(classes(view.column())).not.toContain("max-md:invisible");
    // Narrow, and still the full column: the sheet is there to be read, not squinted at.
    expect(view.width()).toBe("w-sidebar");
    expect(view.column().textContent).toContain("Your Bots");
    // The press outside it and the X in it both put it away; so does Escape.
    expect(
      view.host.querySelectorAll('button[aria-label="Close the menu"]'),
    ).toHaveLength(2);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await view.settle();
    expect(classes(view.column())).toContain("max-md:invisible");
    expect(ko["Open the menu"]).toBe("메뉴 열기");
    expect(ko["Close the menu"]).toBe("메뉴 닫기");
  });

  test("the menu button draws only where there is a sidebar to open", async () => {
    const { MobileNavButton } = await import(
      "../src/components/layout/mobile-nav-button"
    );
    const alone = await mount(<MobileNavButton />);
    expect(alone.host.querySelector("button")).toBeNull();
    await alone.unmount();

    const view = await roster();
    const withSidebar = await mount(<MobileNavButton />);
    expect(
      withSidebar.host.querySelector("button")?.getAttribute("aria-label"),
    ).toBe("Open the menu");
    await withSidebar.unmount();
    await view.unmount();
  });
});
