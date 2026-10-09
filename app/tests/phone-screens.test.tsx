import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { pageAt } from "../src/components/layout/phone-pager";
import { forgetHomePanel } from "../src/lib/home-panel";
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

/**
 * A PHONE'S WAY AROUND SINCE ITS BAR WENT (2026-10-09, `docs/laf/redesign-2026-10.md` §1 모바일): TWO
 * PAGES SWIPED BETWEEN — 홈, THEN THE SCREEN — UNDER THE ROW AT THE TOP.
 *
 * Below `md` there was a bar of six labelled tabs at the bottom, each a route, and a 메뉴 page for
 * everything that changes how the Bot works (2026-09-27). The record replaces both: the home panel
 * and the screen are two pages of one scroller, 홈 | 채팅 in the row says which is in front, and
 * the places are the same list a PC opens from the profile button.
 *
 * WHAT CAN BE HELD HERE AND WHAT CANNOT. happy-dom lays nothing out, so a swipe, the snap and the
 * widths are measured in a browser and written in the pull request. What is held here is what
 * decides them: the two pages and their order, that the tabs move the scroller and never the
 * address, that going anywhere brings the screen back in front, and the rule for which page a
 * scroller stands on.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
  localStorage.clear();
  forgetHomePanel();
});
afterAll(async () => {
  await removeAppDom();
});

const NOW = "2026-09-27T03:00:00.000Z";

/** An account with its one Bot, 초롱, a conversation, and a day with nothing in it yet. */
const oneBot = ({ pathname }: { pathname: string }) => {
  if (pathname === "/api/agents") {
    return json({ agents: [agentFixture({ id: "bot-1", name: "초롱" })] });
  }
  if (pathname === "/api/channels") {
    return json({
      channels: [
        {
          id: "c-1",
          name: "초롱",
          agentIds: ["bot-1"],
          threadId: "thread-c-1",
          active: true,
          lastMessage: "다 했어요",
          lastMessageAt: NOW,
          lastMessageAgentId: "bot-1",
          unread: false,
          createdAt: NOW,
        },
      ],
    });
  }
  if (pathname === "/api/agents/bot-1/day") {
    return json({
      day: "2026-09-27",
      zone: "Asia/Seoul",
      items: [],
      more: false,
    });
  }
  if (pathname === "/api/routines") return json({ routines: [] });
  if (pathname === "/api/feed") {
    return json({ posts: [], next: null, unseen: 0, routines: [] });
  }
  return undefined;
};

type View = Awaited<ReturnType<typeof mountApp>>;

const pager = (view: View) =>
  view.host.querySelector("[data-phone-pager]") as HTMLElement | null;
const tabs = (view: View) =>
  [
    ...view.host.querySelectorAll<HTMLButtonElement>(
      "[data-phone-tabs] [role=tab]",
    ),
  ].map((tab) => ({
    words: tab.textContent,
    isInFront: tab.getAttribute("aria-selected") === "true",
    press: tab,
  }));
const inFront = (view: View) =>
  tabs(view)
    .filter((tab) => tab.isInFront)
    .map((tab) => tab.words);

