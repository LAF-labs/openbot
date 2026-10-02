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
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
  acted,
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * BETWEEN STEPS, THE BOT IS THINKING TOO.
 *
 * The thinking line was drawn only until the first thing arrived. Measured on the running app,
 * 2026-10-02, on one turn of 14.5 s (the clock, the weather, a note, the answer): for 4.1 s after
 * the second step and 1.2 s after the third, the Bot had the turn and the transcript was a list of
 * finished steps with nothing moving. After: the longest such stretch was the 1.2 s this waits.
 *
 * On the conversation people use, with a turn running and the server's own frames: a step that has
 * its result, the Bot's words arriving and then not, and the things that keep the line away.
 */

beforeAll(async () => {
  await installAppDom();
  installTurnStreams();
  (
    window as unknown as {
      happyDOM: { setWindowSize(size: { width: number }): void };
    }
  ).happyDOM.setWindowSize({ width: 375 });
}, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
});
setDefaultTimeout(30_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

/** Longer than the transcript waits before it says so (`BETWEEN_STEPS_MS`, 1200). */
const LONG_ENOUGH_MS = 1500;
/** Shorter: two steps that follow each other within the second say nothing between them. */
const NOT_YET_MS = 500;

const ASKED: Message = {
  id: "q-asked",
  role: "user",
  content: "지금 몇 시인지 확인하고 메모해 둬",
};
/**
 * A step with no card of its own, drawn as a plain line (`step-labels.ts`) that stays once it is
 * over: a tool this app has no name for. (`tool_search` is the one that does not stay — below.)
 */
const stepCalled = (
  id: string,
  calls: string[] = [id],
  name = "look_up_orders",
): Message =>
  ({
    id: `a-${id}`,
    role: "assistant",
    content: "",
    toolCalls: calls.map((call) => ({
      id: `call-${call}`,
      type: "function",
      function: { name, arguments: '{"query":"시각"}' },
    })),
  }) as Message;
const stepAnswered = (id: string): Message =>
  ({
    id: `t-${id}`,
    role: "tool",
    toolCallId: `call-${id}`,
    content: "찾은 도구 없음",
  }) as Message;
const saying = (text: string): Message => ({
  id: "a-said",
  role: "assistant",
  content: text,
});

const log = (host: HTMLElement) => host.querySelector('[role="log"]');
const isThinking = (host: HTMLElement) =>
  [...(log(host)?.querySelectorAll("p.tool-line-running") ?? [])].some((line) =>
    line.textContent?.startsWith("Thinking"),
  );

/** A turn that has the Bot, and has drawn nothing but the question yet. */
async function running(channelId: string) {
  const server = turnServer({
    channelId,
    history: [ASKED],
    turn: { id: "turn-0", status: "running", asked: [ASKED.id] },
    turnMessages: [ASKED],
  });
  const view = await mountApp({
    path: `/channel/${channelId}`,
    api: server.api,
  });
  await view.waitFor(
    () => log(view.host)?.textContent?.includes(String(ASKED.content)) === true,
    "the question the turn is for",
    8000,
  );
  return {
    server,
    view,
    /** The server's own copies of what the turn has written so far. */
    writes: (messages: Message[]) => acted(() => server.say(messages)),
  };
}

describe("a turn that is going, with its last step finished", () => {
  test("is said to be thinking before anything arrives, as it always was", async () => {
    const { server, view } = await running("channel_thinking-first");
    await view.waitFor(() => isThinking(view.host), "the thinking line", 4000);
    server.close();
    await view.unmount();
  });

  test("is said to be thinking again once the step has sat still, and not before", async () => {
    const { server, view, writes } = await running("channel_thinking-after");
    await writes([stepCalled("1")]);
    await view.settle(100);
    // The step is out: its own line is what moves.
    expect(isThinking(view.host)).toBe(false);
    await writes([stepCalled("1"), stepAnswered("1")]);
    // Not at once: the next step usually follows within the second.
    await view.settle(NOT_YET_MS);
    expect(isThinking(view.host)).toBe(false);
    await view.settle(LONG_ENOUGH_MS - NOT_YET_MS);
    expect(isThinking(view.host)).toBe(true);
    // And said to somebody listening, in the status line that is always there.
    expect(
      [...view.host.querySelectorAll('[role="status"]')].map(
        (region) => region.textContent,
      ),
    ).toContain("Thinking");
    server.close();
    await view.unmount();
  });

  test("stops being said the moment the next step starts, and is said again after that one", async () => {
    const { server, view, writes } = await running("channel_thinking-next");
    await writes([stepCalled("1"), stepAnswered("1")]);
    await view.settle(LONG_ENOUGH_MS);
    expect(isThinking(view.host)).toBe(true);

    await writes([stepCalled("2")]);
    await view.settle(100);
    expect(isThinking(view.host)).toBe(false);
    // However long that step takes: the Bot is waiting for it, not thinking.
    await view.settle(LONG_ENOUGH_MS);
    expect(isThinking(view.host)).toBe(false);

    await writes([stepCalled("2"), stepAnswered("2")]);
    await view.settle(LONG_ENOUGH_MS);
    expect(isThinking(view.host)).toBe(true);
    server.close();
    await view.unmount();
  });

  test("is not said while another step of the same turn is still out", async () => {
    const { server, view, writes } = await running("channel_thinking-pair");
    // Two steps asked for together: the second has answered and the first has not.
    await writes([stepCalled("pair", ["1", "2"]), stepAnswered("2")]);
    await view.settle(LONG_ENOUGH_MS);
    expect(isThinking(view.host)).toBe(false);
    await writes([stepAnswered("1")]);
    await view.settle(LONG_ENOUGH_MS);
    expect(isThinking(view.host)).toBe(true);
    server.close();
    await view.unmount();
  });

  test("is not said once the turn is over", async () => {
    const { server, view, writes } = await running("channel_thinking-over");
    await writes([stepCalled("1"), stepAnswered("1")]);
    await view.settle(LONG_ENOUGH_MS);
    expect(isThinking(view.host)).toBe(true);
    await writes([saying("16시 34분이에요.")]);
    await acted(() => server.announce("done"));
    await view.settle(100);
    expect(isThinking(view.host)).toBe(false);
    await view.settle(LONG_ENOUGH_MS);
    expect(isThinking(view.host)).toBe(false);
    server.close();
    await view.unmount();
  });
});

describe("a look through the Bot's own tool list", () => {
  /*
   * Measured 2026-10-02: a conversation from that morning still read "도구 찾는 중" between a saved
   * file and the card for it. It is the mechanism (`shared/tools/bridge.ts`), drawn while it is out
   * so the conversation is not standing still, and not kept once it has answered.
   */
  test("is drawn while it is out, and leaves no line once it has answered", async () => {
    const { server, view, writes } = await running("channel_thinking-lookup");
    await writes([stepCalled("1", ["1"], "tool_search")]);
    await view.waitFor(
      () => log(view.host)?.textContent?.includes("Finding a tool") === true,
      "the line saying a tool is being looked for",
      4000,
    );
    await writes([stepCalled("1", ["1"], "tool_search"), stepAnswered("1")]);
    await view.waitFor(
      () => log(view.host)?.textContent?.includes("Finding a tool") === false,
      "that line gone once the search has answered",
      4000,
    );
    // With nothing drawn after the question, the Bot is thinking — at once, as before anything came.
    expect(isThinking(view.host)).toBe(true);
    server.close();
    await view.unmount();
  });
});

describe("a turn that is going, with the Bot's words as its last row", () => {
  test("is not said to be thinking while they arrive, and is once they have stopped", async () => {
    const { server, view, writes } = await running("channel_thinking-words");
    // A burst every few hundred milliseconds: never still for long enough.
    for (const text of ["찾아", "찾아볼", "찾아볼게", "찾아볼게요."]) {
      await writes([saying(text)]);
      await view.settle(400);
      expect(isThinking(view.host)).toBe(false);
    }
    // Then nothing more arrives and the turn goes on: the Bot is deciding what to do next.
    await view.settle(LONG_ENOUGH_MS);
    expect(isThinking(view.host)).toBe(true);
    server.close();
    await view.unmount();
  });
});
