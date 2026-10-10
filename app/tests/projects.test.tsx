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
  isProject,
  projectName,
  projectsOf,
} from "../src/lib/channels/projects";
import type { ChannelSummary } from "../src/lib/channels/queries";
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
import { installTurnStreams, removeTurnStreams } from "./support/turn-server";

/*
 * 프로젝트 — THE OTHER CONVERSATIONS A PERSON HAS WITH THEIR BOT (2026-10-10,
 * `docs/laf/redesign-2026-10.md` §1 and §3, piece 4-2).
 *
 * The Bot's main conversation is one. A project is a conversation beside it, made by a name. What
 * is held here: that a project is what the server says is one and nothing guessed; that the page
 * is the names and one box; that a press makes one and opens it; that the switch in the top row
 * says which of the two the screen is; and that the main conversation is still what "the
 * conversation" means everywhere else.
 */

type View = Awaited<ReturnType<typeof mountApp>>;
type Api = NonNullable<Parameters<typeof mountApp>[0]["api"]>;
type Request = Parameters<Api>[0];

const channel = (
  id: string,
  kind: "main" | "project" | undefined,
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
  ...(kind ? { kind } : {}),
  ...over,
});

describe("which conversations are projects", () => {
  test("the ones the server says are, for that Bot, in the order they came", () => {
    const channels = [
      channel("p-2", "project", { name: "가을 메뉴" }),
      channel("main", "main"),
      channel("p-1", "project", { name: "이사" }),
      channel("other", "project", { agentIds: ["bot-2"] }),
    ];
    expect(projectsOf("bot-1", channels).map((one) => one.id)).toEqual([
      "p-2",
      "p-1",
    ]);
    expect(projectsOf("bot-2", channels).map((one) => one.id)).toEqual([
      "other",
    ]);
  });

  test("none is guessed: a server that says nothing of any of them has no projects", () => {
    expect(
      projectsOf("bot-1", [
        channel("older", undefined, { createdAt: "2026-09-01T00:00:00Z" }),
        channel("newer", undefined),
      ]),
    ).toEqual([]);
    expect(projectsOf("bot-1", undefined)).toEqual([]);
    expect(projectsOf("bot-1", "x" as unknown as ChannelSummary[])).toEqual([]);
    expect(isProject(channel("main", "main"))).toBe(false);
    expect(isProject(undefined)).toBe(false);
  });

  test("a project is called what the person called it, and one with no name is called that", () => {
    expect(projectName({ name: "  가을 메뉴 " })).toBe("가을 메뉴");
    expect(projectName({ name: "" })).toBe("Untitled project");
    expect(projectName({ name: "   " })).toBe("Untitled project");
    expect(projectName({ name: 7 })).toBe("Untitled project");
    expect(ko["Untitled project"]).toBe("이름 없는 프로젝트");
  });
});

