import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { join } from "node:path";
import { FOOTER_LINKS } from "../src/components/app-sidebar/places";
import {
  clampHomePanelWidth,
  DEFAULT_HOME_PANEL,
  forgetHomePanel,
  parseHomePanel,
} from "../src/lib/home-panel";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import type { ProfileMenuShown } from "./support/profile-menu-render";

/**
 * THE FRAME SINCE THE SIDEBAR WENT (2026-10-09, `docs/laf/redesign-2026-10.md` §1): A HOME PANEL AT
 * THE LEFT, AND A ROW ACROSS THE TOP OF THE SCREEN BESIDE IT.
 *
 * The sidebar was a column of the Bot and its places. What it did is in three places now, and each
 * is held here:
 *
 *  - WHO THE BOT IS AND WHAT IT IS DOING is not drawn in the row (the user, 2026-10-09: its left
 *    is empty, as Hark's is). It is still said there to a screen reader, on every screen — by the
 *    conversation on its own, by `bot-state.tsx` on every other.
 *  - WHERE A PERSON GOES is one list under the profile button at the right (`profile-menu.tsx`),
 *    with 채팅 | 프로젝트 in the middle of the row (`view-switcher.tsx`).
 *  - THE LEFT OF THE WINDOW is the home panel, which a person folds away and drags wider
 *    (`home-panel.tsx`), and whose width is theirs on this device.
 *
 * What the profile button opens is read from a process of its own (`profile-menu-render.tsx` says
 * why), in Korean, which is the only language a person reads it in.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
  // The panel's state is held in its module as well as in storage: neither is left for the next
  // test, or for whichever file shares this process.
  localStorage.clear();
  forgetHomePanel();
});
afterAll(async () => {
  await removeAppDom();
});

const conversation = (id: string, agentId: string, at: string) => ({
  id,
  name: agentId,
  agentIds: [agentId],
  threadId: `thread-${id}`,
  active: true,
  lastMessage: "…",
  lastMessageAt: at,
  lastMessageAgentId: agentId,
  unread: false,
  createdAt: at,
});

/** An account with its one Bot, 초롱, and the conversation it has had. */
const oneBot = ({ pathname }: { pathname: string }) => {
  if (pathname === "/api/agents") {
    return json({ agents: [agentFixture({ id: "bot-1", name: "초롱" })] });
  }
  if (pathname === "/api/channels") {
    return json({
      channels: [conversation("c-1", "bot-1", "2026-09-20T00:00:00Z")],
    });
  }
  return undefined;
};

type View = Awaited<ReturnType<typeof mountApp>>;

const row = (view: View) =>
  view.host.querySelector("[data-app-header]") as HTMLElement | null;
const panel = (view: View) =>
  view.host.querySelector("[data-home-panel]") as HTMLElement | null;
const homeButton = (view: View) =>
  view.host.querySelector("[data-home-button]") as HTMLButtonElement | null;
const botState = (view: View) =>
  view.host.querySelector("[data-bot-state]") as HTMLElement | null;
const switcher = (view: View) =>
  [...view.host.querySelectorAll("[data-view-switcher] a")].map((link) => ({
    to: link.getAttribute("href"),
    words: link.textContent,
    isHere: link.getAttribute("aria-current") === "page",
  }));
describe("the row at the top", () => {
  test("draws the switcher and the menu's button and nothing at its left — the Bot's name and state are there for a screen reader only", async () => {
    const view = await mountApp({ path: "/help", api: oneBot });
    await view.waitFor(() => botState(view) !== null, "the Bot's state");

    // Not drawn, and still said: the name, the state, and the state's word by itself.
    expect(botState(view)?.className).toContain("sr-only");
    expect(botState(view)?.textContent?.startsWith("초롱 · ")).toBe(true);
    expect(botState(view)?.getAttribute("data-bot-state")).toBe(
      botState(view)?.textContent?.slice("초롱 · ".length),
    );
    // Nothing a person could press stands where the name stood.
    expect(row(view)?.querySelector("[data-bot-mark]")).toBeNull();
    expect(
      row(view)?.querySelector('[data-header-slot="leading"]')?.children,
    ).toHaveLength(0);

    // 채팅 | 프로젝트, and on 도움말 neither is where the person is.
    expect(switcher(view)).toEqual([
      { to: "/", words: "Chat", isHere: false },
      { to: "/projects", words: "Projects", isHere: false },
    ]);

    // Every other place is one press away, under the person's own picture: the button is named
    // for what it opens and for whom, and no word of that is written out in the row.
    const menu = row(view)?.querySelector("[data-profile-menu]");
    expect(menu?.getAttribute("aria-label")?.startsWith("Menu · ")).toBe(true);
    const text = row(view)?.textContent ?? "";
    expect(text).not.toContain("Menu");
    expect(text).not.toContain("Your Bots");

    // The roster's own furniture stayed gone: no search, no way to start another conversation.
    expect(view.host.querySelector('input[type="search"]')).toBeNull();
    expect(
      view.host.querySelector('[aria-label="Start a new channel"]'),
    ).toBeNull();
    // And search is not drawn before there is anything it could find.
    expect(row(view)?.querySelector('[aria-label="Search"]')).toBeNull();
  });
});

