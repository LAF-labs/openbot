import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  MONEY_HOST_RULE,
  MONEY_WORD_RULE,
  MONEY_WORDS,
  moneyWordIn,
  REPEAT_RULE,
  shippedAskRuleOf,
  UPLOAD_RULE,
} from "../../shared/policy-rules";
import * as approvals from "../src/lib/approvals";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  json,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { stubFetch } from "./support/fetch";
import { mount, unmountAll } from "./support/mount";

/**
 * THE APPROVAL CARD SAYS WHY IN WORDS, AND LEAVES A LINE WHEN IT IS ANSWERED.
 *
 * Measured 2026-09-24 on toss.im (UI/UX audit 0.5.3, item 3): the card printed the rule's CEL in
 * monospace — `intent == "activate" && matches(page.host, "(^|[.])(kbstar[.]com|…)$")` — beside a
 * sentence about "the other one" and "경계 설정", and after 거부 or 허용 it vanished from the
 * conversation without a word. Here: the shipped rules are recognised and said as what they are
 * for, every sentence the card can say has Korean, the rule is an administrator's to see and only
 * behind 자세히, and an answer folds the card into one line that stays.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountApps();
  await unmountAll();
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  await removeAppDom();
});

const BOT = "agent_4b9d2c1e-0000-4000-8000-00000000d3c1";

const PRESSING_ON_TOSS: approvals.AskSubject = {
  kind: "browser",
  intent: "activate",
  host: "toss.im",
  element: { role: "link", name: "비즈니스" },
  reason: "policy_ask",
};

describe("why it asked", () => {
  test("the shipped rules are recognised, and nothing else is", () => {
    // That the server's default policy IS these four is `computer-default-policy.test.ts`'s to say.
    expect(
      [MONEY_WORD_RULE, MONEY_HOST_RULE, UPLOAD_RULE, REPEAT_RULE].map(
        shippedAskRuleOf,
      ),
    ).toEqual(["money_word", "money_host", "upload", "repeat"]);
    // Equality and nothing looser: an administrator's rule is not guessed to be a shipped one.
    expect(shippedAskRuleOf('intent == "activate"')).toBeNull();
    expect(shippedAskRuleOf(`${MONEY_HOST_RULE} && true`)).toBeNull();
    expect(shippedAskRuleOf(null)).toBeNull();
  });

  test("every word the money rule stops for is filed under what it is worried about", () => {
    expect(
      MONEY_WORDS.filter((word) => moneyWordIn(word)?.kind === undefined),
    ).toEqual([]);
    expect(moneyWordIn("즉시 결제하기")?.word).toBe("결제");
    expect(moneyWordIn("회원 탈퇴")?.kind).toBe("irreversible");
    expect(moneyWordIn("Checkout now")?.word).toBe("checkout");
    expect(moneyWordIn("확인")).toBeUndefined();
  });

  const said = (rule: string | null, subject: approvals.AskSubject) => {
    const phrase = approvals.whyAskedPhrase(rule, subject);
    return phrase ? { key: phrase.key, params: phrase.params } : undefined;
  };

  test("says the site, the word or the file rather than the expression", () => {
    expect(said(MONEY_HOST_RULE, PRESSING_ON_TOSS)).toEqual({
      key: "Asked because {host} is a site where money moves.",
      params: { host: "toss.im" },
    });
    expect(
      said(MONEY_WORD_RULE, {
        ...PRESSING_ON_TOSS,
        element: { role: "button", name: "결제하기" },
      }),
    ).toEqual({
      key: "Asked because it is a “{word}” button, and money may leave.",
      params: { word: "결제" },
    });
    expect(
      said(UPLOAD_RULE, { ...PRESSING_ON_TOSS, intent: "upload" })?.key,
    ).toBe("Asked because it would hand one of the Bot's files to a website.");
    // A label the card holds with no listed word in it: the general reason, never a made-up word.
    expect(
      said(MONEY_WORD_RULE, {
        ...PRESSING_ON_TOSS,
        element: { role: "button", name: "다음" },
      })?.key,
    ).toBe(
      "Asked because the button may pay, send, delete or confirm something.",
    );
    // An administrator's own rule is said to be a rule, and nothing more.
    expect(said('page.host == "toss.im"', PRESSING_ON_TOSS)?.key).toBe(
      "Asked because a rule set here says to.",
    );
  });

  test("gives no second reason where the question already says one", () => {
    expect(
      said(REPEAT_RULE, {
        ...PRESSING_ON_TOSS,
        reason: "repeat",
        repeatCount: 5,
      }),
    ).toBeUndefined();
    expect(
      said("laf:money", {
        kind: "tool",
        intent: "call_tool",
        tool: { server: "notion", name: "create_page", guard: "money" },
        reason: "guard_floor",
      }),
    ).toBeUndefined();
  });
});

/** Every shape `actionNounPhrase` can be asked about, the way `approval-subject.test.ts` walks. */
function everySubject(): approvals.AskSubject[] {
  const intents: approvals.AskSubject["intent"][] = [
    "navigate",
    "activate",
    "type",
    "read",
    "read_file",
    "write_file",
    "list_files",
    "upload",
    "call_tool",
    "act",
  ];
  const shapes: approvals.AskSubject[] = [];
  for (const intent of intents) {
    const base = {
      kind: "browser" as const,
      intent,
      reason: "policy_ask" as const,
    };
    shapes.push(
      { ...base, host: "toss.im", element: { role: "link", name: "비즈니스" } },
      { ...base, element: { role: "link", name: "비즈니스" } },
      { ...base, host: "toss.im" },
      { ...base },
      {
        ...base,
        host: "toss.im",
        path: "/business",
        file: { path: "정산.xlsx" },
      },
      { ...base, file: { path: "." } },
      { ...base, file: { path: "영수증" } },
      {
        ...base,
        kind: "tool",
        tool: { server: "notion", name: "create_page" },
      },
    );
  }
  return shapes;
}