beforeAll(async () => {
  await installAppDom();
  // A project opens as a conversation, and a conversation watches its turn's stream.
  installTurnStreams();
}, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

/** One Bot, its main conversation and whatever projects a test gives it. */
const account =
  (
    projects: ChannelSummary[] = [],
    over: (request: Request) => Response | undefined = () => undefined,
  ): Api =>
  (request) => {
    const answered = over(request);
    if (answered) return answered;
    if (request.pathname === "/api/agents") {
      return json({ agents: [agentFixture({ id: "bot-1", name: "초롱" })] });
    }
    if (request.pathname === "/api/channels" && request.method === "GET") {
      return json({ channels: [...projects, channel("main", "main")] });
    }
    return undefined;
  };

const switched = (view: View) =>
  [
    ...view.host.querySelectorAll<HTMLAnchorElement>("[data-screen-switch] a"),
  ].map((link) => ({
    is: link.dataset.screen,
    to: link.getAttribute("href"),
    on: link.getAttribute("aria-current") === "page",
    marked: link.querySelectorAll('[data-mark="new"]').length === 1,
  }));
const names = (view: View) =>
  [...view.host.querySelectorAll("[data-project]")].map(
    (row) => row.querySelector("span")?.textContent,
  );

describe("the 프로젝트 screen", () => {
  test("is the names, each the way into its conversation — and nothing else about them", async () => {
    const view = await mountApp({
      path: "/projects",
      api: account([
        channel("p-2", "project", { name: "가을 메뉴", unread: true }),
        channel("p-1", "project", { name: "" }),
      ]),
    });
    await view.waitFor(() => names(view).length === 2, "the projects");
    expect(view.main()?.querySelector("h1")?.textContent).toBe("Projects");
    expect(names(view)).toEqual(["가을 메뉴", "Untitled project"]);
    expect(
      [...view.host.querySelectorAll("[data-project]")].map((row) =>
        row.getAttribute("href"),
      ),
    ).toEqual(["/channel/p-2", "/channel/p-1"]);
    // The main conversation is not a project, and is not in the list.
    expect(view.main()?.querySelectorAll('[href="/channel/main"]').length).toBe(
      0,
    );
    // Something unread in one wears the mark, said for whoever cannot see it.
    const rows = [...view.host.querySelectorAll("[data-project]")];
    expect(
      rows.map((row) => row.querySelectorAll('[data-mark="new"]').length),
    ).toEqual([1, 0]);
    expect(rows[0]?.textContent).toContain("Unread");
    // With one Bot there is no Bot's name over the list.
    expect(view.main()?.querySelectorAll("h2").length).toBe(0);
    expect([ko.Projects, ko.Chat, ko["New project"]]).toEqual([
      "프로젝트",
      "채팅",
      "새 프로젝트",
    ]);
  });

  test("with none yet it says in one line what comes here, and the box is there", async () => {
    const view = await mountApp({ path: "/projects", api: account() });
    await view.waitFor(
      () => view.host.querySelectorAll("[data-projects-none]").length === 1,
      "the one line",
    );
    expect(names(view)).toEqual([]);
    expect(view.host.querySelectorAll("[data-project-name]").length).toBe(1);
    expect(
      ko["Work that runs over days gets a conversation of its own here."],
    ).toBeString();
  });

  test("one press makes a project of that Bot by that name and opens it", async () => {
    const made: unknown[] = [];
    const view = await mountApp({
      path: "/projects",
      api: account([], (request) => {
        if (
          request.pathname === "/api/channels/projects" &&
          request.method === "POST"
        ) {
          made.push(request.body);
          return json(
            { channel: channel("p-new", "project", { name: "가을 메뉴" }) },
            201,
          );
        }
        return undefined;
      }),
    });
    await view.waitFor(
      () => view.host.querySelectorAll("[data-project-name]").length === 1,
      "the box",
    );
    await view.type(
      view.host.querySelector("[data-project-name]") as HTMLInputElement,
      "가을 메뉴",
    );
    await view.click(view.host.querySelector("[data-project-make]") as Element);
    await view.waitFor(
      () => view.router.state.location.pathname === "/channel/p-new",
      "the project to open",
    );
    expect(made).toEqual([{ agentId: "bot-1", name: "가을 메뉴" }]);
  });

  test("a refusal is said in the page's own words, and nothing opens", async () => {
    const view = await mountApp({
      path: "/projects",
      api: account([], (request) =>
        request.pathname === "/api/channels/projects"
          ? json({ error: "laf:project_limit", code: "laf:project_limit" }, 409)
          : undefined,
      ),
    });
    await view.waitFor(
      () => view.host.querySelectorAll("[data-project-make]").length === 1,
      "the button",
    );
    await view.click(view.host.querySelector("[data-project-make]") as Element);
    await view.waitFor(
      () => view.main()?.querySelectorAll('[role="alert"]').length === 1,
      "the refusal",
    );
    expect(view.main()?.querySelector('[role="alert"]')?.textContent).toBe(
      "There are as many projects as there can be.",
    );
    expect(view.router.state.location.pathname).toBe("/projects");
    expect(ko["There are as many projects as there can be."]).toBeString();
  });

  test("an account with several Bots has each Bot's projects under its name", async () => {
    const view = await mountApp({
      path: "/projects",
      api: (request) => {
        if (request.pathname === "/api/agents") {
          return json({
            agents: [
              agentFixture({ id: "bot-1", name: "초롱" }),
              agentFixture({ id: "bot-2", name: "두리" }),
            ],
          });
        }
        if (request.pathname === "/api/channels") {
          return json({
            channels: [
              channel("a-p", "project", { name: "초롱의 일" }),
              channel("a-main", "main"),
              channel("b-p", "project", {
                name: "두리의 일",
                agentIds: ["bot-2"],
              }),
              channel("b-main", "main", { agentIds: ["bot-2"] }),
            ],
          });
        }
        return undefined;
      },
    });
    await view.waitFor(() => names(view).length === 2, "both lists");
    expect(
      [...(view.main()?.querySelectorAll("h2") ?? [])].map(
        (h) => h.textContent,
      ),
    ).toEqual(["초롱", "두리"]);
    expect(
      [...view.host.querySelectorAll("[data-projects-of]")].map((block) => [
        (block as HTMLElement).dataset.projectsOf,
        [...block.querySelectorAll("[data-project]")].map((row) =>
          row.getAttribute("href"),
        ),
      ]),
    ).toEqual([
      ["bot-1", ["/channel/a-p"]],
      ["bot-2", ["/channel/b-p"]],
    ]);
  });
});

describe("채팅 | 프로젝트, in the top row", () => {
  test("says which of the two the screen is, leads to the other, and marks neither on a screen that is neither", async () => {
    const view = await mountApp({
      path: "/projects",
      api: account([channel("p-1", "project", { name: "이사" })]),
    });
    await view.waitFor(() => switched(view).length === 2, "the switch");
    expect(switched(view)).toEqual([
      { is: "chat", to: "/", on: false, marked: false },
      { is: "projects", to: "/projects", on: true, marked: false },
    ]);
    // Where the screen begins: after the home button's cell, before what a screen draws.
    const row = view.host.querySelector("[data-app-top-bar]") as HTMLElement;
    expect(
      [...row.children]
        .slice(0, 2)
        .map((child) => [
          child.hasAttribute("data-top-bar-home"),
          child.hasAttribute("data-screen-switch"),
        ]),
    ).toEqual([
      [true, false],
      [false, true],
    ]);

    await view.navigate("/help");
    expect(switched(view).map((one) => one.on)).toEqual([false, false]);
  });

  test("프로젝트 wears a mark while a project has something unread — and the main conversation's unread is not its to wear", async () => {
    const unread = await mountApp({
      path: "/help",
      api: account([channel("p-1", "project", { unread: true })]),
    });
    await unread.waitFor(
      () => switched(unread)[1]?.marked === true,
      "the mark",
    );
    expect(switched(unread)[0]?.marked).toBe(false);
    await unread.unmount();

    const mainOnly = await mountApp({
      path: "/help",
      api: (request) =>
        request.pathname === "/api/channels"
          ? json({
              channels: [
                channel("p-1", "project"),
                channel("main", "main", { unread: true }),
              ],
            })
          : account()(request),
    });
    await mainOnly.waitFor(() => switched(mainOnly).length === 2, "the switch");
    await mainOnly.settle(120);
    expect(switched(mainOnly).map((one) => one.marked)).toEqual([false, false]);
  });
});

describe("deleting a project", () => {
  test("each project has its own delete, beside its name and named for it — never inside the link that opens it", async () => {
    const view = await mountApp({
      path: "/projects",
      api: account([
        channel("p-2", "project", { name: "가을 메뉴" }),
        channel("p-1", "project", { name: "" }),
      ]),
    });
    await view.waitFor(() => names(view).length === 2, "the projects");
    const buttons = [
      ...view.host.querySelectorAll<HTMLButtonElement>("[data-project-delete]"),
    ];
    expect(
      buttons.map((button) => [
        button.dataset.projectDelete,
        button.getAttribute("aria-label"),
      ]),
    ).toEqual([
      ["p-2", "Delete “가을 메뉴”"],
      ["p-1", "Delete “Untitled project”"],
    ]);
    expect(view.host.querySelectorAll("a [data-project-delete]").length).toBe(
      0,
    );
    /*
     * The question it opens is `ConfirmDialog`'s, held by its own file in a process of its own
     * (`confirm-dialog.test.tsx`): a Base UI popup opened in this shared process decides its
     * animation support before this file's DOM exists. Pressed in the running app instead.
     */
    expect([
      ko["Delete “{title}”"],
      ko["Delete the project “{title}”?"],
    ]).toEqual(["‘{title}’ 지우기", "‘{title}’ 프로젝트를 지울까요?"]);
    expect(
      ko[
        "The project and everything said in it go. What your Bot learned there stays."
      ],
    ).toBeString();
  });

  describe("the request", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });
    const answering = (status: number, body: unknown) => {
      const asked: Array<[string, string]> = [];
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        asked.push([init?.method ?? "GET", String(input)]);
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
          status,
        });
      }) as typeof fetch;
      return asked;
    };
    const client = async () => {
      const { QueryClient } = await import("@tanstack/react-query");
      const { channelKeys } = await import("../src/lib/channels/queries");
      const queryClient = new QueryClient();
      queryClient.setQueryData(
        channelKeys.detail("p 1"),
        channel("p 1", "project"),
      );
      queryClient.setQueryData(channelKeys.list(), [channel("p 1", "project")]);
      return { channelKeys, queryClient };
    };

    test("asks the project's own door, and afterwards the conversation is out of what is held and the list is read again", async () => {
      const { deleteProject } = await import("../src/lib/channels/mutations");
      const asked = answering(200, { deleted: true });
      const { channelKeys, queryClient } = await client();
      await deleteProject(queryClient, "p 1");
      expect(asked).toEqual([["DELETE", "/api/channels/projects/p%201"]]);
      expect(
        queryClient.getQueryData(channelKeys.detail("p 1")),
      ).toBeUndefined();
      expect(queryClient.getQueryState(channelKeys.list())?.isInvalidated).toBe(
        true,
      );
    });

    test("one that is already gone is the same success: another window got there first", async () => {
      const { deleteProject } = await import("../src/lib/channels/mutations");
      answering(404, { code: "laf:channel_not_found" });
      const { channelKeys, queryClient } = await client();
      await deleteProject(queryClient, "p 1");
      expect(
        queryClient.getQueryData(channelKeys.detail("p 1")),
      ).toBeUndefined();
    });

    test.each([
      [409, "laf:project_only", "Only a project can be deleted here."],
      [409, "laf:project_deleting", "That project is being deleted."],
      [500, "laf:internal", "Could not delete the project. Try again."],
    ])(
      "a refusal (%i %s) is a sentence, and what is held stays",
      async (status, code, sentence) => {
        const { deleteProject } = await import("../src/lib/channels/mutations");
        answering(status, { code, error: code });
        const { channelKeys, queryClient } = await client();
        await expect(deleteProject(queryClient, "p 1")).rejects.toThrow(
          sentence,
        );
        expect(
          queryClient.getQueryData(channelKeys.detail("p 1")),
        ).toBeDefined();
        expect(ko[sentence as keyof typeof ko]).toBeString();
      },
    );

    test("one the server is still deleting leaves the list: it is read again, with the sentence said", async () => {
      const { deleteProject } = await import("../src/lib/channels/mutations");
      answering(409, { code: "laf:project_deleting" });
      const { channelKeys, queryClient } = await client();
      await expect(deleteProject(queryClient, "p 1")).rejects.toThrow(
        "That project is being deleted.",
      );
      expect(queryClient.getQueryState(channelKeys.list())?.isInvalidated).toBe(
        true,
      );
    });
  });
});
