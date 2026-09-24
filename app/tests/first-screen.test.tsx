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
import { BOT_ID, channelServer, THREAD_ID } from "./support/channel-server";

/**
 * THE FIRST SCREENS OF ONE BOT (2026-09-24).
 *
 * The owner: "봇 1개로 하자. 프로필 설정은 이름과 봇 프로필 이미지만 만들면 끝인 걸로(언제든지 바꿀
 * 수 있음). 무슨 일을 시킬건지도 적지 않는다. 그냥 모든걸 채팅으로 처리한다."
 *
 * So: a person with no Bot sees one screen — a name already filled in, a face already chosen, and
 * the button — and lands in the conversation. Home is that conversation. The sidebar is that Bot and
 * the places to change how it works; an account from before, with several, gets a short list of them
 * and nothing else that behaves as if there were several.
 *
 * AND THE RUNTIME STAYS WHERE A BOT IS RUN. MEASURED 2026-09-10 (audit A4, finding 5): every signed-in
 * screen statically loaded the CopilotKit runtime because the provider wrapped `_authed`'s outlet.
 * Home is a conversation now, so it starts the runtime — which is the point; the screens that are not
 * a conversation still ask nothing of it.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
// The whole route tree renders here; under a loaded machine that is more than the runner's five seconds.
setDefaultTimeout(20_000);
afterAll(async () => {
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
  deployment: { effort: true, autoReview: true },
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
  test("is one screen: a name filled in, a face, and the button — nothing about what the Bot is for", async () => {
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
    // The face: the chooser's shuffle and its two rows of shapes and colours.
    expect(view.buttonNamed("Another face")).toBeDefined();
    expect(view.host.textContent).toContain("Shape");
    expect(view.host.textContent).toContain("Colour");
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

  test("Start agrees, makes the one Bot with the name and face on screen, and opens its conversation", async () => {
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
                avatarSeed: String(made.avatarSeed),
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
                avatarSeed: String(made.avatarSeed),
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
    await view.click(view.buttonNamed("Another face") as HTMLButtonElement);
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
    expect(made).toMatchObject({
      name: "미소",
      roleDescription: "",
    });
    expect(
      String((made as Record<string, unknown> | null)?.avatarSeed),
    ).toMatch(/^s:/);
    expect(view.router.state.location.search).toEqual({ agent: "bot-new" });
  });

  test("a person who already has a Bot but never finished is not asked the server for a second", async () => {
    const posts: string[] = [];
    const view = await mountApp({
      path: "/welcome",
      api: ({ method, pathname }) => {
        if (method === "POST" || method === "PATCH") {
          posts.push(`${method} ${pathname}`);
        }
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
  });
});

describe("home", () => {
  test("is the conversation with the Bot, which is where the runtime starts", async () => {
    const channelId = "channel_first-screen";
    const server = channelServer({ channelId });
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

describe("the sidebar", () => {
  const nav = (view: { host: HTMLElement }) =>
    view.host.querySelector("nav") as HTMLElement;
  const rows = (view: { host: HTMLElement }) =>
    [...nav(view).querySelectorAll("ul a")].map(
      (link) => link.getAttribute("href") ?? "",
    );

  test("with one Bot, is that Bot and the places to change how it works — nothing to make or add", async () => {
    const view = await mountApp({
      path: "/help",
      api: ({ pathname }) => {
        if (pathname === "/api/agents") {
          return json({
            agents: [agentFixture({ id: "bot-1", name: "초롱" })],
          });
        }
        if (pathname === "/api/channels") {
          return json({
            channels: [conversation("c-1", "bot-1", "2026-09-20T00:00:00Z")],
          });
        }
        return undefined;
      },
    });
    await view.waitFor(() => rows(view).length === 1, "the Bot's row");
    expect(rows(view)).toEqual(["/channel/c-1"]);
    const text = nav(view).textContent ?? "";
    expect(text).toContain("초롱");
    for (const label of ["Routines", "Skills", "Connections", "Help"]) {
      expect(text).toContain(label);
    }
    // The profile is the Bot itself, at the top of the column (2026-09-24), not a second link.
    expect(
      nav(view).querySelector('a[href^="/agents"]')?.getAttribute("aria-label"),
    ).toContain("Bot profile");
    // The list heading is for an account with several; the roster's own furniture is gone.
    expect(text).not.toContain("Your Bots");
    expect(nav(view).querySelector('input[type="search"]')).toBeNull();
    expect(
      nav(view).querySelector('[aria-label="Start a new channel"]'),
    ).toBeNull();
  });

  test("on an account from before, lists every Bot it has — hidden ones too — each opening its own conversation", async () => {
    const view = await mountApp({
      path: "/help",
      api: ({ pathname, url }) => {
        if (pathname === "/api/agents") {
          return url.searchParams.get("hidden") === "true"
            ? json({
                agents: [
                  agentFixture({ id: "bot-3", name: "세모", hidden: true }),
                ],
              })
            : json({
                agents: [
                  agentFixture({ id: "bot-1", name: "초롱" }),
                  agentFixture({ id: "bot-2", name: "두리" }),
                ],
              });
        }
        if (pathname === "/api/channels") {
          return json({
            channels: [
              conversation("c-1", "bot-1", "2026-09-20T00:00:00Z"),
              conversation("c-2", "bot-2", "2026-09-21T00:00:00Z"),
              // A room from before: it is not either Bot's conversation, and it is not listed.
              {
                ...conversation("room", "bot-1", "2026-09-22T00:00:00Z"),
                agentIds: ["bot-1", "bot-2"],
              },
            ],
          });
        }
        return undefined;
      },
    });
    await view.waitFor(() => rows(view).length === 3, "three Bots");
    expect(nav(view).textContent).toContain("Your Bots");
    expect(rows(view)).toEqual([
      "/channel/c-1",
      "/channel/c-2",
      // Nobody has spoken to the hidden one: its row opens the empty conversation, by its id.
      "/channel/new?agent=bot-3",
    ]);
    expect(ko["Your Bots"]).toBe("내 봇들");
  });
});

describe("a room from before", () => {
  /*
   * Migration 0047 deleted every room — a conversation with several Bots — with everything said in
   * it, so its old address answers 404 now. The screen used to say nothing in one was deleted, which
   * stopped being true that day; it says what happened and offers the way back to the Bot.
   */
  test("says group conversations were removed with what was said in them, and leads to the Bot", async () => {
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
    const sentence =
      "This conversation is no longer here. Conversations with several Bots were removed, along with everything said in them.";
    await view.waitFor(
      () => view.host.textContent?.includes(sentence) === true,
      "the sentence",
    );
    expect(view.host.textContent).not.toContain("Could not load this channel.");
    expect(view.host.querySelector('a[href="/"]')?.textContent).toBe(
      "Go to your Bot",
    );
    // A 404 is an answer, not a failure: the loader's read and the screen's own, and no retry of
    // either — a retry would hold "Loading…" on the screen for a second first.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(asked).toBeLessThanOrEqual(2);
    expect(ko[sentence]).toContain("지워졌어요");
    expect(ko[sentence]).not.toContain("지워지지 않고");
    expect(ko["Go to your Bot"]).toBe("내 봇과 대화하기");
  });
});
