import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
// As a namespace, so a name this file needs and the module lacks fails the test that uses it rather
// than the whole file at import — which is how the failures below were first read, one by one.
import * as approvals from "../src/lib/approvals";
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
import { stubFetch } from "./support/fetch";
import { mount, unmountAll } from "./support/mount";

/**
 * ANSWERING A QUESTION, AS THE PERSON WHOSE BOT ASKED IT — WHATEVER THEIR ROLE.
 *
 * MEASURED 2026-09-16 (audit R1-02, R3-06, R5-06). The answering route asked for the Bot's owner and
 * then for an administrator too, so an account with the `user` role could not answer its own Bot:
 *
 *   - on a conversation's line the card drew its buttons anyway, and `answerApproval` read the 403
 *     as "not gone", so the card said "답을 기록하지 못했습니다. 다시 시도해 주세요." — in front of
 *     a refusal that would be given again however often it was pressed;
 *   - in a room, `mayAnswer` hid every card from anybody who was not an administrator, "deliberately
 *     so" — and the member Bot waited out its ten minutes with nothing on screen.
 *
 * The server asks ownership alone now. Here: what an answer's outcome is, the words for each, the
 * line card answered by a `user`, and the room's card drawn for the room's one person.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountApps();
  await unmountAll();
  globalThis.fetch = realFetch;
  approvals.closeQuestion(TOOL_CALL);
});
afterAll(async () => {
  await removeAppDom();
});

const BOT = "agent_4b9d2c1e-0000-4000-8000-00000000a11c";
const APPROVAL = "approval-1";
const TOOL_CALL = "tool-call-1";

const OPENING_A_PAGE: approvals.AskSubject = {
  kind: "browser",
  intent: "navigate",
  host: "smartstore.naver.com",
  reason: "policy_ask",
};

/** A fact with its status, as every refusal on this route is sent. */
const refusal = (code: string, status: number) =>
  json({ error: code, code }, status);

/** `fetch`, answering the one route an answer goes to — and `/api/me` with the given role. */
function answering(
  role: "user" | "admin",
  answer: () => Response | Promise<Response>,
) {
  const posts: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = stubFetch(async (input, init) => {
    const url = new URL(String(input), "http://localhost:3110/");
    if (url.pathname === "/api/me") {
      return json({
        user: {
          id: "owner-1",
          email: "owner@laf.test",
          name: "Owner",
          image: null,
          role,
          onboarded: true,
        },
        deployment: { effort: true, autoReview: true, seats: 5 },
      });
    }
    if (init?.method === "POST" && url.pathname.startsWith("/api/approvals/")) {
      posts.push({
        path: url.pathname,
        body: JSON.parse(String(init.body ?? "null")),
      });
      return answer();
    }
    return json({ error: "laf:not_stubbed", code: "laf:not_stubbed" }, 404);
  });
  return posts;
}

