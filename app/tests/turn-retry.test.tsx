import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
  answering,
  channelServer,
  type WireMessage,
} from "./support/channel-server";

/**
 * 다시 시도 UNDER A FAILED QUESTION ASKS IT AGAIN WITHOUT SAYING IT TWICE.
 *
 * MEASURED 2026-09-10 (audit A4, finding 1): with the API stopped, "지금 몇 시야" got the red line and
 * the button; with the API back, the button put a SECOND "지금 몇 시야" into the thread — two
 * bubbles on screen, and in `GET /api/copilotkit/threads/:id/messages` two user rows under one
 * answer, which every later prompt then read as a person asking twice.
 *
 * The real channel route, with the server stubbed at the network edge (`support/channel-server`).
 * What a retry sends is read off the run request — the thread as the server receives it. The
 * server's store keys messages by id (`appendMessages`), so the same question under the same id is
 * an edit of the row it already holds, and the same words under a new id are a second row.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
// Longer than the longest wait below, so a screen that never gets there fails with what it was
// waiting for rather than with the runner's own five seconds.
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const QUESTION = "지금 몇 시야";
const ANSWER = "오후 2시 10분경입니다.";

const failed = '[data-testid="transcript-stopped"]';

const userMessages = (messages: readonly WireMessage[] = []) =>
  messages.filter((message) => message.role === "user");

/** How many bubbles in the transcript say exactly these words: what a person counts. */
const bubblesSaying = (host: HTMLElement, words: string) =>
  [
    ...host.querySelectorAll('[role="log"] [data-slot="bubble-content"]'),
  ].filter((bubble) => bubble.textContent?.trim() === words).length;

describe("다시 시도 after the server could not be reached", () => {
  test("asks the same message again, once, and the answer lands under it", async () => {
    const { stashFirstMessage } = await import(
      "../src/components/channels/transcript-messages"
    );
    const channelId = "channel_retry-live";
    // The compose screen's hand-off: the channel route sends this the moment it is up.
    stashFirstMessage(channelId, QUESTION);
    const server = channelServer({
      channelId,
      runs: [
        // The front door, answering for an API process that is not there.
        () => new Response("Bad Gateway", { status: 502 }),
        answering(ANSWER),
      ],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });

    await view.waitFor(
      () => view.host.querySelector(failed) !== null,
      "the failure line under the question",
      8000,
    );
    const line = view.host.querySelector(failed);
    // The server is what was missing, and the line says so — not that the model failed.
    expect(line?.textContent).toContain("Cannot reach the server.");
    expect(line?.textContent).not.toContain(
      "The Bot could not reach its model.",
    );
    expect(ko["Cannot reach the server."]).toBe("서버에 닿지 못했습니다.");
    const retry = [...(line?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Try again",
    );
    expect(retry).toBeDefined();

    await view.click(retry as Element);
    await view.waitFor(
      () => server.runs.length === 2 && bubblesSaying(view.host, ANSWER) === 1,
      "the answer to the retried question",
      8000,
    );

    const [first, second] = server.runs;
    const asked = userMessages(first?.messages);
    expect(asked.map((message) => message.content)).toEqual([QUESTION]);
    // THE THREAD THE SERVER RECEIVES ON THE RETRY: the question once, under the id it already had.
    expect(userMessages(second?.messages)).toEqual(asked);
    // And the person sees it once, with the answer, and no line saying it went unanswered.
    expect(bubblesSaying(view.host, QUESTION)).toBe(1);
    expect(view.host.querySelector(failed)).toBeNull();
    await view.unmount();
  });
});

describe("다시 시도 under a failure the server recorded", () => {
  const question = { id: "q-stored", role: "user", content: QUESTION };
  const failure = {
    messageId: question.id,
    code: "laf:turn_unreachable",
    at: "2026-09-10T05:18:20.000Z",
  };

  test("runs the thread again with the stored question, not a copy of it", async () => {
    const channelId = "channel_retry-stored";
    const server = channelServer({
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
          content: "오늘은 9월 10일입니다.",
        },
        question,
      ],
      failures: [failure],
      runs: [answering(ANSWER)],
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
      () => bubblesSaying(view.host, ANSWER) === 1,
      "the answer",
      8000,
    );

    expect(server.runs).toHaveLength(1);
    expect(
      userMessages(server.runs[0]?.messages).map((message) => message.id),
    ).toEqual(["q-earlier", "q-stored"]);
    expect(bubblesSaying(view.host, QUESTION)).toBe(1);
    // The server's record still holds the first failure; the answer after it retires the line.
    expect(view.host.querySelector(failed)).toBeNull();
    await view.unmount();
  });

  test("is still there after a reload, though the runtime's memory ends before it", async () => {
    /*
     * MEASURED 2026-09-13 against a running stack: agent-bot stopped, "지금 몇 분이야" sent — the API
     * stored it and recorded the failure — and after a reload the question was gone from the screen,
     * and the line and the button with it. Joining replays the runtime's last run from memory, the one
     * BEFORE the failure, and the stored history was only ever applied to an agent with no messages.
     */
    const channelId = "channel_retry-reload";
    const earlier = {
      id: "q-earlier",
      role: "user",
      content: "오늘 날짜만 한 줄로 알려줘",
    };
    const server = channelServer({
      channelId,
      replay: {
        runId: "run-earlier",
        asked: [earlier],
        answer: "오후 5시 42분이에요.",
      },
      history: [
        earlier,
        {
          id: "msg_run-earlier",
          role: "assistant",
          content: "오후 5시 42분이에요.",
        },
        question,
      ],
      failures: [failure],
      runs: [answering(ANSWER)],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => view.buttonNamed("Try again") !== undefined,
      "the stored question, its failure and its button",
      8000,
    );
    expect(bubblesSaying(view.host, QUESTION)).toBe(1);

    await view.click(view.buttonNamed("Try again") as Element);
    await view.waitFor(
      () => bubblesSaying(view.host, ANSWER) === 1,
      "the answer",
      8000,
    );
    expect(
      userMessages(server.runs[0]?.messages).map((message) => message.id),
    ).toEqual(["q-earlier", "q-stored"]);
    await view.unmount();
  });

  test("offers nothing to press under a question somebody has asked past", async () => {
    const channelId = "channel_retry-moved-on";
    const server = channelServer({
      channelId,
      history: [
        question,
        { id: "q-later", role: "user", content: "그럼 내일은?" },
        { id: "a-later", role: "assistant", content: "내일은 9월 11일입니다." },
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
    await view.unmount();
  });
});
