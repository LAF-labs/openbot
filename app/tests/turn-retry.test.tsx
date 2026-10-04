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
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
  acted,
  askedIn,
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * 다시 시도 UNDER A FAILED QUESTION ASKS IT AGAIN WITHOUT SAYING IT TWICE.
 *
 * MEASURED 2026-09-10 (audit A4, finding 1): with the API stopped, "지금 몇 시야" got the red line and
 * the button; with the API back, the button put a SECOND "지금 몇 시야" into the thread — two
 * bubbles on screen, and in the store two user rows under one answer, which every later prompt
 * then read as a person asking twice.
 *
 * The real channel route, with the server stubbed at the network edge (`support/turn-server`).
 * What a retry sends is read off the hand-over — what the server is given. The server's store keys
 * messages by id (`appendMessages`), so the same question under the same id is the row it already
 * holds, and the same words under a new id are a second row.
 *
 * ON THE TURNS THE SERVER OWNS. These were written against the window that ran the turn itself,
 * where a retry sent the whole thread again; that window was removed 2026-10-05, and until then
 * nothing mounted pressed 다시 시도 under a failed question on the screen people use. A hand-over
 * carries only what the person says — the server holds the rest — so "in place" reads here as the
 * stored question alone, under its own id.
 */

beforeAll(async () => {
  await installAppDom();
  installTurnStreams();
}, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(async () => {
  await unmountApps();
  localStorage.clear();
  const { forgetUnsentCache } = await import(
    "../src/components/channels/composer/outbox"
  );
  forgetUnsentCache();
});
// Longer than the longest wait below, so a screen that never gets there fails with what it was
// waiting for rather than with the runner's own five seconds.
setDefaultTimeout(20_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

const QUESTION = "지금 몇 시야";
const ANSWER = "오후 2시 10분경이에요.";

const failed = '[data-testid="transcript-stopped"]';
const unsentLine = '[data-testid="transcript-unsent"]';

type Server = ReturnType<typeof turnServer>;

/** How many bubbles in the transcript say exactly these words: what a person counts. */
const bubblesSaying = (host: HTMLElement, words: string) =>
  [
    ...host.querySelectorAll('[role="log"] [data-slot="bubble-content"]'),
  ].filter((bubble) => bubble.textContent?.trim() === words).length;

/** The turn the server has just taken runs, says this, and ends as it should. */
const answers = (server: Server, words: string, id = "a-answer") =>
  acted(() => {
    server.announce("running");
    server.say([{ id, role: "assistant", content: words }]);
    server.announce("done");
  });

/**
 * The turn gets part of an answer out and then loses the Bot, as agent-bot dying mid-reply does:
 * the engine ends it `error` with the fact (`engine.ts`), and files the failure in its ledger.
 */
const halfThenGone = (server: Server, words: string) =>
  acted(() => {
    server.announce("running");
    server.say([{ id: "a-half-live", role: "assistant", content: words }]);
    server.announce("error", "laf:turn_unreachable");
  });

describe("다시 보내기 after the server could not be reached", () => {
  test("asks the same message again, once, and the answer lands under it", async () => {
    const { stashFirstMessage } = await import(
      "../src/components/channels/transcript-messages"
    );
    const channelId = "channel_retry-live";
    // The compose screen's hand-off: the channel route sends this the moment it is up.
    stashFirstMessage(channelId, QUESTION);
    const server = turnServer({ channelId });
    // The front door, answering for an API process that is not there.
    server.doorDown();
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });

    /*
     * The server never got it, so it is kept on this device and drawn as not sent — not as a
     * failed turn, and not as the model's fault (UI/UX audit 0.5.3, item 6).
     */
    await view.waitFor(
      () => view.host.querySelector(unsentLine) !== null,
      "the not-sent line under the question",
      8000,
    );
    const line = view.host.querySelector(unsentLine);
    expect(line?.textContent).toContain("Not sent");
    expect(line?.textContent).not.toContain(
      "The Bot could not reach its model.",
    );
    expect(view.host.querySelector(failed)).toBeNull();
    expect(ko["Not sent"]).toBe("보내지 못함");
    const again = [...(line?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Send again",
    );
    expect(again).toBeDefined();
    expect(server.sends).toHaveLength(1);

    server.doorUp();
    await view.click(again as Element);
    await view.waitFor(
      () => server.sends.length === 2 && server.turn() !== null,
      "the question handed over again",
      8000,
    );
    await answers(server, ANSWER);
    await view.waitFor(
      () => bubblesSaying(view.host, ANSWER) === 1,
      "the answer to the question sent again",
      8000,
    );

    const [first, second] = server.sends;
    const asked = askedIn(first);
    expect(asked.map((message) => message.content)).toEqual([QUESTION]);
    // WHAT THE SERVER IS HANDED ON THE RETRY: the question once, under the id it already had.
    expect(askedIn(second)).toEqual(asked);
    // And the person sees it once, with the answer, and nothing saying it went unsent.
    expect(bubblesSaying(view.host, QUESTION)).toBe(1);
    expect(view.host.querySelector(unsentLine)).toBeNull();
    expect(view.host.querySelector(failed)).toBeNull();
    server.close();
    await view.unmount();
  });
});

describe("다시 시도 under a failure the server recorded", () => {
  const question: Message = { id: "q-stored", role: "user", content: QUESTION };
  const failure = {
    messageId: question.id,
    code: "laf:turn_unreachable",
    at: "2026-09-10T05:18:20.000Z",
  };

  test("runs the thread again with the stored question, not a copy of it", async () => {
    const channelId = "channel_retry-stored";
    const server = turnServer({
      channelId,
      history: [
        {
          id: "q-earlier",
          role: "user",
          content: "오늘 날짜만 한 줄로 알려줘",
        },
        {
          id: "a-earlier",
          role: "assistant",
          content: "오늘은 9월 10일이에요.",
        },
        question,
      ],
      failures: [failure],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => view.buttonNamed("Try again") !== undefined,
      "the stored failure and its button",
      8000,
    );

    await view.click(view.buttonNamed("Try again") as Element);
    await view.waitFor(
      () => server.sends.length === 1 && server.turn() !== null,
      "the stored question handed over",
      8000,
    );
    await answers(server, ANSWER);
    await view.waitFor(
      () => bubblesSaying(view.host, ANSWER) === 1,
      "the answer",
      8000,
    );

    expect(server.sends).toHaveLength(1);
    // In place: the row the store already holds, under its own id — and nothing else.
    expect(server.sends[0]?.messages).toEqual([question]);
    expect(bubblesSaying(view.host, QUESTION)).toBe(1);
    // The server's record still holds the first failure; the answer after it retires the line.
    await view.waitFor(
      () => view.host.querySelector(failed) === null,
      "the failure line retired by the answer",
      8000,
    );
    server.close();
    await view.unmount();
  });

  test("offers nothing to press under a question somebody has asked past", async () => {
    const channelId = "channel_retry-moved-on";
    const server = turnServer({
      channelId,
      history: [
        question,
        { id: "q-later", role: "user", content: "그럼 내일은?" },
        { id: "a-later", role: "assistant", content: "내일은 9월 11일이에요." },
      ],
      failures: [failure],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => view.host.querySelector(failed) !== null,
      "the stored failure",
      8000,
    );
    // Still true that it went unanswered — and the only way to ask it now would be to say it twice.
    expect(view.buttonNamed("Try again")).toBeUndefined();
    server.close();
    await view.unmount();
  });

  test("under a task that died between two steps, is retired by the answer the retry brings", async () => {
    /*
     * MEASURED 2026-09-26 (0.5.5 QA): agent-bot killed after the Bot's search, before its next
     * step. The run's last row was the tool result, so the server keyed the failure there with the
     * question beside it; 다시 시도 ran the thread again in place and the answer came — and
     * "봇이 답하지 않았어요" stayed under it, read as a half answer waiting to be asked again.
     */
    const channelId = "channel_retry-mid-task";
    const called = {
      id: "a-called",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-now",
          type: "function",
          function: { name: "now", arguments: "{}" },
        },
      ],
    } as Message;
    const result = {
      id: "t-now",
      role: "tool",
      toolCallId: "call-now",
      content: '{"ok":true}',
    } as Message;
    const server = turnServer({
      channelId,
      history: [question, called, result],
      failures: [
        {
          messageId: result.id,
          code: "laf:turn_unreachable",
          askedId: question.id,
          at: "2026-09-26T00:35:37.619Z",
        },
      ],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => view.buttonNamed("Try again") !== undefined,
      "the stored failure under the task and its button",
      8000,
    );
    // Nothing of an answer had arrived, so nothing is marked as only part of one.
    expect(view.host.textContent).not.toContain("Received up to here");

    await view.click(view.buttonNamed("Try again") as Element);
    await view.waitFor(
      () => server.sends.length === 1 && server.turn() !== null,
      "the stored question handed over",
      8000,
    );
    await answers(server, ANSWER);
    await view.waitFor(
      () => bubblesSaying(view.host, ANSWER) === 1,
      "the answer",
      8000,
    );
    // Run again in place: the question once, under the id the store holds.
    expect(askedIn(server.sends[0]).map((message) => message.id)).toEqual([
      question.id,
    ]);
    expect(bubblesSaying(view.host, QUESTION)).toBe(1);
    await view.waitFor(
      () => view.host.querySelector(failed) === null,
      "the failure line retired by the answer",
      8000,
    );
    server.close();
    await view.unmount();
  });
});

/*
 * MEASURED 2026-09-24 (UI/UX audit 0.5.3, item 5): agent-bot stopped two seconds into a reply, and
 * "가게 마감" sat over "봇이 답하지 않았습니다. 지금 꺼져 있을 수 있습니다" with nothing to press, then
 * and after a reload. The button was drawn only under the person's own words, and with half an
 * answer in between, the failure is under the Bot's.
 */
describe("다시 시도 under the half of an answer", () => {
  const HALF = "가게 마감";
  const STOPPED =
    "The Bot stopped partway through. Try again and it answers from the start.";

  /** The compose screen's first message, handed to a server whose turn then dies half way. */
  async function halfAnswered(channelId: string) {
    const { stashFirstMessage } = await import(
      "../src/components/channels/transcript-messages"
    );
    stashFirstMessage(channelId, QUESTION);
    const server = turnServer({ channelId });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => server.sends.length === 1 && server.turn() !== null,
      "the question handed to the server",
      8000,
    );
    await halfThenGone(server, HALF);
    await view.waitFor(
      () => view.host.querySelector(failed) !== null,
      "the failure line under the half answer",
      8000,
    );
    return { server, view };
  }

  test("says what arrived is only part, and asks the question again below it", async () => {
    const { server, view } = await halfAnswered("channel_retry-half-live");
    // The Bot was reached — it said something — so "it did not answer" is not what is said.
    expect(view.host.querySelector(failed)?.textContent).toContain(STOPPED);
    expect(view.host.textContent).toContain("Received up to here");
    expect(ko[STOPPED]).toBe(
      "봇이 잠깐 멈췄어요. 다시 시도하면 처음부터 답해요.",
    );

    await view.click(view.buttonNamed("Try again") as Element);
    await view.waitFor(
      () => server.sends.length === 2 && server.turn()?.id === "turn-2",
      "the question handed over again",
      8000,
    );
    await answers(server, ANSWER);
    await view.waitFor(
      () => bubblesSaying(view.host, ANSWER) === 1,
      "the answer to the question asked again",
      8000,
    );
    // Asked again as what it is — a second asking, below the half answer — and not run over the
    // Bot's own half sentence, which not every provider accepts at the end of a thread.
    const [first] = askedIn(server.sends[0]);
    const [second] = askedIn(server.sends[1]);
    expect([first?.content, second?.content]).toEqual([QUESTION, QUESTION]);
    expect(second?.id).not.toBe(first?.id);
    expect(askedIn(server.sends[1])).toHaveLength(1);
    expect(view.host.querySelector(failed)).toBeNull();
    // What arrived the first time is still there. That it stays marked as only part comes from
    // the server's record of the failure, which this stub does not keep — the next test reads it.
    expect(bubblesSaying(view.host, HALF)).toBe(1);
    server.close();
    await view.unmount();
  });

  test("leaves the room read, as a turn that came back whole does", async () => {
    /*
     * MEASURED 2026-09-26 (0.5.5 QA): the read mark moved only for a turn that came back whole, so
     * a turn that failed or was stopped left it where the room had opened, and the next open drew
     * 읽지 않음 above the words the person had watched arrive.
     */
    const { server, view } = await halfAnswered("channel_retry-half-read");
    // Once as the room opened, and once more as the turn ended.
    await view.waitFor(
      () => server.reads.length >= 2,
      "the room marked read again when the turn ended",
      8000,
    );
    server.close();
    await view.unmount();
  });

  test("is there after a reload, from what the server recorded", async () => {
    const channelId = "channel_retry-half-stored";
    const question: Message = { id: "q-half", role: "user", content: QUESTION };
    const half: Message = { id: "a-half", role: "assistant", content: HALF };
    const server = turnServer({
      channelId,
      history: [question, half],
      failures: [
        {
          messageId: half.id,
          code: "laf:turn_bot_dropped",
          askedId: question.id,
          at: "2026-09-24T10:21:32.000Z",
        },
      ],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => view.buttonNamed("Try again") !== undefined,
      "the stored failure and its button",
      8000,
    );
    expect(view.host.textContent).toContain("Received up to here");

    await view.click(view.buttonNamed("Try again") as Element);
    await view.waitFor(
      () => server.sends.length === 1 && server.turn() !== null,
      "the question handed over again",
      8000,
    );
    await answers(server, ANSWER);
    await view.waitFor(
      () => bubblesSaying(view.host, ANSWER) === 1,
      "the answer",
      8000,
    );
    // A second asking, under an id of its own: the store keeps the first and its half answer.
    const [again] = askedIn(server.sends[0]);
    expect(again?.content).toBe(QUESTION);
    expect(again?.id).not.toBe(question.id);
    expect(bubblesSaying(view.host, QUESTION)).toBe(2);
    // Asked again below it: the record of the half answer stays, and the red line goes.
    await view.waitFor(
      () => view.host.querySelector(failed) === null,
      "the failure line retired by the answer",
      8000,
    );
    expect(view.host.textContent).toContain("Received up to here");
    server.close();
    await view.unmount();
  });

  test("offers nothing under a routine's heading, which nobody asked", async () => {
    const channelId = "channel_retry-routine";
    const server = turnServer({
      channelId,
      history: [
        {
          id: "q-earlier",
          role: "user",
          content: "오늘 날짜만 한 줄로 알려줘",
        },
        {
          id: "a-earlier",
          role: "assistant",
          content: "오늘은 9월 24일이에요.",
        },
        { id: "routine-head", role: "assistant", content: "**아침 브리핑**" },
      ],
      // The server names no question for a run on a clock.
      failures: [
        {
          messageId: "routine-head",
          code: "laf:turn_timed_out",
          at: "2026-09-24T07:30:00.000Z",
        },
      ],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => view.host.querySelector(failed) !== null,
      "the routine's failure line",
      8000,
    );
    expect(view.buttonNamed("Try again")).toBeUndefined();
    expect(view.host.textContent).not.toContain("Received up to here");
    server.close();
    await view.unmount();
  });
});
