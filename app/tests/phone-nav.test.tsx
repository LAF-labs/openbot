import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactElement } from "react";
import { ko } from "../src/lib/i18n-ko";
import { stubFetch } from "./support/fetch";
import { json, mount, routerAt, unmountAll } from "./support/mount";

/**
 * THE PHONE'S WAY AROUND: the bottom bar and the two pages it adds (muse-shape plan phase 3,
 * 2026-09-27).
 *
 * Below `md` the sidebar was a sheet slid in from a menu button in each screen's header. It is a bar
 * of three labelled tabs now — 대화 · 소식 · 메뉴 — over the pages that exist. happy-dom evaluates no
 * media query, so what is held here is what each tab is, where it goes, which one says it is the
 * page, and the classes that keep the bar off the PC app and out of the keyboard's way; the widths
 * and the fold were measured in the browser.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountAll();
  globalThis.fetch = realFetch;
});

const bot = (id: string, name: string) => ({
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

function server(
  options: {
    unread?: boolean;
    role?: "user" | "admin";
    bots?: ReturnType<typeof bot>[];
    items?: unknown[];
  } = {},
) {
  globalThis.fetch = stubFetch(async (input) => {
    const url = String(input);
    if (url === "/api/agents") {
      return json({ agents: options.bots ?? [bot("bot-1", "초롱")] });
    }
    if (url === "/api/agents?hidden=true") return json({ agents: [] });
    if (url === "/api/agents/working") return json({ working: [] });
    if (url === "/api/me") {
      return json({
        user: {
          id: "u1",
          email: "kim@example.com",
          name: "김",
          role: options.role ?? "user",
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
            lastMessage: "다 했어요",
            lastMessageAt: new Date().toISOString(),
            lastMessageAgentId: "bot-1",
            unread: options.unread ?? false,
            createdAt: new Date().toISOString(),
          },
        ],
      });
    }
    if (url === "/api/agents/bot-1/day") {
      return json({
        day: "2026-09-27",
        zone: "Asia/Seoul",
        items: options.items ?? [],
        more: false,
      });
    }
    if (url === "/api/routines") return json({ routines: [] });
    if (url.startsWith("/api/computers/")) return json({ requested: false });
    return json({}, 404);
  });
}

const PATHS = [
  "/",
  "/feed",
  "/ideas",
  "/menu",
  "/routines",
  "/notebook",
  "/skills",
  "/help",
  "/agents",
  "/settings",
  "/settings/connected-accounts",
  "/admin",
  "/channel/$channelId",
  "/channel/new",
  "/sign",
];

async function at(path: string, component: () => ReactElement | null) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { RouterProvider } = await import("@tanstack/react-router");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = await routerAt(path, PATHS, () => (
    <QueryClientProvider client={client}>{component()}</QueryClientProvider>
  ));
  const view = await mount(<RouterProvider router={router} />);
  await view.settle(60);
  return view;
}

async function bar(path: string, options: Parameters<typeof server>[0] = {}) {
  server(options);
  const { PhoneTabBar } = await import(
    "../src/components/layout/phone-tab-bar"
  );
  const view = await at(path, () => <PhoneTabBar />);
  const nav = () => view.host.querySelector("[data-phone-tab-bar]");
  const tabs = () => [...(nav()?.querySelectorAll("a") ?? [])];
  return {
    ...view,
    nav,
    tabs,
    current: () =>
      tabs()
        .filter((tab) => tab.getAttribute("aria-current") === "page")
        .map((tab) => tab.textContent),
  };
}

describe("the phone's bar", () => {
  /*
   * FOUR SINCE PHASE 5: 아이디어 came with its page, third, where the plan puts it (§4). The
   * bar gains a tab only with the page behind it.
   */
  test("four labelled tabs, to the conversation, 소식, 아이디어 and 메뉴", async () => {
    const view = await bar("/channel/ch-1");
    expect(
      view.tabs().map((tab) => [tab.textContent, tab.getAttribute("href")]),
    ).toEqual([
      ["Conversation", "/"],
      ["Updates", "/feed"],
      ["Ideas", "/ideas"],
      ["Menu", "/menu"],
    ]);
    expect(view.nav()?.querySelector("ul")?.className).toContain("grid-cols-4");
    expect(ko.Conversation).toBe("대화");
    expect(ko.Updates).toBe("소식");
    expect(ko.Ideas).toBe("아이디어");
    expect(ko.Menu).toBe("메뉴");
    expect(ko.Places).toBe("이동");
  });

  test("never on the PC app, over the home indicator's inset, and tall enough for a thumb", async () => {
    const view = await bar("/");
    const classes = view.nav()?.className.split(/\s+/) ?? [];
    expect(classes).toContain("md:hidden");
    expect(classes).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(view.nav()?.querySelector("ul")?.className).toContain("h-14");
    for (const tab of view.tabs()) expect(tab.className).toContain("min-h-11");
    // The layout lays the bar under the screen on a phone.
    const layout = readFileSync(
      join(import.meta.dir, "../src/routes/_authed/_app.tsx"),
      "utf8",
    );
    expect(layout).toContain("max-md:flex-col");
    expect(layout).toContain("<PhoneTabBar />");
  });

  test("out of the way while a keyboard is up, and not merely because the composer has the caret", async () => {
    /*
     * The composer takes the caret when a conversation opens, and on a phone that raises no
     * keyboard: the first rule (hide on focus) left the 대화 tab with no bar at all, measured at 375.
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
    // Focused, no keyboard: the bar stays.
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

  test("the tab that is the page says so: the conversation, 소식, 아이디어, and 메뉴 for every place under it", async () => {
    expect((await bar("/channel/ch-1")).current()).toEqual(["Conversation"]);
    await unmountAll();
    expect((await bar("/feed")).current()).toEqual(["Updates"]);
    await unmountAll();
    expect((await bar("/ideas")).current()).toEqual(["Ideas"]);
    await unmountAll();
    for (const path of ["/menu", "/routines", "/notebook", "/skills"]) {
      expect((await bar(path)).current()).toEqual(["Menu"]);
      await unmountAll();
    }
  });

  test("the conversation's tab carries the unread mark", async () => {
    const quiet = await bar("/feed");
    expect(quiet.nav()?.querySelector("[data-mark]")).toBeNull();
    await unmountAll();
    const unread = await bar("/feed", { unread: true });
    expect(
      unread.nav()?.querySelector("[data-mark]")?.getAttribute("data-mark"),
    ).toBe("unread");
    expect(unread.tabs()[0]?.textContent).toContain("Unread");
  });
});

async function menu(options: Parameters<typeof server>[0] = {}) {
  server(options);
  const { Route } = await import("../src/routes/_authed/_app/menu");
  const Page = Route.options.component as () => ReactElement;
  return at("/menu", () => <Page />);
}

describe("메뉴", () => {
  test("the Bot, then the sidebar's own places and 설정, then 모두 멈추기 and 로그아웃", async () => {
    const view = await menu();
    const { footerLinksFor } = await import(
      "../src/components/app-sidebar/places"
    );
    const links = [...view.host.querySelectorAll("a")].map((link) => [
      link.textContent,
      link.getAttribute("href"),
    ]);
    // The Bot first, to its profile; then exactly the sidebar footer's list, then 설정.
    expect(links[0]?.[1]).toBe("/agents?agent=bot-1");
    expect(links[0]?.[0]).toContain("초롱");
    expect(links.slice(1)).toEqual([
      ...footerLinksFor(false).map((link) => [link.label, link.to]),
      ["Settings", "/settings"],
    ]);
    const buttons = [...view.host.querySelectorAll("button")].map(
      (button) => button.textContent,
    );
    expect(buttons).toEqual(["Stop everything", "Log out"]);
  });

  test("관리 for an administrator, and 봇 프로필 as a place for an account with several Bots", async () => {
    const admin = await menu({ role: "admin" });
    expect(admin.host.textContent).toContain("Admin");
    await unmountAll();
    const several = await menu({
      bots: [bot("bot-1", "초롱"), bot("bot-2", "두리")],
    });
    expect(
      [...several.host.querySelectorAll("a")].map((link) =>
        link.getAttribute("href"),
      ),
    ).toContain("/agents");
  });
});

describe("소식", () => {
  test("오늘 as a page, and a line rather than a blank screen when there is nothing yet", async () => {
    server();
    const { Route } = await import("../src/routes/_authed/_app/feed");
    const Page = Route.options.component as () => ReactElement;
    const view = await at("/feed", () => <Page />);
    await view.settle(60);
    expect(view.host.querySelector("h1")?.textContent).toBe("Updates");
    expect(view.host.textContent).toContain(
      "Nothing yet today. What you hand over in the conversation shows up here.",
    );
    expect(
      ko[
        "Nothing yet today. What you hand over in the conversation shows up here."
      ],
    ).toBeString();
    expect(
      ko[
        "What your Bot did today, what is waiting on you, and what it does next."
      ],
    ).toBeString();
  });
});
