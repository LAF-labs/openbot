import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { SearchHit } from "../../shared/search";
import type { ChannelSummary } from "../src/lib/channels/queries";
import { ko } from "../src/lib/i18n-ko";
import { SEARCH_REFUSALS } from "../src/lib/search/queries";
import {
  APP_DOM_TIMEOUT_MS,
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { installTurnStreams, removeTurnStreams } from "./support/turn-server";

/*
 * 검색 — WHAT WAS SAID, IN THE MAIN CONVERSATION AND EVERY PROJECT (2026-10-10,
 * `docs/laf/redesign-2026-10.md` §1 and §3, piece 4-3).
 *
 * Held here: that the way to it is in the top row of every screen; that what a person types is
 * asked for once they stop, in the request's body and never in an address; that a hit says where
 * and is the way to that message; that the words outlive the page; and that every way the answer
 * can go wrong is a sentence, not an empty list that reads as "nobody ever said that".
 */

type View = Awaited<ReturnType<typeof mountApp>>;
type Api = NonNullable<Parameters<typeof mountApp>[0]["api"]>;
type Request = Parameters<Api>[0];

const channel = (
  id: string,
  kind: "main" | "project",
  over: Partial<ChannelSummary> = {},
): ChannelSummary => ({
  id,
  name: id,
  agentIds: ["bot-1"],
  threadId: `thread-${id}`,
  active: true,
  lastMessage: "…",
  lastMessageAt: "2026-10-01T00:00:00Z",
  lastMessageAgentId: "bot-1",
  unread: false,
  createdAt: "2026-10-01T00:00:00Z",
  kind,
  ...over,
});

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  at: "2026-10-01T03:00:00.000Z",
  channelId: "main",
  channelName: "초롱",
  kind: "main",
  messageId: "m-1",
  role: "user",
  snippet: "가을 메뉴를 정해 줘",
  ...over,
});

