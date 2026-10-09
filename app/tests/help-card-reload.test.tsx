import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mount, unmountAll } from "./support/mount";

/**
 * AFTER A RELOAD, THE HELP CARD AND THE HEADER SAY THE SAME THING.
 *
 * The call that asked no longer runs in a reloaded tab, so the SDK draws its card `inProgress` with no
 * result — and the card drew no buttons while the header, which reads the computer, still said 도움
 * 필요 (0.5.4 QA). The computer is the one that knows: while it holds this card's request the card
 * keeps its buttons, and once the request is closed the card says nothing is needed.
 */

const REASON = "로그인 화면에서 막혔어요";
let control: {
  holder: "bot";
  since: string;
  requested: boolean;
  reason?: string;
  secretWanted?: string;
} = {
  holder: "bot" as const,
  since: "2026-09-25T00:00:00.000Z",
  requested: true,
  reason: REASON,
};
const asked: string[] = [];
let realFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3112/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url.endsWith("/control/release")) {
      control = { ...control, requested: false, reason: "" };
    }
    if (url.endsWith("/human/secret")) {
      // As the computer answers a value it could not put in its field: refused, and the request
      // closed in the same moment.
      control = { ...control, secretWanted: undefined };
      return new Response(
        JSON.stringify({
          error: "laf:element_not_actionable",
          code: "laf:element_not_actionable",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(control), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

afterEach(unmountAll);

describe("whose request is open", () => {
  test("is this card's only when the computer holds the words it asked with", async () => {
    const { isOwnRequestOpen } = await import(
      "../src/components/computer/help-card"
    );
    const open = { holder: "bot" as const, since: "", requested: true };
    expect(
      isOwnRequestOpen("help", ` ${REASON} `, { ...open, reason: REASON }),
    ).toBe(true);
    // Another request, from a later card.
    expect(
      isOwnRequestOpen("help", REASON, { ...open, reason: "다른 부탁" }),
    ).toBe(false);
    // Answered.
    expect(
      isOwnRequestOpen("help", REASON, {
        ...open,
        requested: false,
        reason: REASON,
      }),
    ).toBe(false);
    expect(
      isOwnRequestOpen("secret", "네이버 비밀번호", {
        ...open,
        requested: false,
        secretWanted: "네이버 비밀번호",
      }),
    ).toBe(true);
    expect(isOwnRequestOpen("help", REASON, null)).toBe(false);
    expect(isOwnRequestOpen("help", undefined, { ...open, reason: "" })).toBe(
      false,
    );
  });
});

describe("a help card a reload left unfinished", () => {
  test("keeps its buttons while the request is open, and settles it", async () => {
    const { HelpCard } = await import("../src/components/computer/help-card");
    const { ActiveBotProvider, useActiveBot } = await import(
      "../src/lib/copilot/active-bot"
    );
    // The card reads whose computer it is from the conversation it is drawn in, as in the app.
    function Conversation() {
      useActiveBot("agent-reloaded");
      return (
        <HelpCard
          kind="help"
          result={undefined}
          said={REASON}
          status="inProgress"
          toolCallId="call-before-reload"
        />
      );
    }
    const view = await mount(
      <ActiveBotProvider>
        <Conversation />
      </ActiveBotProvider>,
    );
    await view.settle(60);
    const buttons = () =>
      [...view.host.querySelectorAll("button")].map(
        (button) => button.textContent,
      );
    expect(view.host.textContent).toContain("Needs you");
    expect(buttons()).toContain("I'm done");
    expect(buttons()).toContain("Skip");

    const done = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "I'm done",
    );
    if (!done) throw new Error("no I'm done button");
    await view.press(done);
    await view.settle(60);
    expect(asked.some((url) => url.endsWith("/control/release"))).toBe(true);
    // Settled: no buttons, and nothing on the card says it needs anybody.
    expect(buttons()).toEqual([]);
    expect(view.host.textContent).not.toContain("Needs you");
  });
});

describe("a value that did not reach the page", () => {
  /*
   * The computer closes the request when the value cannot be put in its field (the box left the
   * page), so the masked box leaves the card as the failure arrives. The line saying why was inside
   * the box's form and left with it (2026-10-05): the person pressed 보내기 and saw the box vanish.
   */
  test("is said on the card, and stays said after the box has gone", async () => {
    const NAME = "네이버 비밀번호";
    control = {
      holder: "bot",
      since: "2026-10-05T00:00:00.000Z",
      requested: false,
      secretWanted: NAME,
    };
    const { HelpCard } = await import("../src/components/computer/help-card");
    const { ActiveBotProvider, useActiveBot } = await import(
      "../src/lib/copilot/active-bot"
    );
    function Conversation() {
      useActiveBot("agent-secret");
      return (
        <HelpCard
          kind="secret"
          result={undefined}
          said={NAME}
          status="executing"
          toolCallId="call-secret"
        />
      );
    }
    const view = await mount(
      <ActiveBotProvider>
        <Conversation />
      </ActiveBotProvider>,
    );
    await view.settle(60);
    const box = view.host.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    if (!box) throw new Error("no masked box");
    await view.type(box, "a-value-typed-by-a-person");
    const send = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Send to the page",
    );
    if (!send) throw new Error("no send button");
    await view.press(send);
    // The card learns the request is closed from the shared poll, which the press pokes.
    const hasBox = () =>
      view.host.querySelector('input[type="password"]') !== null;
    for (let waited = 0; hasBox() && waited < 30; waited += 1) {
      await view.settle(100);
    }

    expect(asked.some((url) => url.endsWith("/human/secret"))).toBe(true);
    // The box is gone with the request, and the reason is still on the card.
    expect(hasBox()).toBe(false);
    expect(view.host.textContent).toContain(
      "The box for that value is no longer on the page. Ask the Bot to request it again.",
    );
    // And the value is nowhere on it.
    expect(view.host.innerHTML).not.toContain("a-value-typed-by-a-person");
  });
});

/*
 * A QUESTION ABOUT ASKING FOR A VALUE IS DRAWN WHERE THE REQUEST IS. Asking for a value is decided
 * by the gateway like any act (2026-10-10), so a rule can put a question in front of it — and this
 * call has a card of its own and no line, so the question was drawn nowhere: the conversation
 * said it was waiting for an answer and gave no way to give one.
 */
describe("a request for a value that a rule asks about first", () => {
  test("is the question, with its buttons, until it is answered — and then the masked box", async () => {
    const NAME = "네이버 비밀번호";
    const CALL = "call-asked-first";
    control = {
      holder: "bot",
      since: "2026-10-10T00:00:00.000Z",
      requested: false,
    };
    const approvals = await import("../src/lib/approvals");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { SecretRequestCard } = await import(
      "../src/components/computer/help-card"
    );
    const { ActiveBotProvider, useActiveBot } = await import(
      "../src/lib/copilot/active-bot"
    );
    const { act } = await import("react");
    function Conversation() {
      useActiveBot("agent-asked");
      return (
        <SecretRequestCard
          result={undefined}
          said={NAME}
          status="executing"
          toolCallId={CALL}
        />
      );
    }
    await act(async () => {
      approvals.openQuestion(CALL, {
        approvalId: "approval-fill",
        botId: "agent-asked",
        subject: {
          kind: "browser",
          intent: "fill_secret",
          host: "nid.naver.com",
          element: { role: "textbox", name: "비밀번호" },
          reason: "policy_ask",
        },
        rule: 'intent == "fill_secret"',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    });
    const view = await mount(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ActiveBotProvider>
          <Conversation />
        </ActiveBotProvider>
      </QueryClientProvider>,
    );
    await view.settle(60);
    const buttons = () =>
      [...view.host.querySelectorAll("button")].map((button) =>
        button.textContent?.trim(),
      );
    const box = () =>
      view.host.querySelector<HTMLInputElement>('input[type="password"]');

    // The question, in the act's own words, with a way to answer it.
    expect(view.host.textContent).toContain(
      "It wants to ask you for a value to put into “비밀번호” on nid.naver.com.",
    );
    expect(buttons()).toContain("Allow once");
    // And nothing of the request's own card yet: no box, and no Skip for a wait not reached.
    expect(box()).toBeNull();
    expect(buttons()).not.toContain("Skip");

    // Answered, and the computer is asking for the value: the masked box, and no question.
    control = { ...control, secretWanted: NAME };
    await act(async () => {
      approvals.closeQuestion(CALL);
    });
    await view.settle(1_200);
    expect(buttons()).not.toContain("Allow once");
    expect(box()).not.toBeNull();
    expect(buttons()).toContain("Skip");
  });

  test("refused — by a rule, or by the person's own no — it says which, and not that it did not work", async () => {
    const { HelpCard } = await import("../src/components/computer/help-card");
    const { ActiveBotProvider, useActiveBot } = await import(
      "../src/lib/copilot/active-bot"
    );
    const { ko } = await import("../src/lib/i18n-ko");
    for (const [code, said] of [
      ["laf:policy_denied", "A rule refused it"],
      ["laf:person_declined", "A person declined that"],
    ] as const) {
      function Conversation() {
        useActiveBot("agent-refused");
        return (
          <HelpCard
            kind="secret"
            result={JSON.stringify({ ok: false, code, refused: true })}
            said="네이버 비밀번호"
            status="complete"
            toolCallId={`call-${code}`}
          />
        );
      }
      const view = await mount(
        <ActiveBotProvider>
          <Conversation />
        </ActiveBotProvider>,
      );
      await view.settle(30);
      expect([code, view.host.textContent?.includes(said)]).toEqual([
        code,
        true,
      ]);
      expect(view.host.textContent).not.toContain("Didn't work");
      expect(said in ko).toBe(true);
      await unmountAll();
    }
    // One that was tried and did not work is still said as that.
    function Failed() {
      useActiveBot("agent-refused");
      return (
        <HelpCard
          kind="secret"
          result={JSON.stringify({ ok: false, code: "laf:stale_refs" })}
          said="네이버 비밀번호"
          status="complete"
          toolCallId="call-failed"
        />
      );
    }
    const view = await mount(
      <ActiveBotProvider>
        <Failed />
      </ActiveBotProvider>,
    );
    await view.settle(30);
    expect(view.host.textContent).toContain("Didn't work");
  });
});
