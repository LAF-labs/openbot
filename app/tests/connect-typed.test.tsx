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
  type ApiRequest,
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
  acted,
  askedIn,
  BOT_ID,
  installTurnStreams,
  removeTurnStreams,
  THREAD_ID,
  turnServer,
} from "./support/turn-server";

/**
 * WHAT IS TYPED WHILE THE BOT WAITS ON A CONNECT CARD MEANS "NOT NOW".
 *
 * A connect card became the Bot's usual answer to "오늘 일정 뭐 있어?" from a person with no
 * calendar connected (2026-10-05), and the turn waits on it until a switch is on, 다음에 is pressed,
 * or ten minutes pass. Typed under it, "됐고, 날씨 알려줘" was parked — "보낼 예정 · 지금 일이 끝나면
 * 전해요" — behind a job that ends only when the card is answered: somebody who ignored the card
 * and asked for something else sat waiting for a card they had no interest in (read off this test
 * before the change: nothing reached the card's door, and the words waited).
 *
 * So the card is told "not now" — the same door 다음에 goes through — and the words go when the
 * turn is over, which is now. Mounted at the network edge, like the choice card's test
 * (`choice-answer.test.tsx`): the turn is the server's, it stops on the card, and what the page
 * sends to the card's door is what ends the wait.
 */

/** Under words that are kept until the turn is over: 보낼 예정 · 지금 일이 끝나면 전해요. */
const WAITS = "Sends when the current job is done";
const CHANNEL = "channel_connect";
const CALL = "call-connect-1";
const TYPED = "됐고, 날씨 알려줘";
const ASKED: Message = {
  id: "q-1",
  role: "user",
  content: "오늘 일정 뭐 있어?",
};
const CARD = {
  id: "a-connect",
  role: "assistant",
  content: "일정을 보려면 캘린더 연결이 필요해요.",
  toolCalls: [
    {
      id: CALL,
      type: "function",
      function: {
        name: "showConnection",
        arguments: JSON.stringify({ services: ["google-calendar"] }),
      },
    },
  ],
} as Message;

beforeAll(async () => {
  await installAppDom();
  installTurnStreams();
  (
    window as unknown as {
      happyDOM: { setWindowSize(size: { width: number }): void };
    }
  ).happyDOM.setWindowSize({ width: 1400 });
}, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
  localStorage.clear();
  // What one test kept on the device is not the next test's to find.
  const outbox = await import("../src/components/channels/composer/outbox");
  outbox.forgetUnsentCache();
});
setDefaultTimeout(30_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

function server() {
  const turns = turnServer({
    channelId: CHANNEL,
    history: [ASKED],
    turn: { id: "turn-1", status: "running", asked: [ASKED.id] },
    turnMessages: [ASKED],
  });
  const api = (request: ApiRequest) => {
    if (request.pathname === "/api/agents") {
      return json({
        agents: [agentFixture({ id: BOT_ID, name: "닻", mine: true })],
      });
    }
    if (request.pathname === "/api/channels") {
      return json({
        channels: [
          {
            id: CHANNEL,
            name: "닻",
            agentIds: [BOT_ID],
            threadId: THREAD_ID,
            active: true,
            unread: false,
          },
        ],
      });
    }
    if (request.pathname === `/api/components/for-agent/${BOT_ID}`) {
      return json({
        components: [
          { name: "showConnection", description: "Connection switches." },
        ],
      });
    }
    return turns.api(request);
  };
  return { api, turns };
}

type View = Awaited<ReturnType<typeof mountApp>>;

/** The Bot stops on its connect card, and every window is told the turn waits on it. */
async function raise(view: View, turns: ReturnType<typeof turnServer>) {
  await acted(() => {
    turns.say([CARD]);
    turns.waitOn([CALL]);
  });
  // The card itself is not drawn under `bun test` (the gallery is found with Vite's glob): the
  // call is a step line, and what is tested here is where the typed words go.
  await view.waitFor(
    () => view.host.querySelector('[role="log"]')?.children.length !== 0,
    "the call's line",
    6000,
  );
  await view.settle(60);
}

/** Typed, and sent by the composer's own button — which, mid-turn, says it queues. */
async function typeAndQueue(view: View, words: string) {
  const { offerDraft } = await import(
    "../src/components/channels/composer/prefill"
  );
  await acted(() => offerDraft(CHANNEL, words));
  await view.waitFor(
    () =>
      (
        view.host.querySelector('[aria-label="Message"]')?.textContent ?? ""
      ).trim() === words,
    "the words in the composer",
    4000,
  );
  const queue = view.host.querySelector('button[aria-label="Queue message"]');
  if (!queue) throw new Error("no queue button");
  await view.click(queue);
}

/** What the device keeps of this conversation, as it is stored. */
const kept = () =>
  JSON.parse(localStorage.getItem(`laf:unsent:${CHANNEL}`) ?? "[]") as {
    text: string;
    answerTo?: string;
    waiting?: boolean;
  }[];

describe("words typed while the Bot waits on a connect card", () => {
  test("tell the card not now, and go as the next message when the turn is over", async () => {
    const { api, turns } = server();
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await raise(view, turns);

    await typeAndQueue(view, TYPED);
    await view.waitFor(
      () => turns.answers().length === 1,
      "the card's door to be told not now",
      4000,
    );
    // The same door 다음에 goes through, for this card's call. The server reads 연결 for itself
    // once anything answers, so what is sent says only that the person is not connecting now.
    expect(turns.answers()).toEqual([
      { toolCallId: CALL, value: { code: "laf:connection_off" } },
    ]);
    // The words are a message typed mid-turn — never the card's answer — and wait for the turn.
    await view.settle(100);
    expect(kept()).toMatchObject([{ text: TYPED, waiting: true }]);
    expect(kept()[0]?.answerTo).toBeUndefined();
    expect(view.host.textContent).toContain(WAITS);
    expect(turns.sends).toHaveLength(0);

    // The Bot says its piece about not connecting, the turn ends, and the words go.
    await acted(() => turns.announce("done"));
    await view.waitFor(
      () => turns.sends.length === 1,
      "the words to go once the turn is over",
      4000,
    );
    expect(askedIn(turns.sends[0]).map((message) => message.content)).toEqual([
      TYPED,
    ]);
    // Told once: the door was not asked again for the same card.
    expect(turns.asks()).toBe(1);
  });

  test("that the door did not take still wait for the turn, as they always did", async () => {
    const { api, turns } = server();
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await raise(view, turns);
    turns.answersDown();

    await typeAndQueue(view, TYPED);
    await view.waitFor(() => turns.asks() === 1, "the door to be asked", 4000);
    await view.settle(200);
    expect(turns.answers()).toHaveLength(0);
    expect(kept()).toMatchObject([{ text: TYPED, waiting: true }]);
    expect(view.host.textContent).toContain(WAITS);

    // The card's wait ends some other way — 다음에, a switch, its ten minutes — and they go.
    await acted(() => turns.announce("done"));
    await view.waitFor(
      () => turns.sends.length === 1,
      "the words to go once the turn is over",
      4000,
    );
    expect(askedIn(turns.sends[0]).map((message) => message.content)).toEqual([
      TYPED,
    ]);
  });
});