beforeAll(async () => {
  await installAppDom();
  // A hit opens a conversation, and a conversation watches its turn's stream.
  installTurnStreams();
}, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

/** One Bot, its main conversation, a project, and whatever the search answers. */
const account =
  (
    search: (request: Request) => Response | Promise<Response> | undefined,
    bots = [agentFixture({ id: "bot-1", name: "초롱" })],
    channels = [
      channel("main", "main"),
      channel("p-1", "project", { name: "가을 메뉴 개편" }),
    ],
  ): Api =>
  (request) => {
    if (request.pathname === "/api/search") return search(request);
    if (request.pathname === "/api/agents") return json({ agents: bots });
    if (request.pathname === "/api/channels" && request.method === "GET") {
      return json({ channels });
    }
    return undefined;
  };

const box = (view: View) =>
  view.host.querySelector("[data-search-box]") as HTMLInputElement;
const hits = (view: View) => [
  ...view.host.querySelectorAll<HTMLAnchorElement>("[data-search-hit]"),
];
const asked = (view: View) =>
  view.requests.filter((request) => request.pathname === "/api/search");

describe("the way to the search", () => {
  test.each(["/projects", "/made", "/search"])(
    "is in the top row on %s, by name",
    async (path) => {
      const view = await mountApp({
        path,
        api: account(() => json({ hits: [], next: null })),
      });
      const links = view.host.querySelectorAll<HTMLAnchorElement>(
        "[data-app-top-bar] [data-search-button]",
      );
      expect(links.length).toBe(1);
      expect(links[0]?.getAttribute("href")).toBe("/search");
      expect(links[0]?.getAttribute("aria-label")).toBe("Search");
      expect(links[0]?.getAttribute("aria-current")).toBe(
        path === "/search" ? "page" : null,
      );
      expect(ko.Search).toBe("검색");
    },
  );
});

describe("the 검색 screen", () => {
  test("opens as a box and nothing else, with the keyboard in it, and asks for nothing", async () => {
    const view = await mountApp({
      path: "/search",
      api: account(() => json({ hits: [], next: null })),
    });
    expect(view.main()?.querySelector("h1")?.textContent).toBe("Search");
    expect(document.activeElement).toBe(box(view));
    expect(hits(view)).toEqual([]);
    expect(view.host.querySelectorAll("[data-search-none]").length).toBe(0);
    expect(view.host.querySelectorAll("[data-search-hits]").length).toBe(0);
    expect(asked(view)).toEqual([]);
    expect(ko["Search every conversation"]).toBe("모든 대화에서 찾기");
  });

  test("asks once the typing stops, in the request's body, and draws where each hit was said with the words marked", async () => {
    const view = await mountApp({
      path: "/search",
      api: account(() =>
        json({
          hits: [
            hit({
              channelId: "p-1",
              channelName: "가을 메뉴 개편",
              kind: "project",
              messageId: "m-2",
              role: "assistant",
              snippet: "…가을 Menu는 메뉴판부터 바꿔요…",
            }),
            hit(),
          ],
          next: null,
        }),
      ),
    });
    // One character is not a search; the two that follow are one, asked for once.
    await view.type(box(view), "메");
    await view.type(box(view), "메뉴 menu");
    await view.waitFor(() => hits(view).length === 2, "the hits");
    expect(
      asked(view).map((request) => [request.method, request.path]),
    ).toEqual([["POST", "/api/search"]]);
    expect(asked(view)[0]?.body).toEqual({ q: "메뉴 menu" });
    // Never in an address: not the request's, not the window's.
    expect(view.router.state.location.href).toBe("/search");

    expect(
      hits(view).map((row) => [
        row.getAttribute("href"),
        row.querySelector("[data-search-where]")?.textContent,
        [...row.querySelectorAll("mark")].map((mark) => mark.textContent),
        row.querySelector(".sr-only")?.textContent,
      ]),
    ).toEqual([
      ["/channel/p-1", "가을 메뉴 개편", ["Menu", "메뉴"], "Your Bot said"],
      // The main conversation is called what the switch calls it.
      ["/channel/main", "Chat", ["메뉴"], "You said"],
    ]);
    expect(hits(view)[0]?.textContent).toContain(
      "…가을 Menu는 메뉴판부터 바꿔요…",
    );
    expect([ko["You said"], ko["Your Bot said"]]).toEqual([
      "내가 한 말",
      "봇이 한 말",
    ]);
  });

  test("a hit opens its conversation at that message, and the way back is to the list it was pressed in", async () => {
    const view = await mountApp({
      path: "/search",
      api: account(() =>
        json({
          hits: [hit({ channelId: "p-1", kind: "project", messageId: "m-9" })],
          next: null,
        }),
      ),
    });
    await view.type(box(view), "메뉴");
    await view.waitFor(() => hits(view).length === 1, "the hit");

    const { usePendingJump } = await import("../src/lib/channels/jump");
    const { mount: mountBeside } = await import("./support/mount");
    const jumps: string[] = [];
    function Watching() {
      const jump = usePendingJump("p-1");
      if (jump?.messageId && jumps.at(-1) !== jump.messageId) {
        jumps.push(jump.messageId);
      }
      return null;
    }
    await mountBeside(<Watching />);
    await view.click(hits(view)[0] as HTMLAnchorElement);
    await view.waitFor(
      () => view.router.state.location.pathname === "/channel/p-1",
      "the conversation to open",
    );
    expect(jumps).toEqual(["m-9"]);

    await view.navigate("/search");
    await view.waitFor(() => hits(view).length === 1, "the list again");
    expect(box(view).value).toBe("메뉴");
  });

  test("Enter asks at once", async () => {
    const view = await mountApp({
      path: "/search",
      api: account(() => json({ hits: [hit()], next: null })),
    });
    await view.type(box(view), "메뉴");
    const form = box(view).closest("form") as HTMLFormElement;
    const { act } = await import("react");
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await view.waitFor(() => hits(view).length === 1, "the hit");
    expect(asked(view).length).toBe(1);
  });

  test("words nobody said are one line, and clearing the box is the box again", async () => {
    const view = await mountApp({
      path: "/search",
      api: account(() => json({ hits: [], next: null })),
    });
    await view.type(box(view), "없는말");
    await view.waitFor(
      () => view.host.querySelectorAll("[data-search-none]").length === 1,
      "the one line",
    );
    expect(view.host.querySelector("[data-search-none]")?.textContent).toBe(
      "No message has those words.",
    );
    expect(ko["No message has those words."]).toBeString();
    await view.type(box(view), "");
    await view.waitFor(
      () => view.host.querySelectorAll("[data-search-none]").length === 0,
      "the line to go",
    );
    expect(hits(view)).toEqual([]);
  });

  test("older hits are asked for from where the page ended, and stand under the ones already read", async () => {
    const view = await mountApp({
      path: "/search",
      api: account((request) =>
        (request.body as { cursor?: string }).cursor
          ? json({ hits: [hit({ messageId: "m-old" })], next: null })
          : json({ hits: [hit({ messageId: "m-new" })], next: "cursor-1" }),
      ),
    });
    await view.type(box(view), "메뉴");
    await view.waitFor(() => hits(view).length === 1, "the first page");
    const older = [...(view.main()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Show older",
    );
    await view.click(older as Element);
    await view.waitFor(() => hits(view).length === 2, "the second page");
    expect(hits(view).map((row) => row.dataset.searchHit)).toEqual([
      "m-new",
      "m-old",
    ]);
    expect(asked(view).map((request) => request.body)).toEqual([
      { q: "메뉴" },
      { cursor: "cursor-1", q: "메뉴" },
    ]);
    // Nothing further back: the button is gone.
    expect(
      [...(view.main()?.querySelectorAll("button") ?? [])].filter(
        (button) => button.textContent === "Show older",
      ).length,
    ).toBe(0);
  });

  test("a search that could not be made says so, with a way to ask again — not that nothing was found", async () => {
    let isBroken = true;
    const view = await mountApp({
      path: "/search",
      api: account(() =>
        isBroken
          ? json(
              {
                error: "laf:search_unavailable",
                code: "laf:search_unavailable",
              },
              500,
            )
          : json({ hits: [hit()], next: null }),
      ),
    });
    await view.type(box(view), "메뉴");
    await view.waitFor(
      () =>
        view
          .main()
          ?.textContent?.includes(
            "The conversations could not be searched.",
          ) === true,
      "the sentence",
    );
    expect(view.host.querySelectorAll("[data-search-none]").length).toBe(0);
    isBroken = false;
    const again = [...(view.main()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Try again",
    );
    await view.click(again as Element);
    await view.waitFor(() => hits(view).length === 1, "the hit");
  });

  test.each([
    ["nothing", null],
    ["a list", []],
    ["hits that are not hits", { hits: [null, 3, { channelId: 1 }], next: 7 }],
  ])(
    "an answer that is %s draws no hit and breaks nothing",
    async (_name, body) => {
      const view = await mountApp({
        path: "/search",
        api: account(() => json(body)),
      });
      await view.type(box(view), "메뉴");
      await view.waitFor(() => asked(view).length === 1, "the request");
      await view.waitFor(
        () => view.host.querySelectorAll("[data-search-none]").length === 1,
        "the one line",
      );
      expect(hits(view)).toEqual([]);
      expect(view.host.querySelectorAll("[data-search-box]").length).toBe(1);
    },
  );

  test("on an account with several Bots a main conversation is called by its Bot", async () => {
    const view = await mountApp({
      path: "/search",
      api: account(
        () =>
          json({
            hits: [
              hit({ channelId: "b-main", messageId: "m-b" }),
              hit({ channelId: "gone", channelName: "옛 대화" }),
            ],
            next: null,
          }),
        [
          agentFixture({ id: "bot-1", name: "초롱" }),
          agentFixture({ id: "bot-2", name: "두리" }),
        ],
        [
          channel("main", "main"),
          channel("b-main", "main", { agentIds: ["bot-2"] }),
        ],
      ),
    });
    await view.type(box(view), "메뉴");
    await view.waitFor(() => hits(view).length === 2, "the hits");
    expect(
      hits(view).map(
        (row) => row.querySelector("[data-search-where]")?.textContent,
      ),
      // A conversation the roster no longer lists is called what the server called it.
    ).toEqual(["두리", "옛 대화"]);
  });
});

describe("the door's refusals", () => {
  test("each is a sentence the dictionary holds", () => {
    for (const sentence of Object.values(SEARCH_REFUSALS)) {
      expect(ko[sentence as keyof typeof ko]).toBeString();
    }
    expect(Object.keys(SEARCH_REFUSALS).sort()).toEqual([
      "laf:search_cursor_invalid",
      "laf:search_query_invalid",
      "laf:search_unavailable",
    ]);
  });
});
