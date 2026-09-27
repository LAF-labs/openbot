import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiRequest,
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
 * THE BOT SPEAKS FIRST, AND IT COSTS NOTHING (2026-09-27, `components/agents/greeting.tsx`).
 *
 * A new conversation opens on the Bot introducing itself and asking who the person is, with the
 * four answers drawn inside its bubble. Pressing one is an answer to the APP — `PUT /api/me/persona`
 * through the person's own session — and never a message: no turn is started, nothing reaches the
 * model, no conversation is made. That is the property these hold, by reading every request the
 * screen made, because a greeting that quietly called the model would look exactly the same.
 *
 * Once something has been said, the same block is the top of the conversation: the answer locked,
 * with a way to change it, and no chips — those are for a Bot nobody has spoken to.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const BOT = "bot-1";

const me = (
  persona: string | null,
  shop = { kind: null, places: [] },
  personaFollowUp: string | null = null,
) =>
  json({
    user: {
      ...CURRENT_USER,
      role: "user",
      onboarded: true,
      persona,
      personaFollowUp,
      shop,
      whereabouts: {
        timeZone: null,
        locale: null,
        place: null,
        coordinates: null,
      },
    },
    deployment: { effort: true, autoReview: true },
  });

/** What the screen asked of anything but the app's own record of the person. */
const beyondTheApp = (requests: ApiRequest[]) =>
  requests.filter(
    (request) =>
      (request.method !== "GET" &&
        !request.pathname.startsWith("/api/me/") &&
        !request.pathname.endsWith("/notebook") &&
        request.pathname !== "/api/components/catalogue") ||
      request.pathname.startsWith("/api/turns") ||
      (request.pathname.startsWith("/api/copilotkit") &&
        request.pathname !== "/api/copilotkit/info"),
  );

async function composeScreen(options: {
  persona: string | null;
  shop?: { kind: string | null; places: string[] };
  followedUp?: string | null;
}) {
  let persona = options.persona;
  let followedUp = options.followedUp ?? null;
  let shop = options.shop ?? { kind: null, places: [] };
  const view = await mountApp({
    path: `/channel/new?agent=${BOT}`,
    api: ({ pathname, method, body }) => {
      if (pathname === "/api/me") {
        return me(persona, shop as { kind: null; places: never[] }, followedUp);
      }
      if (pathname === "/api/agents") {
        return json({ agents: [agentFixture({ id: BOT, name: "초롱" })] });
      }
      if (pathname === "/api/me/persona/follow-up" && method === "PUT") {
        followedUp = (body as { persona: string }).persona;
        return json({ followedUp });
      }
      if (pathname === "/api/me/persona" && method === "PUT") {
        persona = (body as { persona: string | null }).persona;
        return json({ persona });
      }
      if (pathname === "/api/me/shop" && method === "PUT") {
        shop = body as typeof shop;
        return json({ shop });
      }
      if (pathname === `/api/agents/${BOT}/notebook` && method === "POST") {
        return json({ memory: { id: "memory-1" } }, 201);
      }
      if (pathname === "/api/routines") return json({ routines: [] });
      return undefined;
    },
  });
  await view.waitFor(
    () => view.host.querySelector('[data-greeting="compose"]') !== null,
    "the greeting",
    8000,
  );
  return view;
}

const rowNamed = (view: { host: HTMLElement }, name: string) =>
  [
    ...view.host.querySelectorAll<HTMLButtonElement>(
      "[data-greeting] fieldset button",
    ),
  ].find((button) => button.textContent?.trim() === name);

