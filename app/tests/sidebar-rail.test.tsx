import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { footerLinksFor } from "../src/components/app-sidebar/places";
import { focusRing } from "../src/components/ui/focus";
import { activeLocale } from "../src/lib/i18n";
import { ko } from "../src/lib/i18n-ko";
import { stubFetch } from "./support/fetch";
import { json, mount, routerAt, unmountAll } from "./support/mount";
import type { FootShown } from "./support/sidebar-foot-render";

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
 * `confirm-dialog.test.tsx`), so nothing mounted below asserts on their contents. What the foot's
 * button opens is read from a process of its own (`support/sidebar-foot-render.tsx`), where the
 * list is the real one.
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

/** Every address the column asked the server for: what it reads is part of what it is. */
const asked: string[] = [];

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountAll();
  globalThis.fetch = realFetch;
  viewport.wide = true;
  viewport.queries = [];
  viewport.subscriptions.clear();
  asked.length = 0;
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

/** Who is signed in, as the foot's picture is named: the name and the address `/api/me` gives. */
const ACCOUNT = "김기범 · kim@example.com";

/** What the first Bot did today and what it does next, as the server would list them. */
const DONE_TODAY = "예스24에서 책 찾아 줘";
const COMING_NEXT = "아침 브리핑";

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
    asked.push(url);
    if (url === "/api/agents") {
      return json({ agents: bots });
    }
    if (url === "/api/agents?hidden=true") return json({ agents: [] });
    if (url === "/api/agents/working") return json({ working: [] });
    /*
     * A DAY WITH WORK IN IT AND A ROUTINE TO COME, WHICH THE COLUMN NEVER ASKS FOR. It listed both
     * under its rows until 2026-10-04. They are answered so that the test holding it to that can
     * fail: refused, as every other address this server does not know is, a list put back would
     * have nothing to draw and would read as gone.
     */
    if (url === "/api/agents/bot-1/day") {
      return json({
        day: "2026-10-04",
        zone: "Asia/Seoul",
        items: [
          {
            kind: "chat",
            runId: "run-1",
            at: TODAY,
            status: "done",
            label: DONE_TODAY,
            channelId: "ch-1",
            messageId: "m-1",
            frameToolCallId: null,
          },
        ],
        more: false,
      });
    }
    if (url === "/api/routines") {
      return json({
        routines: [
          {
            id: "rt-1",
            agentId: "bot-1",
            name: COMING_NEXT,
            instruction: COMING_NEXT,
            scheduleKind: "daily",
            intervalMinutes: null,
            dailyLocal: "07:30",
            dailyTimeZone: "Asia/Seoul",
            dailyDays: null,
            enabled: true,
            lastRunAt: null,
            nextRunAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
          },
        ],
      });
    }
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
    /**
     * The foot's controls: one button at either width since 2026-10-06 — the account's picture
     * and the menu's icon in the full column, the picture alone in the rail.
     */
    footerLinks: () => [
      ...column().querySelectorAll<HTMLAnchorElement>(
        "[data-sidebar-nav] a, [data-sidebar-nav] button",
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
    // The Bots' rows and the foot's button.
    expect(links.length).toBeGreaterThanOrEqual(4);
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
  test("the foot's button is named at both widths, and every place it holds has its Korean", async () => {
    // It has no word beside it, so the name is all there is to read aloud: what it is, and whose.
    const view = await roster();
    expect(
      view.footerLinks().map((link) => link.getAttribute("aria-label")),
    ).toEqual([`Menu · ${ACCOUNT}`]);
    expect(ko.Menu).toBe("메뉴");
    await view.unmount();
    // In the rail it is the picture alone, and still the one button. `ACCOUNT` is the full
    // column's name for the person; the rail names them by the name alone.
    const rail = await roster({ wide: false });
    expect(
      rail.footerLinks().map((link) => link.getAttribute("aria-label")),
    ).toEqual([`Menu · ${ACCOUNT.split(" · ")[0]}`]);
    // `t(label)` is invisible to `i18n-coverage.test.ts`, which only sees a literal `t("…")`.
    for (const { label } of footerLinksFor(true)) {
      expect({ label, korean: Boolean(ko[label]) }).toEqual({
        label,
        korean: true,
      });
    }
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

  test("its conversation is one row like the four under it — an icon and 대화, no preview and no time — and unread is a dot at its edge", async () => {
    const view = await roster({ bots: one() });
    const rows = view.rows();
    expect(rows).toHaveLength(5);
    expect(rows[1]?.getAttribute("href")).toBe("/feed");
    expect(rows[1]?.textContent).toBe("Updates");
    expect(rows[2]?.getAttribute("href")).toBe("/ideas");
    expect(rows[2]?.textContent).toBe("Ideas");
    expect(rows[3]?.getAttribute("href")).toBe("/goals");
    expect(rows[3]?.textContent).toBe("Goals");
    expect(rows[4]?.getAttribute("href")).toBe("/made");
    expect(rows[4]?.textContent).toBe("Made");
    /*
     * NO PREVIEW AND NO TIME SINCE 2026-10-04. The row carried the last thing said and when — the
     * line a roster of several needs — and with one Bot it was the longest run of words in a column
     * the owner asked to have fewer words in. The server here has a last line and a time to give;
     * the row draws its name, and for whoever cannot see the dot, the word for it.
     */
    const conversation = rows[0];
    expect(conversation?.getAttribute("href")).toBe("/channel/ch-1");
    expect(conversation?.textContent).toBe("ConversationUnread");
    expect(conversation?.querySelector(".tabular-nums")).toBeNull();
    expect(view.column().textContent).not.toContain("3 orders are sorted");
    const dot = conversation?.querySelector('[data-mark="unread"]');
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(classes(dot)).toContain("ml-auto");
    expect(conversation?.querySelector(".sr-only")?.textContent).toBe("Unread");
    // One height for the five: 36px.
    expect(rows.map((row) => classes(row).includes("h-9"))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  test("the Bot's row is its face and its name: no word for what it is doing at rest, and the word when it is the person's turn", async () => {
    /*
     * THE LINE OF STATUS WORDS UNDER THE NAME WENT ON 2026-10-04: 쉬는 중 all day, under a face
     * that says so. It is the dot's name and title now, and the link's. One word is still drawn —
     * 확인 필요, in the amber pill — because that one asks the person for something.
     */
    const view = await roster({ bots: one() });
    const identity = () =>
      view.column().querySelector<HTMLAnchorElement>('a[href^="/agents"]');
    const state = () => identity()?.querySelector("[data-presence]");
    expect(identity()?.textContent).toBe("초롱");
    expect(state()?.getAttribute("data-presence")).toBe("quiet");
    expect(state()?.getAttribute("aria-label")).toBe("Ready");
    expect(state()?.getAttribute("title")).toBe("Ready");
    expect(identity()?.getAttribute("aria-label")).toBe(
      "초롱 · Ready. Bot profile",
    );
    // One row of 44px, the face 32px in it.
    expect(classes(identity())).toContain("h-11");
    expect(identity()?.querySelector("svg")?.getAttribute("width")).toBe("32");

    const { closeQuestion, openQuestion } = await import(
      "../src/lib/approvals"
    );
    const { act } = await import("react");
    await act(async () => {
      openQuestion("call-1", {
        approvalId: "approval-1",
        botId: "bot-1",
        subject: undefined,
        rule: null,
        expiresAt: "",
      });
    });
    try {
      await view.settle();
      expect(identity()?.textContent).toBe("초롱Needs your OK");
      expect(state()?.getAttribute("data-presence")).toBe("attention");
      expect(ko["Needs your OK"]).toBe("확인 필요");
    } finally {
      await act(async () => {
        closeQuestion("call-1");
      });
    }
  });

  test("the foot is one button — the account's picture and the menu's icon — with no name, address or word written out", async () => {
    /*
     * TWO BUTTONS UNTIL 2026-10-06, the picture and 메뉴 side by side, each with a list of its own.
     * The owner, looking for 설정 in the installed app, read them as one thing drawn twice and had
     * them made one.
     */
    const view = await roster({ bots: one() });
    const foot = view.column().querySelector("[data-sidebar-nav]");
    const [menu] = view.footerLinks();
    expect(view.footerLinks()).toHaveLength(1);
    expect(menu?.hasAttribute("data-sidebar-menu")).toBe(true);
    // Nobody's name or address is drawn: the picture's one letter is all the text the foot has.
    expect(foot?.textContent).toBe("김");
    expect(menu?.textContent).toBe("김");
    // The icon beside the picture is drawn, and is nothing a screen reader stops on.
    expect(menu?.querySelectorAll('svg[aria-hidden="true"]').length).toBe(1);
    // What it is and whose, as its name and its title, for a screen reader and for a pointer.
    expect(menu?.getAttribute("aria-label")).toBe(`Menu · ${ACCOUNT}`);
    expect(menu?.getAttribute("title")).toBe(`Menu · ${ACCOUNT}`);
    expect(ACCOUNT).toContain("kim@example.com");
  });

  test("a newer version is one row over that button — the icon alone in the rail — and the foot is the one button again once it is gone", async () => {
    /*
     * WHERE THE APP SAYS IT HAS A NEWER VERSION (2026-10-06, `update-notice.tsx`): in the foot,
     * which is the column's place for what is about the app rather than the Bot, pinned where it
     * cannot scroll out of sight and laid out in the column, so it covers nothing. What the row
     * says and what its press does is `update-notice.test.tsx`; this holds where it stands.
     */
    const watch = await import("../src/lib/build-watch");
    const { act } = await import("react");
    watch.configureBuildWatch({
      bundleRevision: () => "1bf325e4aaaa",
      readBuild: async () => ({ revision: "e9be7221bbbb" }),
      isVisible: () => true,
      storage: () => null,
      lookEveryMs: 3_600_000,
    });
    const stop = watch.watchBuild();
    try {
      const view = await roster({ bots: one() });
      // Until the page has looked there is nothing to say, and the foot is as it always is.
      expect(view.footerLinks()).toHaveLength(1);
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await view.settle();

      const foot = view.column().querySelector("[data-sidebar-nav]");
      const [notice, menu] = view.footerLinks();
      expect(view.footerLinks()).toHaveLength(2);
      expect(
        foot?.querySelector("[data-update-notice]")?.contains(notice ?? null),
      ).toBe(true);
      expect(notice?.textContent).toBe("A new version is hereRefresh");
      expect(menu?.hasAttribute("data-sidebar-menu")).toBe(true);
      // In the foot, so outside the part of the column that scrolls.
      expect(notice?.closest(".overflow-y-auto")).toBeNull();

      // The rail has no room for the words: the icon, named by them.
      await view.resizeTo(false);
      const [icon] = view.footerLinks();
      expect(view.footerLinks()).toHaveLength(2);
      expect(icon?.textContent).toBe("");
      expect(icon?.getAttribute("aria-label")).toBe(
        "A new version is here · Refresh",
      );

      // What was known is forgotten, as it is on the page a reload brings, and the row is gone.
      await act(async () => {
        watch.configureBuildWatch(null);
      });
      await view.settle();
      expect(view.footerLinks()).toHaveLength(1);
      expect(foot?.querySelector("[data-update-notice]")).toBeNull();
    } finally {
      stop();
      watch.configureBuildWatch(null);
    }
  });

  test("and under those rows nothing: the column does not list the Bot's day, or ask for it", async () => {
    /*
     * 오늘 — 기다리는 일, 한 일, 다음 — STOOD UNDER THESE ROWS UNTIL 2026-10-04, and the owner had it
     * removed outright: too much text on the screen. The day is on 소식, a row away. The server here
     * has a day with work in it and a routine to come, so a list put back has something to draw.
     */
    const view = await roster({ bots: one() });
    expect(view.width()).toBe("w-sidebar");
    const text = view.column().textContent ?? "";
    expect(
      ["Today", "What it did", "Up next", DONE_TODAY, COMING_NEXT].filter(
        (words) => text.includes(words),
      ),
    ).toEqual([]);
    // The list's own element, whatever its words: nothing else in the column is a section. Counted,
    // because an element handed to `expect` is printed whole when it fails, and that took minutes.
    expect(view.column().querySelectorAll("section").length).toBe(0);
    // Not read and left undrawn, either: the column asks for what it draws and not for the day.
    expect(asked).toContain("/api/channels");
    expect(asked).not.toContain("/api/agents/bot-1/day");
  });

  test("the nav has no second way to the profile, and is pinned below the part that scrolls", async () => {
    const view = await roster({ bots: one() });
    /*
     * ONE 메뉴 CONTROL (muse-shape plan §4, settled with phase 9): with 목표 the fourth row above it,
     * the phase-5 footer of 수첩 · 루틴 · 연결 · 더 보기 cut the first row of 오늘, which the column
     * listed under its rows then, at 1024×640 (measured: footer from 420, the row to 426). 오늘 has
     * left the column since (2026-10-04), 메뉴 became an icon beside the account's picture the same
     * day and one button with it on 2026-10-06, and the places stayed folded. Every place is one
     * press under it, the same list as the 메뉴 page.
     */
    expect(
      view.footerLinks().map((link) => link.getAttribute("aria-label")),
    ).toEqual([`Menu · ${ACCOUNT}`]);
    const nav0 = view.column().querySelector("[data-sidebar-nav]");
    expect(nav0?.querySelectorAll("a")).toHaveLength(0);
    /*
     * OUT OF THE SCROLLING PART, PINNED ABOVE THE ACCOUNT. At the PC app's smallest window (1024×640)
     * 오늘, in the column then, pushed 루틴, 스킬, 연결 and 도움말 below the fold when they scrolled
     * with it (UX review 0.5.4, item 4). The Bot and the rows under it scroll; the links do not.
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

describe("on a phone there is no sheet", () => {
  test("the column is only the column: no menu button's sheet, no way to close one", async () => {
    /*
     * Retired 2026-09-27 for the phone's bottom bar (`phone-tab-bar.tsx`, muse-shape plan phase 3).
     * The column is still mounted below `md` — its watch on the working poll refreshes the unread
     * mark — and hidden there by its own class, the only phone class it has left.
     */
    const view = await roster({ wide: false });
    const column = classes(view.column());
    expect(column.filter((cls) => cls.startsWith("max-md:"))).toEqual([
      "max-md:hidden",
    ]);
    expect(
      view.host.querySelectorAll('button[aria-label="Close the menu"]'),
    ).toHaveLength(0);
    expect(ko["Open the menu"]).toBeUndefined();
    expect(ko["Close the menu"]).toBeUndefined();
  });
});

/**
 * WHAT THE FOOT'S BUTTON OPENS, read off a list that really opened.
 *
 * The button has no word beside it, so the list is the whole of what it says — and a popup renders
 * nothing in this process (see the top of the file). The column is mounted in a process of its
 * own, in Korean, and the button is pressed there.
 */
let footRendering: Promise<FootShown> | undefined;

function footRendered(): Promise<FootShown> {
  footRendering ??= renderFoot();
  return footRendering;
}

async function renderFoot(): Promise<FootShown> {
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "support/sidebar-foot-render.tsx")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("SIDEBAR_FOOT "));
  if (status !== 0 || !line) {
    throw new Error(
      `the foot's render did not finish (exit ${status}):\n${stderr.slice(-3000)}`,
    );
  }
  return JSON.parse(line.slice("SIDEBAR_FOOT ".length)) as FootShown;
}

describe("what the foot's one button opens", () => {
  test("it is named 메뉴 and for whom, and draws no word: the picture's one letter is all its text", async () => {
    const { foot } = await footRendered();
    expect(foot.text).toBe("김");
    expect(foot.menu).toEqual({
      label: "메뉴 · 김기범 · kim@example.com",
      title: "메뉴 · 김기범 · kim@example.com",
      text: "김",
    });
  }, 120_000);

  test("one list: stopping first, then the places the 메뉴 page draws, then the account's, and leaving last", async () => {
    const { items } = await footRendered();
    expect(items.map(([name]) => name)).toEqual([
      "모두 멈추기",
      "수첩",
      "루틴",
      "스킬",
      "연결",
      "도움말",
      "설정",
      "로그아웃",
    ]);
    // The places are the same list, in the same order, to the same addresses as the 메뉴 page's.
    expect(items.slice(1, 6)).toEqual(
      footerLinksFor(false).map((link) => [ko[link.label] ?? "", link.to]),
    );
    // What goes somewhere says where; what does something here has no address.
    expect(items[0]).toEqual(["모두 멈추기", null]);
    expect(items[6]).toEqual(["설정", "/settings"]);
    expect(items[7]).toEqual(["로그아웃", null]);
  }, 120_000);
});