describe("every sentence the card can say has Korean", () => {
  test("the reasons", () => {
    const rules = [
      MONEY_WORD_RULE,
      MONEY_HOST_RULE,
      UPLOAD_RULE,
      "custom",
      null,
    ];
    const labels = ["결제하기", "회원 탈퇴", "전송", "승인", "다음", ""];
    const keys = new Set<string>();
    for (const rule of rules) {
      for (const name of labels) {
        for (const host of ["toss.im", undefined]) {
          const phrase = approvals.whyAskedPhrase(rule, {
            ...PRESSING_ON_TOSS,
            element: { role: "button", name },
            ...(host ? { host } : { host: undefined }),
          });
          if (phrase) keys.add(phrase.key);
        }
      }
    }
    expect(keys.size).toBeGreaterThanOrEqual(8);
    expect([...keys].filter((key) => !(key in ko))).toEqual([]);
  });

  test("the actions and the lines a decided card leaves", () => {
    const keys = new Set<string>();
    for (const subject of [...everySubject(), undefined]) {
      keys.add(approvals.actionNounPhrase(subject).key);
      for (const decision of [
        { outcome: "declined" as const },
        { outcome: "declined" as const, reconsidered: true },
        { outcome: "unanswered" as const },
        { outcome: "allowed" as const },
        { outcome: "allowed" as const, tier: "once" as const },
        { outcome: "allowed" as const, tier: "thread" as const },
        { outcome: "allowed" as const, tier: "always" as const },
      ]) {
        keys.add(
          approvals.decisionPhrase({
            ...decision,
            ...(subject ? { subject } : {}),
          }).key,
        );
      }
    }
    expect(keys.size).toBeGreaterThanOrEqual(25);
    expect([...keys].filter((key) => !(key in ko))).toEqual([]);
  });
});

