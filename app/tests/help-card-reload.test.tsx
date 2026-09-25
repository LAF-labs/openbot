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
let control = {
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
    // Answered: the wheel came back.
    expect(
      isOwnRequestOpen("help", REASON, {
        ...open,
        requested: false,
        reason: REASON,
      }),
    ).toBe(false);
    // Taken over and not yet handed back: still this card's, and the Bot still waits on it.
    expect(
      isOwnRequestOpen("help", REASON, {
        ...open,
        holder: "human",
        requested: false,
        reason: REASON,
      }),
    ).toBe(true);
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
    const view = await mount(
      <HelpCard
        botId="agent-reloaded"
        kind="help"
        result={undefined}
        said={REASON}
        status="inProgress"
        toolCallId="call-before-reload"
      />,
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
