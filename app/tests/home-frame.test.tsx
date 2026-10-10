import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
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
import { acted } from "./support/turn-server";

/*
 * 홈, THE PANEL AT THE LEFT OF THE WINDOW, IN THE APP'S OWN FRAME (2026-10-10,
 * `docs/laf/redesign-2026-10.md` §1, piece 3-2).
 *
 * `home-panel.test.ts` has the arithmetic. This is the frame around it, mounted as the app mounts
 * it: that the panel stands beside the screen and under the row; that the button in the row folds
 * it and a reload finds it folded; that its edge is moved by a hand and by a keyboard; that it
 * gives way to a pane opened beside the screen; and that 소식 does not draw 오늘 a second time
 * beside it.
 *
 * THE WINDOW HERE IS 1024 WIDE — the test document's own, and exactly the installed app's floor,
 * which is the window every limit in this piece was written for. What the frame looks like at
 * that size and at 1280 was measured in the running app (the pull request has the numbers); a
 * test document lays nothing out, so widths here are read from the one CSS variable the frame is
 * laid out by, and from the store.
 */

type View = Awaited<ReturnType<typeof mountApp>>;

const STORAGE_KEY = "laf.home-panel";

const home = () => import("../src/lib/home/home-panel");

beforeAll(async () => {
  await installAppDom();
}, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
  // What one test folded or dragged is not what the next one starts from: the next app mounted
  // reads the storage again (`support/app-router.tsx`), so the storage is what is cleared.
  localStorage.removeItem(STORAGE_KEY);
});
setDefaultTimeout(20_000);
afterAll(removeAppDom);

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
  if (pathname === "/api/agents/bot-1/day") {
    return json({ zone: "Asia/Seoul", items: [] });
  }
  if (pathname === "/api/routines") return json({ routines: [] });
  return undefined;
};

const frame = (view: View) =>
  view.host.querySelector("[data-home-frame]") as HTMLElement;
const panel = (view: View) =>
  view.host.querySelector("[data-home-panel]") as HTMLElement;
const button = (view: View) =>
  view.host.querySelector("[data-home-button]") as HTMLButtonElement;
const edge = (view: View) =>
  view.host.querySelector("[data-home-edge]") as HTMLElement;
/** How wide the frame lays 홈 out: the one number the panel and the row's first cell both read. */
const drawn = (view: View) =>
  frame(view).style.getPropertyValue("--home-panel-width");

const mounted = async (path = "/help") => {
  const view = await mountApp({ path, api: oneBot });
  await view.waitFor(
    () => view.host.querySelectorAll("[data-home-panel]").length === 1,
    "홈",
  );
  return view;
};

/** One key on the edge, as the keyboard sends it. */
const key = (view: View, name: string, shiftKey = false) =>
  acted(() => {
    edge(view).dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: name,
        shiftKey,
      }),
    );
  });