/** `/api/me` as the given role, and the one answering route; everything else is a 404. */
function answering(role: "user" | "admin") {
  const posts: unknown[] = [];
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
        deployment: { effort: true, autoReview: true },
      });
    }
    if (init?.method === "POST" && url.pathname.startsWith("/api/approvals/")) {
      posts.push(JSON.parse(String(init.body ?? "null")));
      return json({ id: "a", granted: true });
    }
    return json({ error: "laf:not_stubbed", code: "laf:not_stubbed" }, 404);
  });
  return posts;
}

async function card(toolCallId: string, rule: string) {
  const { createElement } = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ApprovalRequest } = await import(
    "../src/components/channels/approval-request"
  );
  const {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    RouterProvider,
  } = await import("@tanstack/react-router");
  approvals.openQuestion(toolCallId, {
    approvalId: `approval-${toolCallId}`,
    botId: BOT,
    subject: PRESSING_ON_TOSS,
    rule,
    scope: { kind: "host", value: "toss.im" },
    threadId: "thread-1",
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
      /*
       * Under a router, because the line an "always" folds into links to where it is taken back
       * (the Bot's profile), and a link needs a router to resolve against.
       */
      createElement(RouterProvider, {
        router: (() => {
          const root = createRootRoute();
          const here = createRoute({
            getParentRoute: () => root,
            path: "/",
            component: () => createElement(ApprovalRequest, { toolCallId }),
          });
          const profile = createRoute({
            getParentRoute: () => root,
            path: "/agents",
          });
          return createRouter({
            routeTree: root.addChildren([here, profile]),
            history: createMemoryHistory({ initialEntries: ["/"] }),
          });
        })(),
      }),
    ),
  );
  await view.settle(50);
  const button = (name: string) =>
    [...view.host.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
  return { ...view, button, text: () => view.host.textContent ?? "" };
}

