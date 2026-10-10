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
  CURRENT_USER,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
  acted,
  BOT_ID,
  installTurnStreams,
  removeTurnStreams,
  THREAD_ID,
  turnServer,
} from "./support/turn-server";

/**
 * THE FIRST SCREENS OF ONE BOT (2026-09-24).
 *
 * The owner: "봇 1개로 하자. 프로필 설정은 이름과 봇 프로필 이미지만 만들면 끝인 걸로(언제든지 바꿀
 * 수 있음). 무슨 일을 시킬건지도 적지 않는다. 그냥 모든걸 채팅으로 처리한다."
 *
 * So: a person with no Bot sees one screen — a name already filled in and the button — and lands in
 * the conversation. (A face was chosen on that screen too, until 2026-10-08; the Bot has had none
 * since 2026-10-09 — docs/laf/redesign-2026-10.md §8.) Home is that conversation. The sidebar is
 * that Bot and the places to change how it works; an account from before, with several, gets a
 * short list of them and nothing else that behaves as if there were several.
 *
 * AND THE RUNTIME STAYS WHERE A BOT IS RUN. MEASURED 2026-09-10 (audit A4, finding 5): every signed-in
 * screen statically loaded the CopilotKit runtime because the provider wrapped `_authed`'s outlet.
 * Home is a conversation now, so it starts the runtime — which is the point; the screens that are not
 * a conversation still ask nothing of it.
 */