describe("the empty conversation", () => {
  test("the Bot introduces itself and asks who you are, with four rows to press and no chips yet", async () => {
    const view = await composeScreen({ persona: null });
    const text = view.host.textContent ?? "";
    expect(text).toContain("Hello, I'm 초롱.");
    expect(text).toContain("First, one question. Which of these are you?");
    for (const name of [
      "Student",
      "Office worker",
      "Business owner",
      "Other",
    ]) {
      expect(rowNamed(view, name)?.disabled).toBe(false);
    }
    // Nobody unknown is dealt a row of shop chips before they have said who they are.
    expect(text).not.toContain("Try one of these first");
    expect(beyondTheApp(view.requests)).toEqual([]);
  });

  test("pressing 학생 stores it, locks the card, follows up, and deals the student row — with no turn", async () => {
    const view = await composeScreen({ persona: null });
    await view.click(rowNamed(view, "Student") as HTMLButtonElement);
    await view.waitFor(
      () => (view.host.textContent ?? "").includes("What are you studying?"),
      "the follow-up",
    );
    const put = view.requests.filter(
      (request) => request.pathname === "/api/me/persona",
    );
    expect(put.map((request) => [request.method, request.body])).toEqual([
      ["PUT", { persona: "student" }],
    ]);
    // Locked: the pick is pressed, the rest cannot be.
    expect(rowNamed(view, "Student")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(rowNamed(view, "Office worker")?.disabled).toBe(true);
    await view.waitFor(
      () =>
        view.buttonNamed(
          "Make me a study plan counting back from my exam date.",
        ) !== undefined,
      "the student's first chip",
    );
    const chips = [
      ...view.host.querySelectorAll<HTMLButtonElement>(
        'section[aria-label="Try one of these first"] button',
      ),
    ].map((button) => button.textContent?.trim());
    expect(chips[0]).toBe(
      "Make me a study plan counting back from my exam date.",
    );
    expect(beyondTheApp(view.requests)).toEqual([]);
  });

  test("기타's typed line goes to 수첩 through the person's own pen, and nothing is sent to the Bot", async () => {
    const view = await composeScreen({ persona: "other" });
    const field = view.host.querySelector<HTMLInputElement>(
      '[data-greeting] input[placeholder="e.g. Running a blog after retiring"]',
    );
    expect(field).not.toBeNull();
    await view.type(field as HTMLInputElement, "은퇴 후 블로그 운영");
    await view.click(view.buttonNamed("Save") as HTMLButtonElement);
    await view.waitFor(
      () =>
        view.requests.some((request) => request.pathname.endsWith("/notebook")),
      "the notebook write",
    );
    const written = view.requests.find((request) =>
      request.pathname.endsWith("/notebook"),
    );
    expect(written?.pathname).toBe(`/api/agents/${BOT}/notebook`);
    expect(written?.body).toEqual({
      content: "What I want help with: 은퇴 후 블로그 운영",
      slot: null,
    });
    expect(beyondTheApp(view.requests)).toEqual([]);
  });

  test("the follow-up is settled before its line is written, so a second answer cannot add one", async () => {
    const view = await composeScreen({ persona: "other" });
    const field = view.host.querySelector<HTMLInputElement>(
      '[data-greeting] input[placeholder="e.g. Running a blog after retiring"]',
    );
    await view.type(field as HTMLInputElement, "은퇴 후 블로그 운영");
    await view.click(view.buttonNamed("Save") as HTMLButtonElement);
    await view.waitFor(
      () =>
        view.requests.some((request) => request.pathname.endsWith("/notebook")),
      "the notebook write",
    );
    const order = view.requests
      .filter(
        (request) =>
          request.method !== "GET" &&
          (request.pathname === "/api/me/persona/follow-up" ||
            request.pathname.endsWith("/notebook")),
      )
      .map((request) => [request.pathname, request.body]);
    expect(order).toEqual([
      ["/api/me/persona/follow-up", { persona: "other" }],
      [
        `/api/agents/${BOT}/notebook`,
        { content: "What I want help with: 은퇴 후 블로그 운영", slot: null },
      ],
    ]);
  });

  test("a follow-up already settled is not asked again, and the chips are there", async () => {
    for (const persona of ["student", "worker", "other"]) {
      const view = await composeScreen({ persona, followedUp: persona });
      await view.waitFor(
        () =>
          (view.host.textContent ?? "").includes(
            "Good. Shall we start with one of these?",
          ),
        "the chips",
      );
      const text = view.host.textContent ?? "";
      expect(text).not.toContain("What are you studying?");
      expect(text).not.toContain("What kind of work do you do?");
      expect(text).not.toContain(
        "Tell me in one line what you would like me for.",
      );
      expect(
        view.host.querySelector("[data-greeting] input:not([type=hidden])"),
      ).toBeNull();
      await view.unmount();
    }
  });

  test("a follow-up settled for another persona is asked for this one", async () => {
    const view = await composeScreen({
      persona: "worker",
      followedUp: "student",
    });
    expect(view.host.textContent).toContain("What kind of work do you do?");
  });

  test("skipping settles it too, and writes nothing", async () => {
    const view = await composeScreen({ persona: "other" });
    await view.click(view.buttonNamed("Skip") as HTMLButtonElement);
    await view.waitFor(
      () =>
        view.requests.some(
          (request) => request.pathname === "/api/me/persona/follow-up",
        ),
      "the follow-up settled",
    );
    expect(
      view.requests.some((request) => request.pathname.endsWith("/notebook")),
    ).toBe(false);
  });

  test("사장님's follow-up saves the kind through the shop's one door, keeping the places", async () => {
    const view = await composeScreen({
      persona: "owner",
      shop: { kind: null, places: ["gmail"] },
    });
    await view.click(rowNamed(view, "Restaurant or café") as HTMLButtonElement);
    await view.waitFor(
      () =>
        view.requests.some((request) => request.pathname === "/api/me/shop"),
      "the shop save",
    );
    const saved = view.requests.find(
      (request) => request.pathname === "/api/me/shop",
    );
    expect([saved?.method, saved?.body]).toEqual([
      "PUT",
      { kind: "food", places: ["gmail"] },
    ]);
    expect(beyondTheApp(view.requests)).toEqual([]);
  });
});

describe("the head of a conversation", () => {
  const history = [
    { id: "m-1", role: "user", content: "안녕" },
    { id: "m-2", role: "assistant", content: "안녕하세요!" },
  ];

  async function conversation(persona: string | null) {
    const channelId = "channel_greeting";
    const server = channelServer({ channelId, history });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: (request) => {
        if (request.pathname === "/api/me") return me(persona);
        if (request.pathname === "/api/channels") {
          return json({
            channels: [
              {
                id: channelId,
                name: "닻",
                agentIds: [BOT_ID],
                threadId: THREAD_ID,
                active: true,
                createdAt: "2026-09-27T00:00:00Z",
                lastMessageAt: "2026-09-27T00:00:00Z",
              },
            ],
          });
        }
        return server.api(request);
      },
    });
    await view.waitFor(
      () => view.host.querySelector('[data-greeting="head"]') !== null,
      "the greeting above the conversation",
      8000,
    );
    return view;
  }

  test("sits above the first message with the answer locked, a way to change it, and no chips", async () => {
    const view = await conversation("worker");
    const head = view.host.querySelector('[data-greeting="head"]');
    expect(rowNamed(view, "Office worker")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(rowNamed(view, "Student")?.disabled).toBe(true);
    expect(head?.querySelector('a[href="/settings/shop"]')?.textContent).toBe(
      "Change",
    );
    expect(view.host.textContent).not.toContain("Try one of these first");
    // Above the conversation, not inside it: the rows are the scroller's content, the greeting is not.
    expect(head?.closest('[data-slot="message-scroller-content"]')).toBeNull();
  });

  test("a question never answered stays pressable there", async () => {
    const view = await conversation(null);
    expect(rowNamed(view, "Student")?.disabled).toBe(false);
  });
});