describe("what became of an answer", () => {
  const cases: Array<[string, () => Response | Promise<Response>, unknown]> = [
    ["recorded", () => json({ id: APPROVAL, granted: true }), { ok: true }],
    [
      "gone: expired, or answered in another tab",
      () => refusal("laf:approval_not_waiting", 409),
      { ok: false, gone: true, retryable: false },
    ],
    [
      "refused for a role, which pressing again will not change",
      () => refusal("laf:admin_required", 403),
      { ok: false, gone: false, retryable: false, code: "laf:admin_required" },
    ],
    [
      "refused because the Bot is not here",
      () => refusal("laf:bot_not_found", 404),
      { ok: false, gone: false, retryable: false, code: "laf:bot_not_found" },
    ],
    [
      "refused because nobody is signed in",
      () => refusal("laf:unauthenticated", 401),
      { ok: false, gone: false, retryable: false, code: "laf:unauthenticated" },
    ],
    [
      "a server that broke, which pressing again may get past",
      () => refusal("laf:internal_error", 500),
      { ok: false, gone: false, retryable: true },
    ],
    [
      "a server that was not there",
      () => refusal("laf:api_unreachable", 503),
      { ok: false, gone: false, retryable: true },
    ],
    [
      "a request that never arrived",
      () => Promise.reject(new TypeError("Load failed")),
      { ok: false, gone: false, retryable: true },
    ],
  ];

  for (const [name, answer, expected] of cases) {
    test(name, async () => {
      const posts = answering("user", answer);
      const result = await approvals.answerApproval(BOT, APPROVAL, true);
      expect(result).toEqual(expected as never);
      expect(posts).toEqual([
        {
          path: `/api/approvals/${BOT}/${APPROVAL}`,
          body: { granted: true, tier: "once" },
        },
      ]);
    });
  }

  test("is said as a fact when it was refused, and offered again only when pressing again can help", () => {
    const sentences = [
      approvals.answerProblem({ ok: false, gone: false, retryable: true }),
      approvals.answerProblem({
        ok: false,
        gone: false,
        retryable: false,
        code: "laf:admin_required",
      }),
      approvals.answerProblem({
        ok: false,
        gone: false,
        retryable: false,
        code: "laf:bot_not_found",
      }),
      approvals.answerProblem({
        ok: false,
        gone: false,
        retryable: false,
        code: "laf:unauthenticated",
      }),
      approvals.answerProblem({ ok: false, gone: false, retryable: false }),
    ];
    expect(sentences).toEqual([
      "That answer could not be recorded. Try again.",
      "Only an administrator can do that.",
      "This Bot is no longer here, so its question cannot be answered.",
      "You have been signed out. Sign in again and try once more.",
      "That answer could not be recorded.",
    ]);
  });

  test("has Korean for every refusal it names, and names what the route can refuse with", async () => {
    // `t()` on a variable is invisible to the coverage walk, so the table is walked here.
    expect(
      Object.values(approvals.ANSWER_REFUSALS).filter(
        (sentence) => !(sentence in ko),
      ),
    ).toEqual([]);
    // And the one the answering route itself adds to the session guard's: its ownership guard.
    const guards = await Bun.file(
      new URL("../../server/src/auth/guards.ts", import.meta.url),
    ).text();
    expect(guards).toContain('BOT_NOT_FOUND = "laf:bot_not_found"');
    expect(Object.keys(approvals.ANSWER_REFUSALS)).toEqual([
      "laf:bot_not_found",
    ]);
    // Neither Korean sentence for a refusal asks for another press.
    expect(ko["That answer could not be recorded."]).not.toContain("다시");
    expect(
      ko[approvals.ANSWER_REFUSALS["laf:bot_not_found"] ?? ""],
    ).not.toContain("다시");
  });
});