describe("채팅 | 프로젝트", () => {
  test("says which of the two a person is on, and the projects' screen offers nothing it cannot do yet", async () => {
    const view = await mountApp({ path: "/projects", api: oneBot });
    await view.waitFor(
      () => (view.main()?.textContent ?? "").includes("Projects"),
      "the projects' screen",
    );
    expect(switcher(view).map((half) => half.isHere)).toEqual([false, true]);
    expect(view.main()?.textContent).toContain("Projects cannot be made yet.");
    expect(view.main()?.querySelectorAll("button")).toHaveLength(0);
    // A PC's control: a phone has 홈 | 채팅 in the same place.
    expect(
      view.host.querySelector("[data-view-switcher]")?.className,
    ).toContain("max-md:hidden");
    expect(ko.Chat).toBe("채팅");
    expect(ko.Projects).toBe("프로젝트");
    expect(ko["Projects cannot be made yet."]).toBe(
      "아직 프로젝트를 만들 수 없어요.",
    );
  });
});

describe("the home panel", () => {
  test("is open at first with the home button in its own first row; folded away it is gone, and the button is in the row at the top", async () => {
    const view = await mountApp({ path: "/help", api: oneBot });
    await view.waitFor(() => panel(view) !== null, "the home panel");

    expect(panel(view)?.contains(homeButton(view))).toBe(true);
    expect(homeButton(view)?.getAttribute("aria-expanded")).toBe("true");
    expect(homeButton(view)?.getAttribute("aria-label")).toBe(
      "Close the home panel",
    );
    // Nothing is stored for a person who has changed nothing.
    expect(localStorage.getItem("laf.home-panel")).toBeNull();

    await view.click(homeButton(view) as HTMLButtonElement);
    await view.waitFor(() => panel(view) === null, "the panel to fold away");
    // The same button, at the same corner of the window, now in the row.
    expect(row(view)?.contains(homeButton(view))).toBe(true);
    expect(homeButton(view)?.getAttribute("aria-expanded")).toBe("false");
    expect(homeButton(view)?.getAttribute("aria-label")).toBe(
      "Open the home panel",
    );
    expect(parseHomePanel(localStorage.getItem("laf.home-panel"))).toEqual({
      isOpen: false,
      width: null,
    });

    await view.click(homeButton(view) as HTMLButtonElement);
    await view.waitFor(() => panel(view) !== null, "the panel to come back");
    expect(ko["Open the home panel"]).toBe("홈 패널 펴기");
    expect(ko["Close the home panel"]).toBe("홈 패널 접기");
  });

  test("its edge is a separator a person can focus and step, and the width it stores is held to the window", async () => {
    const view = await mountApp({ path: "/help", api: oneBot });
    await view.waitFor(() => panel(view) !== null, "the home panel");
    const edge = view.host.querySelector(
      "[data-home-panel-edge]",
    ) as HTMLElement;
    expect(edge.getAttribute("role")).toBe("separator");
    expect(edge.getAttribute("aria-orientation")).toBe("vertical");
    expect(edge.tabIndex).toBe(0);
    // The chosen width goes down as a custom property for the stylesheet to hold, never as a width.
    expect(panel(view)?.style.width).toBe("");

    const { act } = await import("react");
    await act(async () => {
      edge.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    // happy-dom lays nothing out, so the panel measures 0 and one step asks for 16px — which no
    // window allows: what is stored is the least this window does.
    const stored = parseHomePanel(localStorage.getItem("laf.home-panel"));
    expect(stored.isOpen).toBe(true);
    expect(stored.width).toBe(clampHomePanelWidth(16, window.innerWidth));
    expect(panel(view)?.style.getPropertyValue("--home-panel-chosen")).toBe(
      `${stored.width}px`,
    );
  });

  test.each([
    // The PC app's smallest window: never under 280, and the screen beside it keeps 360.
    { asked: 100, window: 1024, held: 280 },
    { asked: 500, window: 1024, held: 500 },
    { asked: 2000, window: 1024, held: 664 },
    // A wide one: a fifth of the window at least, seven tenths at most.
    { asked: 100, window: 1920, held: 384 },
    { asked: 900, window: 1920, held: 900 },
    { asked: 5000, window: 1920, held: 1344 },
  ])(
    "a width of $asked in a $window window is held at $held",
    ({ asked, window: width, held }) => {
      expect(clampHomePanelWidth(asked, width)).toBe(held);
    },
  );

  test.each([
    { stored: null, read: DEFAULT_HOME_PANEL },
    { stored: "", read: DEFAULT_HOME_PANEL },
    { stored: "not json", read: DEFAULT_HOME_PANEL },
    { stored: "null", read: DEFAULT_HOME_PANEL },
    { stored: '{"isOpen":"yes","width":-40}', read: DEFAULT_HOME_PANEL },
    {
      stored: '{"isOpen":false,"width":320}',
      read: { isOpen: false, width: 320 },
    },
  ])(
    "what was stored as $stored is read as a panel that can be drawn",
    ({ stored, read }) => {
      expect(parseHomePanel(stored)).toEqual(read);
    },
  );
});

/** What the row draws and what its profile button opens, in Korean, from a process of its own. */
async function rendered(scenario?: "several"): Promise<ProfileMenuShown> {
  const script = join(import.meta.dir, "support/profile-menu-render.tsx");
  const child = Bun.spawn(["bun", script, ...(scenario ? [scenario] : [])], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("PROFILE_MENU "));
  if (status !== 0 || !line) {
    throw new Error(
      `the profile menu did not render (exit ${status}):\n${stderr.slice(-2000)}`,
    );
  }
  return JSON.parse(line.slice("PROFILE_MENU ".length)) as ProfileMenuShown;
}

/** The places that change how the Bot works, as the menu and the phone's 메뉴 page both list them. */
const PLACES = FOOTER_LINKS.map(({ label, to }): [string, string | null] => [
  ko[label],
  to,
]);

describe("what the profile button opens", () => {
  /*
   * A cold `bun` and a route tree are seconds of CPU when every core is busy with the rest of the
   * gate, so each of these carries its own time (CLAUDE.md, "The gate runs on four workers").
   */
  test("one list: stopping first, then where a person goes to look, then the places, then the account's, and leaving last", async () => {
    const shown = await rendered();
    expect(shown.row.menu.label).toBe("메뉴 · 김기범 · kim@example.com");
    expect(shown.row.menu.title).toBe(shown.row.menu.label);
    // The button draws no word: the picture's one letter is all its text.
    expect(shown.row.menu.text).toBe("김");
    // The row's one line for a screen reader; nothing of it is drawn.
    expect(shown.state).toEqual({ line: "초롱 · 쉬는 중", word: "쉬는 중" });
    expect(shown.items).toEqual([
      ["모두 멈추기", null],
      // Nothing has been said to this Bot yet, so 대화 opens the screen that starts it.
      ["대화", "/channel/new?agent=bot-1"],
      ["소식", "/feed"],
      ["아이디어", "/ideas"],
      ["목표", "/goals"],
      ["만든 것", "/made"],
      ...PLACES,
      ["설정", "/settings"],
      ["로그아웃", null],
    ]);
    // 봇 프로필 is a row for everybody here: the face that led to it went with the column.
    expect(shown.items).toContainEqual(["봇 프로필", "/agents"]);
  }, 120_000);

  test("on an account from before, 내 봇들 lists every Bot it has — a hidden one too — each opening its own conversation, and there is no 대화 row", async () => {
    const shown = await rendered("several");
    expect(shown.items.slice(0, 4)).toEqual([
      ["모두 멈추기", null],
      ["초롱", "/channel/c-1"],
      ["두리", "/channel/c-2"],
      // Nobody has spoken to the hidden one: its row opens the empty conversation, by its id.
      ["세모", "/channel/new?agent=bot-3"],
    ]);
    expect(shown.items.map(([name]) => name)).not.toContain("대화");
    expect(shown.items.slice(4)).toEqual([
      ["소식", "/feed"],
      ["아이디어", "/ideas"],
      ["목표", "/goals"],
      ["만든 것", "/made"],
      ...PLACES,
      ["설정", "/settings"],
      ["로그아웃", null],
    ]);
    expect(ko["Your Bots"]).toBe("내 봇들");
  }, 120_000);
});