beforeAll(async () => {
  await installAppDom();
  installTurnStreams();
}, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
// The whole route tree renders here; under a loaded machine that is more than the runner's five seconds.
setDefaultTimeout(20_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

const runtimeTraffic = (requests: { method: string; pathname: string }[]) =>
  requests.filter(
    (request) =>
      request.pathname.startsWith("/api/copilotkit") ||
      (request.method === "PUT" &&
        request.pathname === "/api/components/catalogue"),
  );

/** A person who has not finished the first run, and has no Bot. */
const newcomer = {
  user: { ...CURRENT_USER, role: "user", onboarded: false },
  deployment: { autoReview: true },
};

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

describe("the first run", () => {
  test("is one screen: a name filled in and the button — no face to pick, nothing about what the Bot is for", async () => {
    const view = await mountApp({
      path: "/",
      api: ({ pathname }) =>
        pathname === "/api/me" ? json(newcomer) : undefined,
    });
    await view.waitFor(
      () => view.router.state.location.pathname === "/welcome",
      "the first run",
    );
    await view.waitFor(
      () => view.host.querySelector("input") !== null,
      "the name field",
    );

    const inputs = [...view.host.querySelectorAll("input, textarea, select")];
    // The name, and nothing else to type into.
    expect(inputs).toHaveLength(1);
    const name = inputs[0] as HTMLInputElement;
    expect(name.value.trim().length).toBeGreaterThan(0);
    // No face to pick: the chooser's shuffle and its two rows of shapes and colours are gone.
    expect(view.buttonNamed("Another face")).toBeUndefined();
    expect(view.host.textContent).not.toContain("Shape");
    expect(view.host.textContent).not.toContain("Colour");
    expect(view.host.querySelector("svg.bot-avatar")).toBeNull();
    // The name field and the button are the only two controls on the screen.
    expect(view.host.querySelectorAll("button")).toHaveLength(1);
    expect(view.buttonNamed("Start")).toBeDefined();
    // The agreement is the sentence under the button, and it is the only other thing here.
    expect(view.host.textContent).toContain("By continuing you agree to the");
    for (const gone of [
      "What kind of work do you do?",
      "Pick the places you use every day",
      "What it does",
      "How it works",
      "Next",
    ]) {
      expect(view.host.textContent).not.toContain(gone);
    }
    expect(ko["Meet your Bot"]).toBe("내 봇 만들기");
  });

  test("Start agrees, makes the one Bot with the name on screen and no face, and opens its conversation", async () => {
    let onboarded = false;
    let made: Record<string, unknown> | null = null;
    const view = await mountApp({
      path: "/welcome",
      api: ({ method, pathname, body }) => {
        if (pathname === "/api/me") {
          return json({ ...newcomer, user: { ...newcomer.user, onboarded } });
        }
        if (pathname === "/api/me/consent" && method === "POST") {
          return new Response(null, { status: 204 });
        }
        if (pathname === "/api/agents" && method === "POST") {
          made = body as Record<string, unknown>;
          return json(
            {
              agent: agentFixture({
                id: "bot-new",
                name: String(made.name),
              }),
            },
            201,
          );
        }
        if (pathname === "/api/agents" && made) {
          return json({
            agents: [
              agentFixture({
                id: "bot-new",
                name: String(made.name),
              }),
            ],
          });
        }
        if (pathname === "/api/me/onboarded" && method === "POST") {
          onboarded = true;
          return new Response(null, { status: 204 });
        }
        return undefined;
      },
    });
    await view.waitFor(
      () => view.host.querySelector("input") !== null,
      "the name field",
    );
    const name = view.host.querySelector("input") as HTMLInputElement;
    await view.type(name, "  미소  ");
    const start = view.buttonNamed("Start") as HTMLButtonElement;
    await view.click(start);
    await view.waitFor(
      () => view.router.state.location.pathname === "/channel/new",
      "the conversation",
      8000,
    );

    const posted = view.requests.filter((request) => request.method === "POST");
    // Agreed before the Bot, stamped after it: somebody who closes the laptop mid-way comes back.
    expect(posted.map((request) => request.pathname)).toEqual([
      "/api/me/consent",
      "/api/agents",
      "/api/me/onboarded",
    ]);
    // Exactly these two: no face is sent, because the server would not take one.
    expect(made as Record<string, unknown> | null).toEqual({
      name: "미소",
      roleDescription: "",
    });
    expect(view.router.state.location.search).toEqual({ agent: "bot-new" });
  });

  test("a person who already has a Bot but never finished is not asked the server for a second", async () => {
    const posts: string[] = [];
    let saved: unknown = null;
    const view = await mountApp({
      path: "/welcome",
      api: ({ method, pathname, body }) => {
        if (method === "POST" || method === "PATCH") {
          posts.push(`${method} ${pathname}`);
        }
        if (method === "PATCH") saved = body;
        if (pathname === "/api/me") return json(newcomer);
        if (pathname === "/api/agents" && method === "GET") {
          return json({
            agents: [agentFixture({ id: "bot-old", name: "초롱" })],
          });
        }
        if (pathname === "/api/agents/bot-old" && method === "PATCH") {
          return json({ agent: agentFixture({ id: "bot-old", name: "초롱" }) });
        }
        if (method === "POST") return new Response(null, { status: 204 });
        return undefined;
      },
    });
    await view.waitFor(
      () =>
        (view.host.querySelector("input") as HTMLInputElement | null)?.value ===
        "초롱",
      "the Bot's own name in the field",
    );
    await view.click(view.buttonNamed("Start") as HTMLButtonElement);
    await view.waitFor(
      () => posts.includes("POST /api/me/onboarded"),
      "the stamp",
      8000,
    );
    expect(posts).toEqual([
      "POST /api/me/consent",
      "PATCH /api/agents/bot-old",
      "POST /api/me/onboarded",
    ]);
    // The name and the description it already had: the face it was given is not sent back.
    expect(saved).toEqual({ name: "초롱", roleDescription: "" });
  });
});

describe("home", () => {
  test("is the conversation with the Bot, which is where the runtime starts", async () => {
    const channelId = "channel_first-screen";
    const server = turnServer({ channelId });
    const view = await mountApp({
      path: "/",
      api: (request) =>
        request.pathname === "/api/channels"
          ? json({
              channels: [
                {
                  ...conversation(channelId, BOT_ID, "2026-09-20T00:00:00Z"),
                  threadId: THREAD_ID,
                },
              ],
            })
          : server.api(request),
    });
    await view.waitFor(
      () => view.router.state.location.pathname === `/channel/${channelId}`,
      "the Bot's conversation",
    );
    await view.waitFor(
      () =>
        view.requests.some(
          (request) => request.pathname === "/api/copilotkit/info",
        ),
      "the conversation to start the runtime",
      8000,
    );
  });

  /*
   * NO FACE, AND NO COLOUR FROM ONE (2026-10-09). The header led with the Bot's face and the app
   * took its accent from the face's palette, put on <html> as `data-accent`. The Bot has no face
   * now: the header is its name and the dot, and the app is drawn in the one accent everybody has.
   */
  test("the conversation's header is the Bot's name and its dot — no face anywhere — and the app takes no colour from the Bot", async () => {
    const view = await mountApp({
      path: "/",
      api: ({ pathname }) =>
        pathname === "/api/agents"
          ? json({ agents: [agentFixture({ id: "bot-1", name: "초롱" })] })
          : undefined,
    });
    const title = () =>
      [...view.host.querySelectorAll("header h1")].find(
        (heading) => heading.textContent === "초롱",
      );
    await view.waitFor(() => title() !== undefined, "the Bot's name");
    await view.settle(200);
    const header = title()?.closest("header");
    expect(header?.querySelector("svg.bot-avatar")).toBeNull();
    // The name first in its row: nothing drawn before it but what a phone puts there.
    expect(title()?.previousElementSibling).toBeNull();
    expect(view.host.querySelector("svg.bot-avatar")).toBeNull();
    const html = view.host.ownerDocument.documentElement;
    expect(html.hasAttribute("data-accent")).toBe(false);
  });

  test("a Bot nobody has spoken to yet opens on its empty conversation", async () => {
    const view = await mountApp({
      path: "/",
      api: ({ pathname }) =>
        pathname === "/api/agents"
          ? json({ agents: [agentFixture({ id: "bot-1", name: "초롱" })] })
          : undefined,
    });
    await view.waitFor(
      () => view.router.state.location.pathname === "/channel/new",
      "the empty conversation",
    );
    expect(view.router.state.location.search).toEqual({ agent: "bot-1" });
    // No "To:" row and no row of faces to build a room from.
    expect(view.host.textContent).not.toContain("To:");
    expect(view.host.textContent).not.toContain(
      "Who should be in this conversation?",
    );
  });

  test("somebody with no Bot at all is sent to make one", async () => {
    const view = await mountApp({ path: "/" });
    await view.waitFor(
      () => view.router.state.location.pathname === "/welcome",
      "the first run",
    );
  });

  test("a screen that is not a conversation asks nothing of the Bot runtime", async () => {
    const view = await mountApp({
      path: "/routines",
      api: ({ pathname }) =>
        pathname === "/api/agents"
          ? json({ agents: [agentFixture({ id: "bot-1", name: "초롱" })] })
          : undefined,
    });
    await view.settle(200);
    expect(view.router.state.location.pathname).toBe("/routines");
    expect(runtimeTraffic(view.requests)).toEqual([]);
  });
});

/*
 * THE TOP ROW (2026-10-10, record §1, piece 3-1). The column at the left of the window is gone.
 * One row stands over every screen: at its left the Bot and what it is doing — on a conversation,
 * that conversation's own header — and at its right the person's picture, which opens everything
 * the column led to (`profile-menu.test.tsx` has the list). The row is also what the installed
 * app's window is dragged by, on every screen, which is why it is checked on a page that has no
 * header of its own.
 */
describe("the top row", () => {
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
  const row = (view: { host: HTMLElement }) =>
    view.host.querySelector("[data-app-top-bar]") as HTMLElement | null;
  const presence = (view: { host: HTMLElement }) =>
    row(view)?.querySelector("a[data-bot-presence]") ?? null;
  // Counted, never matched against null: a failed `toBeNull()` on an element writes out the whole
  // document and everything React hangs on it, which is minutes of a run that looks hung.
  const presences = (view: { host: HTMLElement }) =>
    row(view)?.querySelectorAll("a[data-bot-presence]").length ?? 0;

  test("stands over a screen with no header of its own: the window's handle, the Bot and its state, and the menu — and there is no column", async () => {
    const view = await mountApp({ path: "/help", api: oneBot });
    await view.waitFor(() => presence(view) !== null, "the Bot in the row");
    // What the installed app's window is dragged by: the row, its first cell (the home button's,
    // as wide as 홈 under it — `home-frame.test.tsx`) and the empty stretch a screen draws into.
    expect(row(view)?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(
      row(view)?.querySelectorAll("div[data-tauri-drag-region]").length,
    ).toBe(2);
    // The Bot, by name and state, leading to its conversation — where a waiting card is.
    expect(presence(view)?.getAttribute("aria-label")).toBe(
      "초롱 · Ready. Conversation",
    );
    expect(presence(view)?.getAttribute("href")).toBe("/channel/c-1");
    // The menu, named and for whom, with no word drawn.
    expect(
      row(view)
        ?.querySelector("[data-profile-menu]")
        ?.getAttribute("aria-label")
        ?.startsWith("Menu · "),
    ).toBe(true);
    // No column: no navigation landmark beside the screen, no roster furniture.
    expect(
      view.host.querySelectorAll('nav[aria-label="Your Bot"]').length,
    ).toBe(0);
    expect(view.host.querySelectorAll('input[type="search"]').length).toBe(0);
    expect(
      view.host.querySelectorAll('[aria-label="Start a new channel"]').length,
    ).toBe(0);
  });

  test("on a conversation it holds that conversation's header, and there is one row, not two", async () => {
    // The conversation nobody has spoken in yet: its header needs nothing but the Bot.
    const view = await mountApp({
      path: "/channel/new?agent=bot-1",
      api: ({ pathname }) =>
        pathname === "/api/channels"
          ? json({ channels: [] })
          : oneBot({ pathname }),
    });
    await view.waitFor(
      () => row(view)?.querySelector("h1")?.textContent === "초롱",
      "the conversation's header in the row",
    );
    // The header says who the Bot is and what it is doing; the row does not say it a second time.
    expect(presences(view)).toBe(0);
    // And the conversation draws no bar of its own under the row.
    expect(view.host.querySelectorAll("header").length).toBe(1);
  });

  /*
   * A RUN ENDING IS WHEN A ROUTINE'S ANSWER LANDS, and nothing pushes that to the window: the
   * socket carries only what a window reported. The column noticed a run leave the working list
   * and asked again for what the run may have written; the column is gone and the row does it
   * (`profile-menu.tsx`), on every screen — here on one that reads none of the three itself.
   */
  test("a run that ends while another screen is open asks again for the conversations, 소식's count, the goals and what was made", async () => {
    let isWorking = true;
    const view = await mountApp({
      path: "/help",
      api: (request) => {
        if (request.pathname === "/api/agents/working") {
          return json({
            working: isWorking
              ? [
                  {
                    agentId: "bot-1",
                    origin: "routine",
                    label: "아침 주문 확인",
                    startedAt: "2026-10-10T00:00:00.000Z",
                  },
                ]
              : [],
          });
        }
        return oneBot(request);
      },
    });
    await view.waitFor(() => presence(view) !== null, "the Bot in the row");
    await view.settle(120);
    const asked = (pathname: string) =>
      view.requests.filter((request) => request.pathname === pathname).length;
    const before = [
      "/api/channels",
      "/api/feed/unseen",
      "/api/goals",
      // 홈's card, on every screen since 2026-10-10: its page was read only when opened.
      "/api/agents/bot-1/made",
    ].map(asked);

    isWorking = false;
    await acted(async () => {
      const { workingKeys } = await import("../src/lib/agents/working");
      await view.queryClient.invalidateQueries({ queryKey: workingKeys.all });
    });
    await view.waitFor(
      () => asked("/api/channels") > (before[0] ?? 0),
      "the conversations to be asked for again",
    );
    await view.settle(120);
    expect(asked("/api/feed/unseen")).toBeGreaterThan(before[1] ?? 0);
    expect(asked("/api/goals")).toBeGreaterThan(before[2] ?? 0);
    expect(asked("/api/agents/bot-1/made")).toBeGreaterThan(before[3] ?? 0);
  });

  test("an account with several Bots has none of them at the row's left: whose state would stand there has no answer", async () => {
    const view = await mountApp({
      path: "/help",
      api: ({ pathname, url }) => {
        if (pathname === "/api/agents") {
          return url.searchParams.get("hidden") === "true"
            ? json({ agents: [] })
            : json({
                agents: [
                  agentFixture({ id: "bot-1", name: "초롱" }),
                  agentFixture({ id: "bot-2", name: "두리" }),
                ],
              });
        }
        return undefined;
      },
    });
    await view.waitFor(
      () => row(view)?.querySelector("[data-profile-menu]") != null,
      "the menu",
    );
    await view.settle(120);
    expect(presences(view)).toBe(0);
    expect(ko["Your Bots"]).toBe("내 봇들");
  });
});

describe("a room from before", () => {
  /*
   * Migration 0047 deleted every room — a conversation with several Bots — with everything said in
   * it, so its old address answers 404 now. The screen used to say nothing in one was deleted, which
   * stopped being true that day; it says what happened and offers the way back to the Bot.
   */
  test("says the conversation is no longer there — not that it failed to load — and leads to the Bot", async () => {
    let asked = 0;
    const view = await mountApp({
      path: "/channel/room-1",
      api: ({ pathname }) => {
        if (pathname === "/api/agents") {
          return json({
            agents: [agentFixture({ id: "bot-1", name: "초롱" })],
          });
        }
        if (pathname === "/api/channels/room-1") {
          asked += 1;
          return json({ error: "laf:channel_not_found" }, 404);
        }
        return undefined;
      },
    });
    const sentence = "This conversation is no longer here.";
    await view.waitFor(
      () => view.host.textContent?.includes(sentence) === true,
      "the sentence",
    );
    expect(view.host.textContent).not.toContain("Could not load this channel.");
    expect(view.host.querySelector('main a[href="/"]')?.textContent).toBe(
      "Go to your Bot",
    );
    // A 404 is an answer, not a failure: the loader's read and the screen's own, and no retry of
    // either — a retry would hold "Loading…" on the screen for a second first.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(asked).toBeLessThanOrEqual(2);
    // One sentence for every conversation that is gone — a room then, a deleted project now
    // (2026-10-10): it does not explain rooms to somebody who has just deleted a project.
    expect(ko[sentence]).toBe("이 대화는 이제 없어요.");
    expect(ko[sentence]).not.toContain("지워지지 않고");
    expect(ko["Go to your Bot"]).toBe("내 봇과 대화하기");
  });
});