describe("the card", () => {
  test("says why in words, names each button, and keeps the rule from an owner who is not an administrator", async () => {
    answering("user");
    const view = await card("call-why", MONEY_HOST_RULE);
    expect(view.text()).toContain(
      "Asked because toss.im is a site where money moves.",
    );
    expect(view.text()).toContain("Allow once: just this.");
    // Where it is taken back, by name, for an owner whatever their role (ux-review-0.5.4 §1.7).
    expect(view.text()).toContain(
      "Always allow toss.im: not asked again until you take it back on the Bot's profile.",
    );
    expect(view.text()).toContain(
      "Deny: the same thing is refused without asking for a while.",
    );
    // No CEL anywhere, and no "the other one".
    expect(view.text()).not.toContain("matches(");
    expect(view.text()).not.toContain("the other");
    expect(view.host.querySelector("details")).toBeNull();
    await view.unmount();
    approvals.closeQuestion("call-why");
  });

  test("shows an administrator the rule, folded under Details", async () => {
    answering("admin");
    const view = await card("call-rule", MONEY_HOST_RULE);
    const details = view.host.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain(MONEY_HOST_RULE);
    expect(view.text()).toContain(
      "Always allow toss.im: not asked again until you take it back on the Bot's profile.",
    );
    await view.unmount();
    approvals.closeQuestion("call-rule");
  });

  test("folds into a line that says it was denied, and what", async () => {
    answering("user");
    const view = await card("call-deny", MONEY_HOST_RULE);
    const deny = view.button("Deny");
    if (!deny) throw new Error("the card drew no Deny");
    await view.press(deny);
    await view.settle(50);

    expect(view.button("Deny")).toBeUndefined();
    expect(view.text()).toBe(
      "Denied · pressing “비즈니스” on toss.imAsk me again next time",
    );
    expect(approvals.decisionOn("call-deny")).toEqual({
      outcome: "declined",
      approvalId: "approval-call-deny",
      botId: BOT,
      subject: PRESSING_ON_TOSS,
    });
  });

  /*
   * 다시 물어보기 (0.5.4 QA): the No stood for half an hour with nothing to press. Taking it back
   * reaches the server's own route for that question, and the line then says what it did — nothing is
   * allowed; the next attempt is asked about again.
   */
  test("a denied line takes its No back, and says the next attempt asks", async () => {
    const posted: string[] = [];
    globalThis.fetch = stubFetch(async (input, init) => {
      const url = new URL(String(input), "http://localhost:3110/");
      if (init?.method === "POST") posted.push(url.pathname);
      if (url.pathname.endsWith("/reconsider")) return json({ lifted: true });
      return json({ error: "laf:not_stubbed", code: "laf:not_stubbed" }, 404);
    });
    approvals.decideQuestion("call-reconsider", {
      outcome: "declined",
      approvalId: "approval-reconsider",
      botId: BOT,
      subject: PRESSING_ON_TOSS,
    });
    const { createElement } = await import("react");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { ApprovalRequest } = await import(
      "../src/components/channels/approval-request"
    );
    const line = await mount(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(ApprovalRequest, { toolCallId: "call-reconsider" }),
      ),
    );
    await line.settle(30);
    const again = [...line.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Ask me again next time",
    );
    if (!again) throw new Error("the denied line drew no Ask me again");
    await line.press(again);
    await line.settle(30);

    expect(posted).toEqual([
      `/api/approvals/${BOT}/approval-reconsider/reconsider`,
    ]);
    expect(line.host.textContent).toBe(
      "Will ask again next time · pressing “비즈니스” on toss.im",
    );
    expect(approvals.decisionOn("call-reconsider")?.reconsidered).toBe(true);
  });

  test("folds into a line that says how wide the yes was", async () => {
    answering("user");
    const view = await card("call-always", MONEY_HOST_RULE);
    const always = view.button("Always allow toss.im");
    if (!always) throw new Error("the card drew no Always allow");
    await view.press(always);
    await view.settle(50);
    expect(view.text()).toBe(
      "Always allowed · pressing “비즈니스” on toss.imTake it back",
    );
    // The way back is a link to the list of standing permissions on the profile.
    const back = [...view.host.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Take it back",
    );
    expect(back?.getAttribute("href")).toBe("/agents#allowances");
  });

  test("is kept where a reload can read it, without anything that was typed", () => {
    approvals.decideQuestion("call-kept", {
      outcome: "allowed",
      tier: "once",
      subject: {
        kind: "browser",
        intent: "type",
        host: "bank.example",
        element: { role: "textbox", name: "받는 분" },
        reason: "policy_ask",
      },
    });
    const stored = window.localStorage.getItem("laf.approval-decisions.v1");
    expect(stored).toContain("call-kept");
    expect(stored).toContain("받는 분");
    // A subject is facts the server resolved; a value never rides on one.
    expect(stored).not.toContain("value");
  });
});