describe("a phone's screens", () => {
  test("are two pages of one scroller — 홈, then the screen — with no bar at the bottom and no 메뉴 page", async () => {
    const view = await mountApp({ path: "/help", api: oneBot });
    await view.waitFor(() => pager(view) !== null, "the pager");

    const pages = [...(pager(view)?.children ?? [])];
    expect(pages.map((page) => page.tagName)).toEqual(["ASIDE", "MAIN"]);
    expect(pages[0]?.hasAttribute("data-home-panel")).toBe(true);
    expect(pages[1]?.id).toBe("main");
    // Each is a page of the scroller on a phone, and stops being one where there is room beside.
    for (const page of pages) {
      expect(page.className).toContain("max-md:snap-start");
      expect(page.className).toContain("max-md:w-full");
    }
    // A scroller only on a phone: on a PC its children are the layout's own.
    expect(pager(view)?.className).toContain("md:contents");
    expect(pager(view)?.className).toContain("snap-mandatory");

    // The bar and the page it led to are gone; the places are the profile button's list.
    expect(view.host.querySelector("[data-phone-tab-bar]")).toBeNull();
    expect(view.host.querySelector('a[href="/menu"]')).toBeNull();
    expect(Object.keys(view.router.routesByPath)).not.toContain("/menu");
    expect(
      view.host.querySelector("[data-app-header] [data-profile-menu]"),
    ).not.toBeNull();
  });

  test("홈 | 채팅 is in the row: 채팅 in front at first, a press moves the scroller and never the address, and going anywhere brings the screen back", async () => {
    const view = await mountApp({ path: "/help", api: oneBot });
    await view.waitFor(() => tabs(view).length === 2, "the two tabs");
    expect(tabs(view).map((tab) => tab.words)).toEqual(["Home", "Chat"]);
    expect(inFront(view)).toEqual(["Chat"]);
    expect(ko.Home).toBe("홈");
    expect(ko.Chat).toBe("채팅");

    // What the tabs ask of the scroller, written down instead of carried out: nothing is laid out.
    const asked: ScrollToOptions[] = [];
    const scroller = pager(view) as HTMLElement;
    scroller.scrollTo = ((options: ScrollToOptions) => {
      asked.push(options);
    }) as typeof scroller.scrollTo;

    const [home] = tabs(view);
    await view.click(home?.press as HTMLButtonElement);
    expect(inFront(view)).toEqual(["Home"]);
    // To the left edge, and with no behaviour named: the scroller's own smoothness decides.
    expect(asked).toEqual([{ left: 0 }]);
    // A page is not a place: the address is where it was.
    expect(view.router.state.location.pathname).toBe("/help");

    // Going somewhere is going to the screen — at once, not slid to.
    await view.navigate("/skills");
    await view.waitFor(
      () => inFront(view)[0] === "Chat",
      "the screen to be in front again",
    );
    expect(asked.at(-1)).toEqual({ left: 0, behavior: "instant" });
  });

  test.each([
    { scrollLeft: 0, width: 375, page: "home" },
    { scrollLeft: 187, width: 375, page: "home" },
    { scrollLeft: 188, width: 375, page: "chat" },
    { scrollLeft: 375, width: 375, page: "chat" },
    // Where nothing is laid out — a PC, where the scroller is no box at all — it is the screen.
    { scrollLeft: 0, width: 0, page: "chat" },
  ] as const)(
    "a scroller $width wide at $scrollLeft stands on $page",
    ({ scrollLeft, width, page }) => {
      expect(pageAt(scrollLeft, width)).toBe(page);
    },
  );

  test("a keyboard is up when something that takes typing has the focus AND the visual viewport is shorter by more than a toolbar", async () => {
    /*
     * The pager holds still while this says so. The composer takes the caret when a conversation
     * opens, and on a phone that raises no keyboard: a rule of "something has the focus" would
     * have stopped the swipe on every visit to the conversation.
     */
    const { isKeyboardUp } = await import("../src/lib/use-keyboard-up");
    const box = document.createElement("textarea");
    document.body.append(box);
    box.focus();
    const viewport = { height: window.innerHeight, scale: 1 };
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        get height() {
          return viewport.height;
        },
        get scale() {
          return viewport.scale;
        },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    // Focused, no keyboard.
    expect(isKeyboardUp()).toBe(false);
    // The keyboard takes 300px of the visual viewport.
    viewport.height = window.innerHeight - 300;
    expect(isKeyboardUp()).toBe(true);
    // Pinched to twice the size is not a keyboard.
    viewport.height = window.innerHeight / 2;
    viewport.scale = 2;
    expect(isKeyboardUp()).toBe(false);
    // A keyboard-sized viewport with nothing to type in is not one either.
    viewport.height = window.innerHeight - 300;
    viewport.scale = 1;
    box.blur();
    expect(isKeyboardUp()).toBe(false);
    box.remove();
    Reflect.deleteProperty(window, "visualViewport");
  });
});

describe("소식", () => {
  test("오늘 as a page, and a line rather than a blank screen when there is nothing yet", async () => {
    const view = await mountApp({ path: "/feed", api: oneBot });
    await view.waitFor(
      () => view.main()?.querySelector("h1")?.textContent === "Updates",
      "소식",
    );
    await view.waitFor(
      () =>
        (view.main()?.textContent ?? "").includes(
          "Nothing yet today. What you hand over in the conversation shows up here.",
        ),
      "the line for a day with nothing in it",
    );
    expect(
      ko[
        "Nothing yet today. What you hand over in the conversation shows up here."
      ],
    ).toBeString();
    // The title stands alone since 2026-10-04: no sentence under it (`everyday-screens.test.tsx`).
    expect(view.main()?.querySelectorAll("header p")).toHaveLength(0);
    // Before there is a 소식 routine: what would come here, and the one press (plan D3).
    expect(view.main()?.querySelector("[data-feed-make]")).not.toBeNull();
    expect(view.main()?.querySelector("[data-feed-start]")?.textContent).toBe(
      "Get updates every morning",
    );
    expect(ko["Get updates every morning"]).toBe("매일 아침 소식 받기");
  });
});
