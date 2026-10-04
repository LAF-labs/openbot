import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import {
  BOT_ID,
  installTurnStreams,
  removeTurnStreams,
  THREAD_ID,
  turnServer,
} from "./support/turn-server";

/**
 * THE BOT SPEAKS FIRST, AND IT COSTS NOTHING (2026-09-27, `components/agents/greeting.tsx`).
 *
 * A new conversation opens on the Bot introducing itself and asking who the person is, with the
 * four answers under its question. Pressing one is an answer to the APP — `PUT /api/me/persona`
 * through the person's own session — and never a message: no turn is started, nothing reaches the
 * model, no conversation is made. That is the property these hold, by reading every request the
 * screen made, because a greeting that quietly called the model would look exactly the same.
 *
 * Once something has been said, the same block is the top of the conversation: the answer locked,
 * with a way to change it, and no chips — those are for a Bot nobody has spoken to.
 *
 * AND IT SPEAKS THE WAY THE ANSWERS DO (2026-10-04, the last block of this file): the Bot's words
 * are on the page with no plate, and what a person presses or types is an object under them.
 */

beforeAll(async () => {
  await installAppDom();
  installTurnStreams();
}, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  removeTurnStreams();
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
  overview?: unknown;
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
      if (pathname === "/api/connections/overview" && options.overview) {
        return json(options.overview);
      }
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
  const history: Message[] = [
    { id: "m-1", role: "user", content: "안녕" },
    { id: "m-2", role: "assistant", content: "안녕하세요!" },
  ];

  async function conversation(persona: string | null) {
    const channelId = "channel_greeting";
    const server = turnServer({ channelId, history });
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

/** An OAuth row as `/api/connections/overview` sends it. */
const account = (id: string, title: string, status = "not_connected") => ({
  kind: "oauth",
  id,
  serverId: null,
  title,
  vendor: title,
  status,
  connectedAt: null,
  account: null,
  needsInstanceName: false,
  health: {
    status: "ok",
    lastOkAt: null,
    lastFailureAt: null,
    failureCode: null,
  },
});

const OVERVIEW = {
  generatedAt: "2026-09-28T00:00:00.000Z",
  accounts: [
    account("gmail", "Gmail"),
    account("google-calendar", "Google Calendar"),
    account("google-drive", "Google Drive"),
    account("notion", "Notion"),
    account("canva", "Canva"),
  ],
  sites: [],
  bots: [{ id: BOT, name: "초롱" }],
};

describe("the accounts and the places, once the Bot knows who it is talking to (2026-09-28)", () => {
  const connectRows = (view: { host: HTMLElement }) =>
    [
      ...view.host.querySelectorAll(
        '[data-greeting] [data-slot="connection-choices"] [role="switch"]',
      ),
    ].map((row) => row.getAttribute("aria-label"));

  test("a student is offered three of 연결's switches, their own first, and pressing nothing connects nothing", async () => {
    const view = await composeScreen({
      persona: "student",
      followedUp: "student",
      overview: OVERVIEW,
    });
    await view.waitFor(
      () => connectRows(view).length === 3,
      "the three switches",
    );
    const text = view.host.textContent ?? "";
    expect(text).toContain("Google Calendar");
    expect(text).toContain("Notion");
    expect(text).toContain("Canva");
    // Gmail is the office worker's first, and a student's fifth: on 연결, not here.
    expect(text).not.toContain("Reads your mail and writes replies");
    expect(
      view.requests.some((request) => request.pathname.endsWith("/connect")),
    ).toBe(false);
    expect(beyondTheApp(view.requests)).toEqual([]);
  });

  test("an office worker is offered mail first, from the same pool", async () => {
    const view = await composeScreen({
      persona: "worker",
      followedUp: "worker",
      overview: OVERVIEW,
    });
    await view.waitFor(
      () => connectRows(view).length === 3,
      "the three switches",
    );
    expect(view.host.textContent ?? "").toContain(
      "Reads your mail and writes replies",
    );
  });

  test("the places beside the conversation are the same four for everybody, each a link", async () => {
    for (const persona of ["student", "owner"]) {
      const view = await composeScreen({
        persona,
        followedUp: persona,
        overview: OVERVIEW,
      });
      const links = [
        ...view.host.querySelectorAll<HTMLAnchorElement>("[data-greeting] a"),
      ].map((link) => link.getAttribute("href"));
      for (const to of ["/feed", "/ideas", "/goals", "/routines"]) {
        expect(links).toContain(to);
      }
      await unmountApps();
    }
  });
});

/*
 * THE GREETING SPEAKS THE WAY THE ANSWERS DO (2026-10-04).
 *
 * Every piece of the Bot's was a grey bubble, with its questions' rows drawn on the grey. The
 * owner chose "proposal A" for the conversation — the Bot's answer is words on the page
 * (`plain-answer.test.tsx`) — and that left three grey bubbles above plain answers at the top of
 * every conversation. Now the greeting is set as an answer is, and only the person's side is in
 * a bubble.
 *
 * happy-dom lays nothing out and reads no stylesheet, so what is held here is what decides the
 * layout: which element the words are in, the classes on it, and that they are the transcript's
 * own. What those come to was laid out in headless Chromium and WebKit on a static copy of these
 * same screens (the numbers are in `components/agents/greeting.tsx`).
 */
describe("the greeting speaks the way the answers do", () => {
  const STYLES = readFileSync(
    join(import.meta.dir, "../src/styles.css"),
    "utf8",
  );
  /** One step of the theme's grid, in pixels: `max-w-90` is 90 of these. */
  const GRID = Number(/--spacing:\s*(\d+)px;/.exec(STYLES)?.[1]);
  const widest = (element: Element | null | undefined) => {
    const found = [...(element?.classList ?? [])]
      .map((name) => /^max-w-(\d+)$/.exec(name))
      .find((match) => match !== null);
    return found ? Number(found[1]) * GRID : null;
  };
  /** The classes on an element that would draw a plate round what is in it. */
  const plate = (element: Element | null | undefined) =>
    [...(element?.classList ?? [])].filter((name) =>
      /^(?:bg-|rounded|border|shadow|ring)/.test(name),
    );
  const greetingOf = (view: { host: HTMLElement }) =>
    view.host.querySelector<HTMLElement>("[data-greeting]");
  /** The Bot's pieces, in order: the element its words and what goes with them are in. */
  const saidBy = (view: { host: HTMLElement }) => [
    ...(greetingOf(view)?.querySelectorAll<HTMLElement>(
      '[data-slot="message"][data-align="start"] [data-slot="greeting-words"]',
    ) ?? []),
  ];
  /** Each row of the greeting: whose it is, and the space it keeps above and below itself. */
  const rhythm = (view: { host: HTMLElement }) =>
    [
      ...(greetingOf(view)?.querySelectorAll<HTMLElement>(
        '[data-slot="message"]',
      ) ?? []),
    ].map((row) => [
      row.getAttribute("data-align") === "end" ? "person" : "bot",
      [...row.classList].filter((name) => /^p[tby]-/.test(name)).join(" "),
    ]);

  test("the Bot's words are on the page, in an answer's measure and colour, with no plate from the words to the top of the greeting", async () => {
    const { answerMeasure } = await import(
      "../src/components/channels/chat-transcript"
    );
    const view = await composeScreen({ persona: null });
    const said = saidBy(view);
    // The introduction, how it works, and the question.
    expect(said.map((words) => words.querySelector("p")?.textContent)).toEqual([
      "Hello, I'm 초롱. Ask me, and I'll look things up, sort them out and get them done myself.",
      "This is how I work:",
      "First, one question. Which of these are you?",
    ]);
    // It was `data-slot="bubble"`, `data-variant="agent"`: nothing is answered yet, so there is none.
    expect(
      greetingOf(view)?.querySelectorAll('[data-slot="bubble"]').length,
    ).toBe(0);
    for (const words of said) {
      // The very string an answer is set in: 680px at most, the chat's size, a colour of its own.
      expect(words.className).toBe(answerMeasure);
      const drawn: string[] = [];
      for (
        let box: Element | null = words;
        box && box !== greetingOf(view);
        box = box.parentElement
      ) {
        drawn.push(...plate(box));
      }
      expect(drawn).toEqual([]);
    }
    expect(widest(said[0])).toBe(680);
  });

  test("and the person's answer is the one thing in a bubble, on their side", async () => {
    const view = await composeScreen({ persona: null });
    await view.click(rowNamed(view, "Student") as HTMLButtonElement);
    await view.waitFor(
      () => (view.host.textContent ?? "").includes("What are you studying?"),
      "the follow-up",
    );
    const bubbles = [
      ...(greetingOf(view)?.querySelectorAll('[data-slot="bubble"]') ?? []),
    ].map((bubble) => [
      bubble.getAttribute("data-variant"),
      bubble.getAttribute("data-align"),
      bubble.textContent,
    ]);
    expect(bubbles).toEqual([["user", "end", "Student"]]);
    // Nothing of the Bot's went into one on the way: its pieces are all still words on the page.
    expect(
      saidBy(view).filter((words) => words.closest('[data-slot="bubble"]'))
        .length,
    ).toBe(0);
  });

  test("its rows keep the transcript's own rhythm: one run for the introduction, and a new one under an answer or under something to press", async () => {
    const { rowSpacing } = await import(
      "../src/components/channels/chat-transcript"
    );
    const begins = rowSpacing("assistant", false);
    const continues = rowSpacing("assistant", true);
    const view = await composeScreen({ persona: null });
    // It was 2px above and below every row, whoever spoke: the bubbles' padding did the rest.
    expect(rhythm(view)).toEqual([
      ["bot", begins],
      ["bot", continues],
      ["bot", continues],
    ]);
    await view.click(rowNamed(view, "Student") as HTMLButtonElement);
    // The follow-up comes with the answer; the last row waits for the first things to ask.
    await view.waitFor(
      () =>
        (view.host.textContent ?? "").includes("What are you studying?") &&
        (view.host.textContent ?? "").includes(
          "Good. Shall we start with one of these?",
        ),
      "the follow-up and the chips",
    );
    expect(rhythm(view)).toEqual([
      ["bot", begins],
      ["bot", continues],
      ["bot", continues],
      ["person", rowSpacing("user", false)],
      // What are you studying?
      ["bot", begins],
      // The accounts, the places, and the first things to ask: each under something to press.
      ["bot", begins],
      ["bot", begins],
      ["bot", begins],
    ]);
  });

  test("what is pressed is a row 360px across at most — never the measure's 680 — as tall as a finger, with the ring", async () => {
    const { focusRing } = await import("../src/components/ui/focus");
    const view = await composeScreen({ persona: null });
    const rows = greetingOf(view)?.querySelector("fieldset");
    expect(widest(rows)).toBe(360);
    expect(rows?.classList.contains("w-full")).toBe(true);
    const buttons = [...(rows?.querySelectorAll("button") ?? [])];
    expect(buttons.length).toBe(4);
    for (const button of buttons) {
      const names = button.className.split(/\s+/);
      expect(names).toContain("min-h-11");
      expect(names).toContain("w-full");
      for (const ring of focusRing.split(" ")) expect(names).toContain(ring);
      // An edge of its own, and a fill under the pointer that is not the page's on the page.
      expect(names).toContain("border");
      expect(names.filter((name) => name.includes("bg-background"))).toEqual(
        [],
      );
      expect(names).toContain("enabled:hover:bg-accent");
    }
  });

  test("a locked question still reads as answered: the chosen row solid and filled, the others dimmed", async () => {
    const view = await composeScreen({
      persona: "worker",
      followedUp: "worker",
    });
    const state = (name: string) => {
      const row = rowNamed(view, name);
      return {
        pressed: row?.getAttribute("aria-pressed"),
        chosen: row?.getAttribute("data-chosen"),
        dimmed: row?.getAttribute("data-dimmed"),
        disabled: row?.disabled,
      };
    };
    expect(state("Office worker")).toEqual({
      pressed: "true",
      chosen: "true",
      dimmed: "false",
      disabled: true,
    });
    for (const name of ["Student", "Business owner", "Other"]) {
      expect(state(name)).toEqual({
        pressed: "false",
        chosen: "false",
        dimmed: "true",
        disabled: true,
      });
    }
    // What those two say is drawn by these, and the fill is one the page shows.
    const names = (rowNamed(view, "Office worker")?.className ?? "").split(
      /\s+/,
    );
    expect(names).toContain("data-[chosen=true]:border-solid");
    expect(names).toContain("data-[chosen=true]:bg-muted");
    expect(names).toContain("data-[dimmed=true]:opacity-45");
  });

  test("what is typed has a field with an edge, the same 360px, and no fill of the page's", async () => {
    const view = await composeScreen({ persona: "other" });
    const field = greetingOf(view)?.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Running a blog after retiring"]',
    );
    const names = (field?.className ?? "").split(/\s+/);
    expect(names).toContain("border");
    expect(names).toContain("border-input");
    expect(names).not.toContain("bg-background");
    expect(widest(field?.parentElement)).toBe(360);
    expect(field?.parentElement?.classList.contains("w-full")).toBe(true);
  });

  test("the accounts are a card as wide as the Bot's cards, and the places are rows as wide as the answers'", async () => {
    const view = await composeScreen({
      persona: "worker",
      followedUp: "worker",
      overview: OVERVIEW,
    });
    await view.waitFor(
      () =>
        (greetingOf(view)?.querySelectorAll(
          '[data-slot="connection-choices"] [role="switch"]',
        ).length ?? 0) === 3,
      "the three switches",
    );
    const card = greetingOf(view)?.querySelector(
      '[data-slot="connection-choices"]',
    )?.parentElement;
    // `max-w-2xl`, as `gallery/frame.tsx` has it: not the measure, and not the rows' width.
    expect(card?.className.split(/\s+/).sort()).toEqual([
      "max-w-2xl",
      "w-full",
    ]);

    const places = [
      ...(greetingOf(view)?.querySelectorAll<HTMLAnchorElement>("ul a") ?? []),
    ].filter((link) =>
      ["/feed", "/ideas", "/goals", "/routines"].includes(
        link.getAttribute("href") ?? "",
      ),
    );
    expect(places.length).toBe(4);
    expect(widest(places[0]?.closest("ul"))).toBe(360);
    for (const place of places) {
      const names = place.className.split(/\s+/);
      expect(names).toContain("min-h-11");
      expect(names.filter((name) => name.includes("bg-background"))).toEqual(
        [],
      );
    }
  });
});