/** The line-level card, on its own, for a question its tool call is waiting on. */
async function lineCard() {
  const { createElement } = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ApprovalRequest } = await import(
    "../src/components/channels/approval-request"
  );
  approvals.openQuestion(TOOL_CALL, {
    approvalId: APPROVAL,
    botId: BOT,
    subject: OPENING_A_PAGE,
    rule: "browser.host == 'smartstore.naver.com'",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const view = await mount(
    createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      createElement(ApprovalRequest, { toolCallId: TOOL_CALL }),
    ),
  );
  await view.settle(50);
  const button = (name: string) =>
    [...view.host.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
  const alert = () =>
    view.host.querySelector('[role="alert"]')?.textContent ?? null;
  return { ...view, button, alert };
}

describe("the card on a conversation's line", () => {
  test("is answered by the Bot's owner without an administrator's role, and comes down", async () => {
    const posts = answering("user", () =>
      json({ id: APPROVAL, botId: BOT, granted: true, answeredBy: "owner-1" }),
    );
    const card = await lineCard();
    const allow = card.button("Allow once");
    if (!allow) throw new Error("the card drew no Allow once");

    await card.press(allow);
    await card.settle(50);

    expect(posts).toEqual([
      {
        path: `/api/approvals/${BOT}/${APPROVAL}`,
        body: { granted: true, tier: "once" },
      },
    ]);
    expect(card.button("Allow once")).toBeUndefined();
    expect(card.alert()).toBeNull();
  });

  test("says a refusal as what it is, and never as something to try again", async () => {
    let answer = refusal("laf:admin_required", 403);
    answering("user", () => answer);
    const card = await lineCard();
    const deny = card.button("Deny");
    if (!deny) throw new Error("the card drew no Deny");

    await card.press(deny);
    await card.settle(50);
    expect(card.alert()).toBe("Only an administrator can do that.");

    answer = refusal("laf:bot_not_found", 404);
    await card.press(deny);
    await card.settle(50);
    expect(card.alert()).toBe(
      "This Bot is no longer here, so its question cannot be answered.",
    );
    expect(card.alert()).not.toContain("Try again");
  });

  test("still offers another press when the answer never arrived", async () => {
    answering("user", () => Promise.reject(new TypeError("Load failed")));
    const card = await lineCard();
    const allow = card.button("Allow once");
    if (!allow) throw new Error("the card drew no Allow once");

    await card.press(allow);
    await card.settle(50);

    expect(card.alert()).toBe("That answer could not be recorded. Try again.");
    // Nothing was recorded, so the question is still there to answer.
    expect(card.button("Allow once")).toBeDefined();
  });
});

describe("a room's waiting questions", () => {
  const ROOM = "channel_room-1";
  const OTHER = "agent_4b9d2c1e-0000-4000-8000-00000000b0b0";

  test("are drawn for the person the room belongs to, whatever their role, and answered in place", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const view = await mountApp({
      path: `/channel/${ROOM}`,
      role: "user",
      api: ({ method, pathname, path, body }) => {
        if (path === "/api/agents") {
          return json({
            agents: [
              agentFixture({ id: BOT, name: "초롱" }),
              agentFixture({ id: OTHER, name: "두리" }),
            ],
          });
        }
        if (path === "/api/agents?hidden=true") return json({ agents: [] });
        const base = `/api/channels/${ROOM}`;
        if (pathname === base) {
          return json({
            channel: {
              id: ROOM,
              name: "초롱, 두리",
              agentIds: [BOT, OTHER],
              threadId: "thread-room-1",
              active: true,
            },
          });
        }
        if (pathname === `${base}/messages`) return json({ messages: [] });
        if (pathname === `${base}/message-times`) {
          return json({ times: {}, speakers: {} });
        }
        if (pathname === `${base}/failures`) return json({ failures: [] });
        if (pathname === `${base}/read`) {
          return json({
            previousReadAt: null,
            readAt: new Date().toISOString(),
          });
        }
        if (method === "GET" && pathname === `/api/approvals/${BOT}`) {
          return json({
            approvals: posts.length
              ? []
              : [
                  {
                    id: APPROVAL,
                    botId: BOT,
                    rule: "browser.host == 'smartstore.naver.com'",
                    subject: OPENING_A_PAGE,
                    requestedAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 600_000).toISOString(),
                  },
                ],
          });
        }
        if (method === "POST" && pathname.startsWith("/api/approvals/")) {
          posts.push({ path: pathname, body });
          return json({ id: APPROVAL, botId: BOT, granted: true });
        }
        return undefined;
      },
    });
    await view.waitFor(
      () => view.buttonNamed("Allow once") !== undefined,
      "the room's waiting question",
    );

    // The question, named for the member that asked it.
    expect(view.main()?.textContent).toContain(
      "초롱 is waiting for your answer: It wants to open smartstore.naver.com.",
    );
    const allow = view.buttonNamed("Allow once");
    if (!allow) throw new Error("no Allow once");
    await view.click(allow);
    await view.waitFor(
      () => view.buttonNamed("Allow once") === undefined,
      "the answered card to come down",
    );

    expect(posts).toEqual([
      {
        path: `/api/approvals/${BOT}/${APPROVAL}`,
        body: { granted: true, tier: "once" },
      },
    ]);
    await view.unmount();
  });

  test("do not send somebody who cannot open Boundaries there to take an allowance back", async () => {
    const { createElement } = await import("react");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { RoomApprovals } = await import(
      "../src/components/channels/room-approvals"
    );
    const footnote = async (role: "user" | "admin") => {
      answering(role, () => json({}));
      const view = await mount(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(RoomApprovals, {
            approvals: [
              {
                approvalId: APPROVAL,
                memberId: BOT,
                memberName: "초롱",
                subject: OPENING_A_PAGE,
                rule: "browser.host == 'smartstore.naver.com'",
                expiresAt: "",
                scope: { kind: "host", value: "smartstore.naver.com" },
              },
            ],
            onAnswered: () => {},
          }),
        ),
      );
      await view.settle(50);
      const text = view.host.textContent ?? "";
      await view.unmount();
      return text;
    };

    const asUser = await footnote("user");
    expect(asUser).toContain(
      "the other covers every one like it until somebody takes it back.",
    );
    expect(asUser).not.toContain("Boundaries");

    const asAdmin = await footnote("admin");
    expect(asAdmin).toContain("until you take it back in Boundaries.");
  });
});
