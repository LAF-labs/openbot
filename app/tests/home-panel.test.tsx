import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
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

/**
 * THE HOME PANEL'S FRAME (2026-10-10, `docs/laf/redesign-2026-10.md` §1, piece 3-2): a column at
 * the left of the window that a person folds away with the home button and drags wider by its
 * edge, beside the one top row (`app-top-bar.tsx`) and the screen under it.
 *
 * What is held here is what a green gate would not otherwise notice going: that there is always
 * exactly one home button and it is at the window's top left whichever way the panel is; that
 * nothing is stored for a person who changed nothing; and that a width asked for is held between
 * the two bounds the record gives, in the store as it is in the stylesheet.
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

/** An account with its one Bot, 초롱, and the conversation it has had. */
const oneBot = ({ pathname }: { pathname: string }) => {
  if (pathname === "/api/agents") {
    return json({ agents: [agentFixture({ id: "bot-1", name: "초롱" })] });
  }
  if (pathname === "/api/channels") {
    return json({
      channels: [
        {
          id: "c-1",
          name: "bot-1",
          agentIds: ["bot-1"],
          threadId: "thread-c-1",
          active: true,
          lastMessage: "…",
          lastMessageAt: "2026-09-20T00:00:00Z",
          lastMessageAgentId: "bot-1",
          unread: false,
          createdAt: "2026-09-20T00:00:00Z",
        },
      ],
    });
  }
  return undefined;
};

type View = Awaited<ReturnType<typeof mountApp>>;

const row = (view: View) =>
  view.host.querySelector("[data-app-top-bar]") as HTMLElement | null;
const panel = (view: View) =>
  view.host.querySelector("[data-home-panel]") as HTMLElement | null;
const homeButtons = (view: View) => [
  ...view.host.querySelectorAll<HTMLButtonElement>("[data-home-button]"),
];

describe("the home panel", () => {
  test("is open at first with the home button in its own first row; folded away it is gone, and the button is the first thing in the top row", async () => {
    const view = await mountApp({ path: "/help", api: oneBot });
    await view.waitFor(() => panel(view) !== null, "the home panel");

    // One button, wherever it is: two would be two things answering to one name.
    expect(homeButtons(view)).toHaveLength(1);
    const [open] = homeButtons(view);
    expect(panel(view)?.contains(open as Node)).toBe(true);
    expect(open?.getAttribute("aria-expanded")).toBe("true");
    expect(open?.getAttribute("aria-label")).toBe("Close the home panel");
    // The panel comes before the row in the document, as it does for the eye and the Tab key.
    expect(
      (panel(view) as HTMLElement).compareDocumentPosition(
        row(view) as HTMLElement,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Nothing is stored for a person who has changed nothing.
    expect(localStorage.getItem("laf.home-panel")).toBeNull();

    await view.click(open as HTMLButtonElement);
    await view.waitFor(() => panel(view) === null, "the panel to fold away");
    // The same button, at the same corner of the window, now in the row — and first in it.
    expect(homeButtons(view)).toHaveLength(1);
    const [folded] = homeButtons(view);
    expect(row(view)?.firstElementChild).toBe(folded as Element);
    expect(folded?.getAttribute("aria-expanded")).toBe("false");
    expect(folded?.getAttribute("aria-label")).toBe("Open the home panel");
    expect(parseHomePanel(localStorage.getItem("laf.home-panel"))).toEqual({
      isOpen: false,
      width: null,
    });

    await view.click(folded as HTMLButtonElement);
    await view.waitFor(() => panel(view) !== null, "the panel to come back");
    expect(homeButtons(view)).toHaveLength(1);
    expect(ko["Open the home panel"]).toBe("홈 패널 펴기");
    expect(ko["Close the home panel"]).toBe("홈 패널 접기");
  });

  test("stays folded for the next window on this device", async () => {
    localStorage.setItem(
      "laf.home-panel",
      JSON.stringify({ isOpen: false, width: 320 }),
    );
    forgetHomePanel();
    const view = await mountApp({ path: "/help", api: oneBot });
    await view.waitFor(() => homeButtons(view).length === 1, "the button");
    expect(panel(view)).toBeNull();
    expect(row(view)?.contains(homeButtons(view)[0] as Node)).toBe(true);
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