describe("an answer given somewhere else", () => {
  test("still leaves the line, saying allowed and nothing wider", async () => {
    approvals.openQuestion("call-elsewhere", {
      approvalId: "approval-elsewhere",
      botId: BOT,
      subject: PRESSING_ON_TOSS,
      rule: MONEY_HOST_RULE,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    // The waiting window holds the question (0.5.4 A): what it learns comes back on the hold.
    const held: string[] = [];
    globalThis.fetch = stubFetch(async (input) => {
      held.push(String(input));
      return json({
        holding: true,
        approval: {
          id: "approval-elsewhere",
          botId: BOT,
          rule: MONEY_HOST_RULE,
          subject: PRESSING_ON_TOSS,
          requestedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          granted: true,
          answeredBy: "owner-1",
        },
      });
    });
    const answer = await approvals.waitForApproval(
      BOT,
      "approval-elsewhere",
      undefined,
    );
    expect(answer).toBe("granted");
    expect(held).toEqual([`/api/approvals/${BOT}/approval-elsewhere/hold`]);
    expect(approvals.questionOn("call-elsewhere")).toBeUndefined();
    expect(approvals.decisionOn("call-elsewhere")).toEqual({
      outcome: "allowed",
      subject: PRESSING_ON_TOSS,
    });
  });

  test("says how wide, when the server's record does", async () => {
    approvals.openQuestion("call-wide-elsewhere", {
      approvalId: "approval-wide-elsewhere",
      botId: BOT,
      subject: PRESSING_ON_TOSS,
      rule: MONEY_HOST_RULE,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    globalThis.fetch = stubFetch(async () =>
      json({
        holding: true,
        approval: {
          id: "approval-wide-elsewhere",
          botId: BOT,
          rule: MONEY_HOST_RULE,
          subject: PRESSING_ON_TOSS,
          requestedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          granted: true,
          tier: "always",
          answeredBy: "owner-1",
        },
      }),
    );
    expect(
      await approvals.waitForApproval(
        BOT,
        "approval-wide-elsewhere",
        undefined,
      ),
    ).toBe("granted");
    expect(approvals.decisionOn("call-wide-elsewhere")?.tier).toBe("always");
  });

  /*
   * MEASURED 2026-09-25: "toss.im 항상 허용" pressed, a standing row written, and the line read
   * "허용함" with no way back drawn. The wait read "allowed" off the server and wrote first; the
   * press's own answer, knowing the tier, came back second and first writer won.
   */
  test("a yes the wait wrote first is completed by the press that knew how wide", () => {
    approvals.decideQuestion("call-race", {
      outcome: "allowed",
      subject: PRESSING_ON_TOSS,
    });
    approvals.decideQuestion("call-race", {
      outcome: "allowed",
      tier: "always",
      subject: PRESSING_ON_TOSS,
    });
    const decision = approvals.decisionOn("call-race");
    expect(decision?.tier).toBe("always");
    expect(decision && approvals.decisionPhrase(decision).key).toBe(
      "Always allowed · {action}",
    );
    // And what a reload reads back is the same.
    expect(window.localStorage.getItem("laf.approval-decisions.v1")).toContain(
      '"call-race",{"outcome":"allowed","subject"',
    );
    const stored = JSON.parse(
      window.localStorage.getItem("laf.approval-decisions.v1") ?? "[]",
    ) as [string, approvals.ApprovalDecision][];
    expect(stored.find(([id]) => id === "call-race")?.[1].tier).toBe("always");
  });

  test("completing is all it does: a No is not turned into a yes, nor a width into another", () => {
    approvals.decideQuestion("call-no", { outcome: "declined" });
    approvals.decideQuestion("call-no", { outcome: "allowed", tier: "always" });
    expect(approvals.decisionOn("call-no")).toEqual({ outcome: "declined" });
    approvals.decideQuestion("call-thread", {
      outcome: "allowed",
      tier: "thread",
    });
    approvals.decideQuestion("call-thread", {
      outcome: "allowed",
      tier: "always",
    });
    expect(approvals.decisionOn("call-thread")?.tier).toBe("thread");
  });

  test("an answer nobody gave is said as that", async () => {
    approvals.openQuestion("call-nobody", {
      approvalId: "approval-nobody",
      botId: BOT,
      subject: PRESSING_ON_TOSS,
      rule: MONEY_HOST_RULE,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    // Swept on the server: it expired, and holding it answers that nothing is open.
    globalThis.fetch = stubFetch(async () =>
      json(
        { error: "laf:approval_not_waiting", code: "laf:approval_not_waiting" },
        409,
      ),
    );
    expect(
      await approvals.waitForApproval(BOT, "approval-nobody", undefined),
    ).toBe("gave up");
    const decision = approvals.decisionOn("call-nobody");
    expect(decision?.outcome).toBe("unanswered");
    const line = decision ? approvals.decisionPhrase(decision) : undefined;
    expect(line?.key).toBe("No answer came, so it did not go ahead · {action}");
  });
});