/** One pointer event on the edge. A `MouseEvent` under the pointer's name: what React listens for. */
const pointer = (
  view: View,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  mouseButton = 0,
) =>
  acted(() => {
    const event = new MouseEvent(type, {
      bubbles: true,
      button: mouseButton,
      cancelable: true,
      clientX,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    edge(view).dispatchEvent(event);
  });

describe("홈, the panel at the left of the window", () => {
  test("stands beside the screen and under the row: a named region holding 오늘, at its least in the PC app's smallest window", async () => {
    const view = await mounted();
    await view.waitFor(
      () => (panel(view).textContent ?? "").includes("Nothing yet today"),
      "오늘 in 홈",
    );
    expect(panel(view).tagName).toBe("ASIDE");
    expect(panel(view).getAttribute("aria-label")).toBe("Home");
    expect(panel(view).dataset.homePanel).toBe("open");
    expect(panel(view).inert).toBe(false);
    // A fifth of 1024 is 205: the least holds.
    expect(drawn(view)).toBe("280px");
    // And what is in it is never laid out narrower than that least, so a fold does not squeeze it.
    const { HOME_PANEL_MIN } = await home();
    expect(
      panel(view).querySelector("[data-home-content]")?.className,
    ).toContain(`min-w-[${HOME_PANEL_MIN}px]`);
    // Beside the screen — the same row holds both — and not in the row at the top.
    expect(panel(view).parentElement).toBe(view.main()?.parentElement ?? null);
    expect(
      view.host
        .querySelector("[data-app-top-bar]")
        ?.querySelectorAll("[data-home-panel]").length,
    ).toBe(0);
    // What it holds today: the Bot's day, under its one heading.
    expect(
      [...panel(view).querySelectorAll("h2")].map((h) => h.textContent),
    ).toEqual(["Today"]);
    expect(ko.Home).toBe("홈");
    expect(ko.Today).toBe("오늘");
  });

  test("the home button in the row folds it and brings it back, and the fold is what a reload finds", async () => {
    const { readHomePanel, forgetHomePanel } = await home();
    const view = await mounted();
    expect(button(view).getAttribute("aria-label")).toBe("Fold Home");
    expect(button(view).getAttribute("aria-expanded")).toBe("true");
    expect(button(view).getAttribute("aria-controls")).toBe(panel(view).id);

    await view.click(button(view));
    expect(drawn(view)).toBe("0px");
    // Zero pixels of markup that is still there: nothing in it is reachable.
    expect(panel(view).inert).toBe(true);
    expect(panel(view).dataset.homePanel).toBe("folded");
    expect(button(view).getAttribute("aria-label")).toBe("Open Home");
    expect(button(view).getAttribute("aria-expanded")).toBe("false");
    expect(readHomePanel()).toEqual({ isOpen: false, width: null });

    // A reload: the window is gone, and what was kept is all there is.
    await view.unmount();
    forgetHomePanel();
    const again = await mounted();
    expect(drawn(again)).toBe("0px");
    expect(button(again).getAttribute("aria-label")).toBe("Open Home");

    await again.click(button(again));
    expect(drawn(again)).toBe("280px");
    expect(panel(again).inert).toBe(false);
    expect([ko["Fold Home"], ko["Open Home"]]).toEqual([
      "홈 접기",
      "홈 펼치기",
    ]);
  });

  test("the row's first cell holds the button, is as wide as the panel, and is itself the window's handle", async () => {
    const view = await mounted();
    const row = view.host.querySelector("[data-app-top-bar]") as HTMLElement;
    const cell = row.querySelector("[data-top-bar-home]") as HTMLElement;
    expect(row.firstElementChild).toBe(cell);
    // Tauri drags only from an element that carries the attribute itself.
    expect(cell.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(cell.querySelectorAll("[data-home-button]").length).toBe(1);
    // The panel's width less the row's own gap, so what a screen draws into the row starts where
    // that screen does.
    expect(cell.className).toContain(
      "lg:min-w-[calc(var(--home-panel-width)_-_0.5rem)]",
    );
    expect(row.className).toContain("gap-2");
    // The cell and the stretch a screen draws into: two handles inside the row, and the row a third.
    expect(row.querySelectorAll("div[data-tauri-drag-region]").length).toBe(2);
    expect(row.hasAttribute("data-tauri-drag-region")).toBe(true);
  });

  test("the edge is a separator a keyboard moves: arrows by 16, with Shift by 64, Home and End to its ends", async () => {
    const { readHomePanel } = await home();
    const view = await mounted();
    expect(edge(view).getAttribute("role")).toBe("separator");
    expect(edge(view).getAttribute("aria-orientation")).toBe("vertical");
    expect(edge(view).getAttribute("aria-label")).toBe("Width of Home");
    expect(edge(view).tabIndex).toBe(0);
    // In a 1024 window: from 홈's least to what leaves the conversation 360.
    expect(
      ["aria-valuemin", "aria-valuenow", "aria-valuemax"].map((name) =>
        edge(view).getAttribute(name),
      ),
    ).toEqual(["280", "280", "664"]);

    await key(view, "ArrowRight");
    expect(drawn(view)).toBe("296px");
    expect(readHomePanel()).toEqual({ isOpen: true, width: 296 });
    await key(view, "ArrowRight", true);
    expect(drawn(view)).toBe("360px");
    await key(view, "ArrowLeft");
    expect(drawn(view)).toBe("344px");
    expect(edge(view).getAttribute("aria-valuenow")).toBe("344");

    await key(view, "End");
    expect(drawn(view)).toBe("664px");
    await key(view, "ArrowRight", true);
    expect(drawn(view)).toBe("664px");
    await key(view, "Home");
    expect(drawn(view)).toBe("280px");
    await key(view, "ArrowLeft", true);
    expect(drawn(view)).toBe("280px");

    // Any other key is not this control's.
    await key(view, "a");
    expect(readHomePanel()).toEqual({ isOpen: true, width: 280 });
    expect(ko["Width of Home"]).toBe("홈 너비");
  });

  test("dragging the edge follows the pointer between its two ends, and what is kept is where the drag ended", async () => {
    const { readHomePanel } = await home();
    const view = await mounted();

    // A press of another button is not a drag.
    await pointer(view, "pointerdown", 280, 2);
    await pointer(view, "pointermove", 500);
    expect(drawn(view)).toBe("280px");
    await pointer(view, "pointerup", 500, 2);

    await pointer(view, "pointerdown", 280);
    // Nothing eases while it follows a hand.
    expect(frame(view).dataset.resizing).toBe("true");
    await pointer(view, "pointermove", 400);
    expect(drawn(view)).toBe("400px");
    // The store is not written on the way: every write would draw the whole app again.
    expect(readHomePanel()).toEqual({ isOpen: true, width: null });
    await pointer(view, "pointermove", 5000);
    expect(drawn(view)).toBe("664px");
    await pointer(view, "pointermove", 10);
    expect(drawn(view)).toBe("280px");
    await pointer(view, "pointermove", 420);
    await pointer(view, "pointerup", 420);

    expect(frame(view).dataset.resizing).toBeUndefined();
    expect(readHomePanel()).toEqual({ isOpen: true, width: 420 });
    expect(drawn(view)).toBe("420px");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      isOpen: true,
      width: 420,
    });
    // A move with no press before it is not a drag either.
    await pointer(view, "pointermove", 600);
    expect(drawn(view)).toBe("420px");
  });

  test("gives way to a pane opened beside the screen: aside where there is no room for both — the button says so and does nothing — and back when the pane closes", async () => {
    const { readHomePanel } = await home();
    const view = await mounted("/routines");
    expect(drawn(view)).toBe("280px");

    // The routines' form is 400 wide: 1024 − 360 − 400 leaves 264, under 홈's least.
    await view.navigate("/routines?new=true");
    await view.waitFor(() => drawn(view) === "0px", "홈 to step aside");
    expect(panel(view).dataset.homePanel).toBe("aside");
    expect(panel(view).inert).toBe(true);
    expect(button(view).disabled).toBe(true);
    expect(button(view).getAttribute("aria-label")).toBe(
      "No room for Home beside what is open",
    );
    expect(button(view).getAttribute("aria-expanded")).toBe("false");
    // Stepping aside is not folding: what the person chose is as it was.
    expect(readHomePanel()).toEqual({ isOpen: true, width: null });

    await view.navigate("/routines");
    await view.waitFor(() => drawn(view) === "280px", "홈 to come back");
    expect(button(view).disabled).toBe(false);
    expect(button(view).getAttribute("aria-label")).toBe("Fold Home");
    expect(ko["No room for Home beside what is open"]).toBeString();
  });

  test("beside a narrower pane it is narrowed and not removed, and is as wide as it was chosen once the pane closes", async () => {
    const { setHomeWidth } = await home();
    const view = await mounted("/skills");
    await acted(() => setHomeWidth(600));
    expect(drawn(view)).toBe("600px");

    // A new skill's form is the pane's own 320: 1024 − 360 − 320 leaves 344.
    await view.navigate("/skills?new=true");
    await view.waitFor(() => drawn(view) === "344px", "홈 to narrow");
    expect(panel(view).dataset.homePanel).toBe("open");
    expect(button(view).disabled).toBe(false);

    await view.navigate("/skills");
    await view.waitFor(() => drawn(view) === "600px", "홈 at its own width");
  });

  test("소식 leaves 오늘 to the panel while the panel is there, and draws it itself once 홈 is folded", async () => {
    const view = await mounted("/feed");
    await view.waitFor(
      () => view.main()?.querySelector("h1")?.textContent === "Updates",
      "소식",
    );
    const onThePage = () =>
      [...(view.main()?.querySelectorAll("h2") ?? [])].map(
        (heading) => heading.textContent,
      );
    expect(onThePage()).not.toContain("Today");
    expect(
      [...panel(view).querySelectorAll("h2")].map((h) => h.textContent),
    ).toEqual(["Today"]);

    await view.click(button(view));
    await view.waitFor(() => onThePage().includes("Today"), "오늘 on the page");
  });
});
