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
  type ApiRequest,
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { BOT_ID, THREAD_ID } from "./support/channel-server";
import {
  acted,
  askedIn,
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * WHAT IS TYPED WHILE THE BOT WAITS ON A CHOICE IS THE ANSWER.
 *
 * Pressed on the running app, 2026-10-02. Asked to help pick dinner, the Bot put up a card — 한식,
 * 중식, 양식, "답을 기다려요". None fitted, so the natural thing was typed: "셋 다 말고 냉면 먹고
 * 싶어". The composer's button read "메시지 대기열에 넣기", and the words were parked under the card:
 * "보낼 예정 · 지금 일이 끝나면 전해요" — behind a job that ends only when the card is answered. The
 * way out was 멈추고 이걸로, which stops the turn. And after that stop the card went on saying 답을
 * 기다려요, with three buttons that did nothing when pressed.
 *
 * Mounted at the network edge: the turn is the server's, it stops on the card, and what the page
 * sends to the card's door is what the Bot is answered with.
 */

/** The line under words that did not go: 보내지 못함, with 다시 보내기. Its words, never the element. */
const unsentLine = '[data-testid="transcript-unsent"]';
const isNotSent = (host: HTMLElement) =>
  host.querySelector(unsentLine) !== null;

/** Under words that are kept until the turn is over: 보낼 예정 · 지금 일이 끝나면 전해요. */
const WAITS = "Sends when the current job is done";
const CHANNEL = "channel_choice";
const CALL = "call-choice-1";
const ASKED: Message = {
  id: "q-1",
  role: "user",
  content: "오늘 저녁 메뉴 고르는 걸 도와줘",
};
const QUESTION = {
  id: "a-choice",
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id: CALL,
      type: "function",
      function: {
        name: "askChoice",
        arguments: JSON.stringify({
          title: "오늘 저녁 메뉴",
          options: [
            { id: "korean", label: "한식" },
            { id: "chinese", label: "중식" },
          ],
        }),
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
  (await import("../src/lib/turns/typed-answer")).setFirstRest();
});

/**
 * How long words rest before they are offered to their card again. Half a second in the app: a
 * test that must see the next offer sets it short, and one that must not see it — because
 * something else is what should send them — sets it past its own end.
 */
async function restFor(ms: number) {
  (await import("../src/lib/turns/typed-answer")).setFirstRest(ms);
}
const NEVER_IN_THIS_TEST = 600_000;
setDefaultTimeout(30_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

/**
 * A conversation whose Bot may ask with a choice card, in the middle of a turn. `record` is what
 * a test says differently of the store: what it holds, and how many messages it answers a page.
 */
function server(
  record: {
    history?: Message[];
    turnMessages?: Message[];
    historyPage?: number;
  } = {},
) {
  const turns = turnServer({
    channelId: CHANNEL,
    history: [ASKED],
    turn: { id: "turn-1", status: "running", asked: [ASKED.id] },
    turnMessages: [ASKED],
    ...record,
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
        components: [{ name: "askChoice", description: "Ask the person." }],
      });
    }
    return turns.api(request);
  };
  return { api, turns };
}

type View = Awaited<ReturnType<typeof mountApp>>;

const composerButton = (host: HTMLElement) =>
  ["Send message", "Queue message"].find((name) =>
    host.querySelector(`button[aria-label="${name}"]`),
  );

/** The Bot stops on its question, and every window is told the turn waits on it. */
async function ask(view: View, turns: ReturnType<typeof turnServer>) {
  await acted(() => {
    turns.say([QUESTION]);
    turns.waitOn([CALL]);
  });
  /*
   * The card itself is not drawn under `bun test`: the gallery is found with Vite's
   * `import.meta.glob` (`gallery-registry.ts`), which is not there, so the call is a plain step
   * line. What is tested here is where the typed words go; the card's own states are drawn in
   * `choice-card.test.tsx`.
   */
  await view.waitFor(
    () => view.host.querySelector('[role="log"]')?.children.length !== 0,
    "the call's line",
    6000,
  );
  await view.settle(60);
}

async function type(view: View, words: string) {
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
}

describe("words typed while the Bot waits on a choice", () => {
  test("are sent as the answer to it, by a button that says it sends", async () => {
    const { api, turns } = server();
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await ask(view, turns);

    await type(view, "둘 다 말고 냉면");
    expect(composerButton(view.host)).toBe("Send message");
    const send = view.host.querySelector('button[aria-label="Send message"]');
    if (!send) throw new Error("no send button");
    await view.click(send);

    await view.waitFor(
      () => turns.answers().length === 1,
      "the answer to reach the card's door",
      4000,
    );
    expect(turns.answers()).toEqual([
      { toolCallId: CALL, value: { answer: "둘 다 말고 냉면" } },
    ]);
    // Nothing was parked behind the question it answers.
    expect(view.host.textContent).not.toContain(WAITS);
    expect(turns.sends).toHaveLength(0);
  });

  /*
   * The installed app's window is a webview whose engine is the system's, and some of them have
   * no `AbortSignal.timeout`. The door's wait was built with it: the call threw before the
   * request was made, that read as "nothing came back", and the words were offered again and
   * again and never sent (review, eighth round).
   */
  test("reach the card's door on a webview that has no AbortSignal.timeout", async () => {
    const signals = AbortSignal as unknown as { timeout?: unknown };
    const timeout = signals.timeout;
    signals.timeout = undefined;
    try {
      const { api, turns } = server();
      const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
      await ask(view, turns);
      await type(view, "둘 다 말고 냉면");
      const send = view.host.querySelector('button[aria-label="Send message"]');
      if (!send) throw new Error("no send button");
      await view.click(send);
      await view.waitFor(
        () => turns.answers().length === 1,
        "the answer to reach the card's door",
        4000,
      );
    } finally {
      signals.timeout = timeout;
    }
  });

  /** The words go out by the composer's own button, which says it sends. */
  async function sendWords(view: View, words: string) {
    await type(view, words);
    const send = view.host.querySelector('button[aria-label="Send message"]');
    if (!send) throw new Error("no send button");
    await view.click(send);
  }
  const TYPED = "둘 다 말고 냉면";
  /** What the device keeps of this conversation, as it is stored. */
  const kept = () =>
    JSON.parse(localStorage.getItem(`laf:unsent:${CHANNEL}`) ?? "[]") as {
      text: string;
      answerTo?: string;
      askedBy?: string;
      waiting?: boolean;
    }[];
  const answeredWith = (words: string) =>
    ({
      id: "r-choice",
      role: "tool",
      toolCallId: CALL,
      content: JSON.stringify({ answer: words }),
    }) as Message;

  /*
   * KEPT FIRST, THEN OFFERED. The door was asked before anything was kept: a page reloaded while
   * it was slow had the words nowhere (adversarial read of this change).
   */
  test("are on the device before the door has answered", async () => {
    const { api, turns } = server();
    let letDoorAnswer = () => {};
    const slowDoor = (request: ApiRequest) => {
      if (request.method === "POST" && request.pathname.includes("/answers/")) {
        return new Promise<void>((resolve) => {
          letDoorAnswer = resolve;
        }).then(() => api(request) as Response);
      }
      return api(request);
    };
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api: slowDoor });
    await ask(view, turns);

    await sendWords(view, TYPED);
    await view.settle(100);
    expect(kept()).toMatchObject([{ text: TYPED, answerTo: CALL }]);
    // On their way to the card: not drawn as waiting for the turn to end.
    expect(view.host.textContent).not.toContain(WAITS);

    await acted(() => letDoorAnswer());
    await view.waitFor(
      () => turns.answers().length === 1,
      "the answer to reach the card's door",
      4000,
    );
  });

  /*
   * The wait ran out in the instant before this window heard of it: the door says nothing waits
   * on that call. They are words typed mid-turn, and go when the turn is over.
   */
  test("that the question would no longer take wait for the turn, and go when it is over", async () => {
    const { api, turns } = server();
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await ask(view, turns);
    turns.stopWaitingUnheard();

    await sendWords(view, TYPED);
    await view.waitFor(
      () => turns.asks() === 1,
      "the door to refuse them",
      4000,
    );
    await view.settle(200);
    // Still the card's until the conversation says what became of its question: on it, and not
    // under it as waiting for the Bot.
    expect(view.host.textContent).not.toContain(WAITS);
    expect(kept()).toMatchObject([{ text: TYPED, answerTo: CALL }]);
    expect(turns.answers()).toHaveLength(0);
    expect(turns.sends).toHaveLength(0);

    // What the window had not heard arrives: the card waits no more, and its call says nobody
    // answered. The question is over, and these are words typed mid-turn.
    await acted(() => turns.waitRanOut(CALL));
    await view.settle(200);
    expect(kept()).toMatchObject([{ text: TYPED, waiting: true }]);
    expect(kept()[0]?.answerTo).toBeUndefined();
    expect(turns.sends).toHaveLength(0);

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

  /*
   * The turn can end while the answer is on its way — stopped in another window, a failure — and
   * the word that it ended reaches the page before the door's refusal does. What sends the words
   * kept behind a turn is that turn ending, and it had: they were parked after it, under "보낼
   * 예정 · 지금 일이 끝나면 전해요" with no job to end (adversarial read of this change).
   */
  test("go as the message they are when the turn ended while the answer was on its way", async () => {
    const { api, turns } = server();
    const stoppedElsewhere = (request: ApiRequest) => {
      if (request.method === "POST" && request.pathname.includes("/answers/")) {
        // Every window hears that the turn was stopped, and then the door refuses the answer.
        turns.stopWaiting();
        turns.announce("stopped");
      }
      return api(request);
    };
    const view = await mountApp({
      path: `/channel/${CHANNEL}`,
      api: stoppedElsewhere,
    });
    await ask(view, turns);

    await sendWords(view, TYPED);
    await view.waitFor(
      () => turns.sends.length === 1,
      "the words to go as a message",
      4000,
    );
    expect(askedIn(turns.sends[0]).map((message) => message.content)).toEqual([
      TYPED,
    ]);
    expect(turns.answers()).toHaveLength(0);
    await view.settle(200);
    expect(view.host.textContent).not.toContain(WAITS);
  });

  /*
   * Review, first round. "Not taken" was both the server's no and nothing coming back at all, and
   * with nothing back the answer may have been taken: sent again as a message it is said twice.
   * What became of such words is decided in one place, from the conversation.
   */
  describe("with nothing back from the door", () => {
    test("wait, are not handed over, and are offered to the card again when the connection is back", async () => {
      // Not by the wait: what offers them again here is the connection coming back.
      await restFor(NEVER_IN_THIS_TEST);
      const { api, turns } = server();
      const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
      await ask(view, turns);
      turns.answersDown();

      await sendWords(view, TYPED);
      await view.waitFor(() => turns.asks() >= 1, "the door asked", 4000);
      await view.settle(300);
      // On the card, which takes no press meanwhile — not under it as waiting.
      expect(view.host.textContent).not.toContain(WAITS);
      expect(isNotSent(view.host)).toBe(false);
      expect(turns.sends).toHaveLength(0);
      expect(turns.answers()).toHaveLength(0);
      expect(kept()).toMatchObject([{ text: TYPED, answerTo: CALL }]);

      // The connection comes back while the question still waits: nobody has to press anything.
      turns.answersUp();
      await acted(() => {
        window.dispatchEvent(new Event("online"));
      });
      await view.waitFor(
        () => turns.answers().length === 1,
        "the answer to reach the card's door",
        4000,
      );
      expect(turns.answers()).toEqual([
        { toolCallId: CALL, value: { answer: TYPED } },
      ]);
      await view.settle(200);
      expect(view.host.textContent).not.toContain(WAITS);
      expect(turns.sends).toHaveLength(0);
    });

    // Review, fourth round: a 503 from the door with the stream healthy is no connection coming
    // back, and nothing offered such words again until the question ran out.
    test("are offered to the card again after a wait, with no connection lost or returned", async () => {
      await restFor(40);
      const { api, turns } = server();
      const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
      await ask(view, turns);
      turns.answersDown();

      await sendWords(view, TYPED);
      await view.waitFor(() => turns.asks() >= 1, "the door asked", 4000);
      expect(turns.answers()).toHaveLength(0);
      /*
       * Asked again and again while it is down, with the words on their card the whole time. They
       * used to leave the list of waiting words for every offer and come back when it failed: a
       * blink on each retry, and the transcript pulled to the end each time (adversarial read,
       * 2026-10-03). Since the thirteenth round they are never on that list at all.
       */
      let isWaitingAtAnyTime = false;
      const watch = new MutationObserver(() => {
        if (view.host.textContent?.includes(WAITS)) isWaitingAtAnyTime = true;
      });
      watch.observe(view.host, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      await view.waitFor(() => turns.asks() >= 4, "the door asked again", 4000);
      watch.disconnect();
      expect(isWaitingAtAnyTime).toBe(false);

      // The door is there again. Nothing tells the page so: it asks again by itself.
      turns.answersUp();
      await view.waitFor(
        () => turns.answers().length === 1,
        "the answer to reach the card's door by itself",
        4000,
      );
      expect(turns.answers()).toEqual([
        { toolCallId: CALL, value: { answer: TYPED } },
      ]);
      expect(turns.sends).toHaveLength(0);
    });

    test("a second answer typed for the same card takes the first one's place", async () => {
      // Nothing came back for the first, so the second rests before it goes (twelfth round):
      // the door stays down until it has been typed, and the first is not taken meanwhile.
      await restFor(40);
      const { api, turns } = server();
      const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
      await ask(view, turns);
      turns.answersDown();

      await sendWords(view, TYPED);
      await view.waitFor(() => kept().length === 1, "the first kept", 4000);
      await sendWords(view, "아니, 그냥 비빔밥");
      turns.answersUp();
      await view.waitFor(
        () => turns.answers().length === 1,
        "the second answer to reach the card's door",
        4000,
      );
      expect(turns.answers()).toEqual([
        { toolCallId: CALL, value: { answer: "아니, 그냥 비빔밥" } },
      ]);
      expect(kept().map((message) => message.text)).toEqual([
        "아니, 그냥 비빔밥",
      ]);
    });

    /*
     * Two answers out at once, and the server takes whichever reaches it first: the first could
     * win, and the one meant to take its place was refused and then sent after the turn as a
     * message of its own (review, tenth round). The second waits for the first's answer.
     */
    describe("a second answer typed while the first is still on its way", () => {
      /**
       * A door that holds the first request until the test lets it answer: `taken`; `refused`
       * (nothing waits, says the server); `lost` (it never reached the server, and the window
       * hears nothing it can read); or `taken unheard` (the server took it, and the window heard
       * nothing it can read).
       */
      type Release = "taken" | "refused" | "lost" | "taken unheard";
      function holdingDoor(api: ReturnType<typeof server>["api"]) {
        let release = (_answer: Release) => {};
        let asked = 0;
        const door = (
          request: ApiRequest,
        ): ReturnType<typeof api> | Promise<Response> => {
          if (
            request.method !== "POST" ||
            !request.pathname.includes("/answers/")
          ) {
            return api(request);
          }
          asked += 1;
          if (asked > 1) return api(request);
          return new Promise<Release>((resolve) => {
            release = resolve;
          }).then((answer) => {
            if (answer === "taken") return api(request) as Response;
            if (answer === "refused") {
              return json({ code: "laf:no_longer_waiting" }, 409);
            }
            if (answer === "taken unheard") api(request);
            return new Response("", { status: 503 });
          });
        };
        return {
          door,
          release: (answer: Release) => release(answer),
          asked: () => asked,
        };
      }

      test("waits for it: where the door took the first, the second is what the person says next", async () => {
        await restFor(NEVER_IN_THIS_TEST);
        const { api, turns } = server();
        const { door, release, asked } = holdingDoor(api);
        const view = await mountApp({ path: `/channel/${CHANNEL}`, api: door });
        await ask(view, turns);

        await sendWords(view, TYPED);
        await view.waitFor(() => asked() === 1, "the first at the door", 4000);
        await sendWords(view, "아니, 그냥 비빔밥");
        await view.settle(200);
        // Not sent beside the first.
        expect(asked()).toBe(1);

        await acted(() => release("taken"));
        await view.waitFor(
          () => kept()[0]?.answerTo === undefined,
          "the second kept as words for after the turn",
          4000,
        );
        await view.settle(200);
        expect(asked()).toBe(1);
        expect(turns.answers()).toEqual([
          { toolCallId: CALL, value: { answer: TYPED } },
        ]);
        expect(kept().map((message) => message.text)).toEqual([
          "아니, 그냥 비빔밥",
        ]);
        expect(view.host.textContent).toContain(WAITS);
      });

      /*
       * Waiting on the first alone, a third answer went out beside the first while the second
       * waited, and the second — replaced by then — was still offered when the first came back
       * (review, eleventh round).
       */
      test("a third waits behind the second, and the second, replaced, is offered nowhere", async () => {
        await restFor(NEVER_IN_THIS_TEST);
        const { api, turns } = server();
        const { door, release, asked } = holdingDoor(api);
        const view = await mountApp({ path: `/channel/${CHANNEL}`, api: door });
        await ask(view, turns);

        await sendWords(view, TYPED);
        await view.waitFor(() => asked() === 1, "the first at the door", 4000);
        await sendWords(view, "아니, 그냥 비빔밥");
        await sendWords(view, "아니다, 냉면 맞아");
        await view.settle(200);
        expect(asked()).toBe(1);

        await acted(() => release("refused"));
        await view.waitFor(
          () => turns.answers().length === 1,
          "the latest words to reach the card's door",
          4000,
        );
        await view.settle(300);
        expect(asked()).toBe(2);
        expect(turns.answers()).toEqual([
          { toolCallId: CALL, value: { answer: "아니다, 냉면 맞아" } },
        ]);
        expect(kept().map((message) => message.text)).toEqual([
          "아니다, 냉면 맞아",
        ]);
      });

      test("and where the first was taken, only the latest is kept, as what is said next", async () => {
        await restFor(NEVER_IN_THIS_TEST);
        const { api, turns } = server();
        const { door, release, asked } = holdingDoor(api);
        const view = await mountApp({ path: `/channel/${CHANNEL}`, api: door });
        await ask(view, turns);

        await sendWords(view, TYPED);
        await view.waitFor(() => asked() === 1, "the first at the door", 4000);
        await sendWords(view, "아니, 그냥 비빔밥");
        await sendWords(view, "아니다, 냉면 맞아");
        await acted(() => release("taken"));
        await view.waitFor(
          () => kept().length === 1 && kept()[0]?.answerTo === undefined,
          "the latest kept as words for after the turn",
          4000,
        );
        await view.settle(300);
        expect(asked()).toBe(1);
        expect(kept().map((message) => message.text)).toEqual([
          "아니다, 냉면 맞아",
        ]);
      });

      /*
       * The first was taken, and its 200 came back only after the stream had ended the turn: the
       * correction was let go of its card with nothing left to send it (review, eleventh round).
       */
      test("let go of its card after the turn is over, it is sent then", async () => {
        await restFor(NEVER_IN_THIS_TEST);
        const { api, turns } = server();
        // The first request reaches the server when the test says, and its reply the window later.
        let toServer = () => {};
        let toWindow = () => {};
        let asked = 0;
        const door = (
          request: ApiRequest,
        ): ReturnType<typeof api> | Promise<Response> => {
          if (
            request.method !== "POST" ||
            !request.pathname.includes("/answers/")
          ) {
            return api(request);
          }
          asked += 1;
          if (asked > 1) return api(request);
          return new Promise<void>((resolve) => {
            toServer = resolve;
          }).then(() => {
            const reply = api(request) as Response;
            return new Promise<Response>((resolve) => {
              toWindow = () => resolve(reply);
            });
          });
        };
        const view = await mountApp({ path: `/channel/${CHANNEL}`, api: door });
        await ask(view, turns);

        await sendWords(view, TYPED);
        await view.waitFor(() => asked === 1, "the first at the door", 4000);
        await sendWords(view, "아니, 그냥 비빔밥");
        // The server takes the first, files it and ends the turn — before its reply arrives.
        await acted(() => toServer());
        await acted(() => turns.say([answeredWith(TYPED)]));
        await acted(() => turns.announce("done"));
        await view.settle(300);
        expect(turns.sends).toHaveLength(0);

        await acted(() => toWindow());
        await view.waitFor(
          () => turns.sends.length === 1,
          "the correction to go as a message",
          4000,
        );
        expect(
          askedIn(turns.sends[0]).map((message) => message.content),
        ).toEqual(["아니, 그냥 비빔밥"]);
      });

      test("and goes to the card in its place where the door refused the first", async () => {
        await restFor(NEVER_IN_THIS_TEST);
        const { api, turns } = server();
        const { door, release, asked } = holdingDoor(api);
        const view = await mountApp({ path: `/channel/${CHANNEL}`, api: door });
        await ask(view, turns);

        await sendWords(view, TYPED);
        await view.waitFor(() => asked() === 1, "the first at the door", 4000);
        await sendWords(view, "아니, 그냥 비빔밥");
        await view.settle(200);
        expect(asked()).toBe(1);

        await acted(() => release("refused"));
        await view.waitFor(
          () => turns.answers().length === 1,
          "the second to reach the card's door",
          4000,
        );
        expect(turns.answers()).toEqual([
          { toolCallId: CALL, value: { answer: "아니, 그냥 비빔밥" } },
        ]);
        expect(kept()).toMatchObject([
          { text: "아니, 그냥 비빔밥", answerTo: CALL },
        ]);
      });

      /*
       * The line at the door was one screen's, and the words are every window's: a screen that
       * left the conversation and came back offered them beside the request the old one still had
       * out, and so would a second window (review, thirteenth round). One at a time across
       * windows, by `navigator.locks`.
       */
      test("a screen that left and came back waits for the request the old one still has out", async () => {
        await restFor(NEVER_IN_THIS_TEST);
        // happy-dom has no `navigator.locks`: one lock manager for both screens, as a browser has.
        const lines = new Map<string, Promise<unknown>>();
        const locks = {
          request: (name: string, run: () => Promise<unknown>) => {
            const mine = (lines.get(name) ?? Promise.resolve()).then(run, run);
            lines.set(
              name,
              mine.catch(() => {}),
            );
            return mine;
          },
        };
        Object.defineProperty(navigator, "locks", {
          value: locks,
          configurable: true,
        });
        try {
          const { api, turns } = server();
          const { door, release, asked } = holdingDoor(api);
          const view = await mountApp({
            path: `/channel/${CHANNEL}`,
            api: door,
          });
          await ask(view, turns);
          await sendWords(view, TYPED);
          await view.waitFor(
            () => asked() === 1,
            "the first at the door",
            4000,
          );

          // Away to 소식 and back: a new screen, and the old one's request still out.
          await view.navigate("/feed");
          await view.navigate(`/channel/${CHANNEL}`);
          await view.settle(400);
          expect(asked()).toBe(1);

          await acted(() => release("taken"));
          await view.settle(400);
          expect(asked()).toBe(1);
          expect(turns.answers()).toEqual([
            { toolCallId: CALL, value: { answer: TYPED } },
          ]);
        } finally {
          Object.defineProperty(navigator, "locks", {
            value: undefined,
            configurable: true,
          });
        }
      });

      /*
       * Nothing came back for the first: it may have been taken — what "unknown" means. Read as
       * "not taken", the second went out while the first could still win the card (review,
       * twelfth round). It rests first, and goes once the card is seen still waiting.
       */
      test("where nothing came back for the first, it goes only once the card is seen still waiting", async () => {
        await restFor(400);
        const { api, turns } = server();
        const { door, release, asked } = holdingDoor(api);
        const view = await mountApp({ path: `/channel/${CHANNEL}`, api: door });
        await ask(view, turns);

        await sendWords(view, TYPED);
        await view.waitFor(() => asked() === 1, "the first at the door", 4000);
        await sendWords(view, "아니, 그냥 비빔밥");
        await acted(() => release("lost"));
        await view.settle(150);
        // Not at once: the first may yet be the card's answer.
        expect(asked()).toBe(1);
        await view.waitFor(
          () => turns.answers().length === 1,
          "the second to reach the card's door after its rest",
          4000,
        );
        expect(turns.answers()).toEqual([
          { toolCallId: CALL, value: { answer: "아니, 그냥 비빔밥" } },
        ]);
      });

      test("and where the first was taken after all, the second is what is said next", async () => {
        await restFor(40);
        const { api, turns } = server();
        const { door, release, asked } = holdingDoor(api);
        const view = await mountApp({ path: `/channel/${CHANNEL}`, api: door });
        await ask(view, turns);

        await sendWords(view, TYPED);
        await view.waitFor(() => asked() === 1, "the first at the door", 4000);
        await sendWords(view, "아니, 그냥 비빔밥");
        // The server takes the first and says the card waits no more; the window hears no reply.
        await acted(() => release("taken unheard"));
        await view.settle(400);
        expect(asked()).toBe(1);
        // The record files it: the card's answer is the first.
        await acted(() => turns.say([answeredWith(TYPED)]));
        await view.waitFor(
          () => kept().length === 1 && kept()[0]?.answerTo === undefined,
          "the second kept as words for after the turn",
          4000,
        );
        expect(asked()).toBe(1);
        expect(turns.answers()).toEqual([
          { toolCallId: CALL, value: { answer: TYPED } },
        ]);
        expect(kept().map((message) => message.text)).toEqual([
          "아니, 그냥 비빔밥",
        ]);
      });
    });

    test("go when the turn is over, as a message, where the question ended some other way", async () => {
      const { api, turns } = server();
      const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
      await ask(view, turns);
      turns.answersDown();

      await sendWords(view, TYPED);
      await view.waitFor(() => kept().length === 1, "the words kept", 4000);

      // Stopped: the call is answered with a code, and the turn is over.
      await acted(() => {
        turns.say([
          {
            id: "r-choice",
            role: "tool",
            toolCallId: CALL,
            content: JSON.stringify({ ok: false, code: "laf:stopped" }),
          } as Message,
        ]);
        turns.stopWaiting();
        turns.announce("stopped");
      });
      await view.waitFor(
        () => turns.sends.length === 1,
        "the words to go as a message",
        4000,
      );
      expect(askedIn(turns.sends[0]).map((message) => message.content)).toEqual(
        [TYPED],
      );
      expect(turns.answers()).toHaveLength(0);
    });

    /*
     * A refusal is offered again too, for as long as the stream names the card as waiting: it was
     * only what got nothing back that was, and a refusal sat under the card until its question
     * ran out (adversarial read, 2026-10-03).
     */
    test("that the door refused are offered again while the stream still names the card", async () => {
      await restFor(40);
      const { api, turns } = server();
      const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
      await ask(view, turns);
      turns.stopWaitingUnheard();

      await sendWords(view, TYPED);
      await view.waitFor(() => turns.asks() >= 3, "the door asked again", 4000);
      expect(turns.answers()).toHaveLength(0);
      expect(turns.sends).toHaveLength(0);
      expect(kept()).toMatchObject([{ text: TYPED, answerTo: CALL }]);
    });

    /*
     * THE TURN IS OVER AND NOTHING THIS WINDOW HOLDS SAYS WHAT BECAME OF THE QUESTION. A turn that
     * ends files a result for every call and says so, so this is a window that did not hear it —
     * asleep while the turn finished — or a server that died holding the question. The mark used
     * to come off and the words went by themselves: a window about to read the record, and find
     * them there as the card's answer, told the Bot the same thing twice.
     */
    describe("where the turn is over and nothing says what became of the question", () => {
      const sendAgain = (host: HTMLElement) =>
        host.querySelector(`${unsentLine} button`);

      test("are the person's to send: drawn as not sent, and sent by their press", async () => {
        await restFor(NEVER_IN_THIS_TEST);
        const { api, turns } = server();
        const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
        await ask(view, turns);
        turns.answersDown();

        await sendWords(view, TYPED);
        await view.waitFor(() => kept().length === 1, "the words kept", 4000);
        await acted(() => turns.announceUnheard("done"));
        await view.waitFor(
          () => isNotSent(view.host),
          "the words drawn as not sent",
          4000,
        );
        await view.settle(300);
        expect(turns.sends).toHaveLength(0);
        expect(view.host.textContent).not.toContain(WAITS);
        // Still marked for their card: the record may yet show them as its answer.
        expect(kept()).toMatchObject([{ text: TYPED, answerTo: CALL }]);
        expect(kept()[0]?.waiting).toBeUndefined();

        const press = sendAgain(view.host);
        if (!press) throw new Error("no press to send them");
        await view.click(press);
        await view.waitFor(
          () => turns.sends.length === 1,
          "the words to go as a message",
          4000,
        );
        expect(
          askedIn(turns.sends[0]).map((message) => message.content),
        ).toEqual([TYPED]);
      });

      test("and are forgotten, unsent, once the record shows them as the card's answer", async () => {
        await restFor(NEVER_IN_THIS_TEST);
        const { api, turns } = server();
        const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
        await ask(view, turns);
        turns.loseAnswerReply();

        await sendWords(view, TYPED);
        await view.waitFor(
          () => turns.answers().length === 1,
          "the door to take the answer",
          4000,
        );
        // The answer was filed and the turn went on to its end, and this window heard only the end.
        turns.file([answeredWith(TYPED)]);
        turns.holdHistory();
        await acted(() => turns.announceUnheard("done"));
        // Not theirs to send while the record is still being read for what became of the question.
        await view.settle(500);
        expect(isNotSent(view.host)).toBe(false);
        expect(kept()).toMatchObject([{ text: TYPED, waiting: true }]);
        // The read of the record that follows a turn's end brings what the stream did not.
        await acted(() => turns.answerHistory());
        await view.waitFor(
          () => kept().length === 0,
          "them to be forgotten",
          4000,
        );
        await view.settle(300);
        expect(turns.sends).toHaveLength(0);
        expect(isNotSent(view.host)).toBe(false);
      });

      /*
       * Review, sixth round. A window that slept is told the turn is over by a snapshot, before
       * anything has read what it missed: read off that moment, words the server had taken were
       * handed to the person as not sent — with the press that sends them again — until the page
       * arrived and forgot them.
       */
      test("but not before the record has been read, where the stream has just started over", async () => {
        await restFor(NEVER_IN_THIS_TEST);
        const { api, turns } = server();
        const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
        await ask(view, turns);
        turns.loseAnswerReply();

        await sendWords(view, TYPED);
        await view.waitFor(
          () => turns.answers().length === 1,
          "the door to take the answer",
          4000,
        );
        // The window sleeps through the answer being filed and the turn ending.
        turns.file([answeredWith(TYPED)]);
        turns.endUnheard("done");
        turns.holdHistory();
        // It wakes: the stream starts over and says the turn is over. The record is still unread.
        await acted(() => {
          window.dispatchEvent(new Event("online"));
        });
        await view.settle(500);
        expect(isNotSent(view.host)).toBe(false);
        expect(kept()).toMatchObject([
          { text: TYPED, answerTo: CALL, waiting: true },
        ]);
        expect(turns.sends).toHaveLength(0);

        // The record is read: they were the card's answer.
        await acted(() => turns.answerHistory());
        await view.waitFor(
          () => kept().length === 0,
          "them to be forgotten",
          4000,
        );
        await view.settle(200);
        expect(isNotSent(view.host)).toBe(false);
        expect(turns.sends).toHaveLength(0);
      });

      test("and are theirs once the record has been read and still says nothing of the question", async () => {
        await restFor(NEVER_IN_THIS_TEST);
        const { api, turns } = server();
        const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
        await ask(view, turns);
        turns.answersDown();

        await sendWords(view, TYPED);
        await view.waitFor(() => kept().length === 1, "the words kept", 4000);
        // The server died holding the question: the turn is over, and the record has no answer.
        turns.endUnheard("error");
        turns.holdHistory();
        await acted(() => {
          window.dispatchEvent(new Event("online"));
        });
        await view.settle(500);
        expect(isNotSent(view.host)).toBe(false);

        await acted(() => turns.answerHistory());
        await view.waitFor(
          () => isNotSent(view.host),
          "the words drawn as not sent",
          4000,
        );
        expect(turns.sends).toHaveLength(0);
        expect(kept()).toMatchObject([{ text: TYPED, answerTo: CALL }]);
      });

      test("nor while the record cannot be read: it is read again until it can be", async () => {
        await restFor(40);
        const { api, turns } = server();
        const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
        await ask(view, turns);
        turns.answersDown();

        await sendWords(view, TYPED);
        await view.waitFor(() => kept().length === 1, "the words kept", 4000);
        turns.historyDown();
        await acted(() => turns.announceUnheard("done"));
        // A read that fails says nothing of the question either.
        await view.settle(600);
        expect(isNotSent(view.host)).toBe(false);
        expect(kept()).toMatchObject([{ text: TYPED, waiting: true }]);

        turns.historyUp();
        await view.waitFor(
          () => isNotSent(view.host),
          "the words drawn as not sent",
          4000,
        );
        expect(turns.sends).toHaveLength(0);
      });

      /*
       * Review, seventh round. The record was read as its newest page, and a conversation goes on
       * without this window: a routine delivering every morning, turns from another device. Past
       * a page of that, the question and what answered it are above the newest page — which then
       * says nothing of either, and words the server had taken were handed to the person as not
       * sent, with the press that sends them a second time.
       */
      describe("with the question above the newest page of the record", () => {
        /** Two pages of a conversation that say nothing of the question: a routine's deliveries. */
        const TWO_PAGES = [1, 2, 3, 4].map(
          (day): Message => ({
            id: `routine-${day}`,
            role: "assistant",
            content: `아침 브리핑 ${day}`,
          }),
        );
        /** Watches for the not-sent line; what it hands back says whether it was ever drawn. */
        const watchNotSent = (host: HTMLElement) => {
          let wasDrawn = isNotSent(host);
          const watch = new MutationObserver(() => {
            if (isNotSent(host)) wasDrawn = true;
          });
          watch.observe(host, { childList: true, subtree: true });
          return () => {
            watch.disconnect();
            return wasDrawn;
          };
        };

        test("are forgotten, never drawn as not sent, where the page that holds it shows them as its answer", async () => {
          await restFor(NEVER_IN_THIS_TEST);
          const { api, turns } = server({ historyPage: 2 });
          const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
          await ask(view, turns);
          turns.loseAnswerReply();

          await sendWords(view, TYPED);
          await view.waitFor(
            () => turns.answers().length === 1,
            "the door to take the answer",
            4000,
          );
          // The window sleeps: the answer is filed, the turn ends, and the conversation goes on.
          turns.file([answeredWith(TYPED), ...TWO_PAGES]);
          turns.endUnheard("done");
          const wasEverNotSent = watchNotSent(view.host);
          await acted(() => {
            window.dispatchEvent(new Event("online"));
          });
          await view.waitFor(
            () => kept().length === 0,
            "them to be forgotten",
            4000,
          );
          await view.settle(300);
          expect(wasEverNotSent()).toBe(false);
          expect(turns.sends).toHaveLength(0);
          // Read back a page at a time, each from where the one before began, as far as the question.
          expect(
            turns.historyCursors().filter((cursor) => cursor !== null),
          ).toEqual([6, 4]);
        });

        test("go as the message they are, where the page that holds it shows the question over some other way", async () => {
          await restFor(NEVER_IN_THIS_TEST);
          const { api, turns } = server({ historyPage: 2 });
          const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
          await ask(view, turns);
          turns.answersDown();

          await sendWords(view, TYPED);
          await view.waitFor(() => kept().length === 1, "the words kept", 4000);
          // Nobody answered while the window slept: the wait ran out, and the conversation went on.
          turns.file([
            {
              id: "r-choice",
              role: "tool",
              toolCallId: CALL,
              content: JSON.stringify({
                ok: false,
                code: "laf:nobody_answered",
              }),
            } as Message,
            ...TWO_PAGES,
          ]);
          turns.endUnheard("done");
          const wasEverNotSent = watchNotSent(view.host);
          await acted(() => {
            window.dispatchEvent(new Event("online"));
          });
          await view.waitFor(
            () => turns.sends.length === 1,
            "the words to go as a message",
            4000,
          );
          expect(
            askedIn(turns.sends[0]).map((message) => message.content),
          ).toEqual([TYPED]);
          await view.settle(300);
          expect(wasEverNotSent()).toBe(false);
          expect(turns.answers()).toHaveLength(0);
        });

        test("and are theirs only once the record has been read to its start, where no page holds the question", async () => {
          await restFor(NEVER_IN_THIS_TEST);
          // The question reached this window and never the record: the server died before filing it.
          const { api, turns } = server({
            historyPage: 2,
            history: [...TWO_PAGES, ASKED],
            turnMessages: [ASKED, QUESTION],
          });
          let letPagesAboveIn = () => {};
          const pagesAbove = new Promise<void>((resolve) => {
            letPagesAboveIn = resolve;
          });
          const slowAbove = (request: ApiRequest) =>
            request.pathname.endsWith("/history") &&
            request.url.searchParams.has("before")
              ? pagesAbove.then(() => api(request) as Response)
              : api(request);
          const view = await mountApp({
            path: `/channel/${CHANNEL}`,
            api: slowAbove,
          });
          await acted(() => turns.waitOn([CALL]));
          await view.waitFor(
            () =>
              view.host.querySelector('[role="log"]')?.children.length !== 0,
            "the call's line",
            6000,
          );
          await view.settle(60);
          turns.answersDown();

          await sendWords(view, TYPED);
          await view.waitFor(() => kept().length === 1, "the words kept", 4000);
          turns.endUnheard("error");
          await acted(() => {
            window.dispatchEvent(new Event("online"));
          });
          // The newest page is in and says nothing of the question. Nor has the record, yet.
          await view.settle(500);
          expect(isNotSent(view.host)).toBe(false);
          expect(kept()).toMatchObject([
            { text: TYPED, answerTo: CALL, waiting: true },
          ]);

          await acted(() => letPagesAboveIn());
          await view.waitFor(
            () => isNotSent(view.host),
            "the words drawn as not sent",
            4000,
          );
          expect(turns.sends).toHaveLength(0);
          expect(kept()).toMatchObject([{ text: TYPED, answerTo: CALL }]);
          expect(kept()[0]?.waiting).toBeUndefined();
          // Every page above the newest was asked for, down to the first thing ever said.
          expect(
            turns.historyCursors().filter((cursor) => cursor !== null),
          ).toEqual([4, 2]);
        });
      });

      test("and go ahead of the next thing the person says", async () => {
        await restFor(NEVER_IN_THIS_TEST);
        const { api, turns } = server();
        const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
        await ask(view, turns);
        turns.answersDown();

        await sendWords(view, TYPED);
        await view.waitFor(() => kept().length === 1, "the words kept", 4000);
        await acted(() => turns.announceUnheard("done"));
        await view.waitFor(
          () => isNotSent(view.host),
          "the words drawn as not sent",
          4000,
        );

        await sendWords(view, "그리고 후식도 골라 줘");
        await view.waitFor(
          () => turns.sends.length === 1,
          "the next message to go",
          4000,
        );
        expect(
          askedIn(turns.sends[0]).map((message) => message.content),
        ).toEqual([TYPED, "그리고 후식도 골라 줘"]);
      });
    });

    test("that the door had taken are the card's answer when the stream says so — and go nowhere twice", async () => {
      const { api, turns } = server();
      const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
      await ask(view, turns);
      turns.loseAnswerReply();

      await sendWords(view, TYPED);
      await view.waitFor(
        () => turns.answers().length === 1,
        "the door to take the answer",
        4000,
      );
      await view.settle(300);
      // The reply lost: still the card's, on it, and not under it as waiting.
      expect(view.host.textContent).not.toContain(WAITS);
      turns.answersUp();
      // Nothing waits on the card now, and nothing says yet what answered it: they stay as they are.
      await acted(() => {
        window.dispatchEvent(new Event("online"));
      });
      await view.settle(300);
      expect(turns.answers()).toHaveLength(1);
      expect(kept()).toMatchObject([{ text: TYPED, answerTo: CALL }]);

      // What the door would have said arrives the other way: the call's result is these words.
      await acted(() => turns.say([answeredWith(TYPED)]));
      await view.waitFor(
        () => kept().length === 0,
        "them to be forgotten",
        4000,
      );
      expect(view.host.textContent).not.toContain(WAITS);

      await acted(() => turns.announce("done"));
      await view.settle(300);
      expect(turns.sends).toHaveLength(0);
      expect(turns.answers()).toHaveLength(1);
    });
  });

  /*
   * "Taken" is not yet "filed": between the door's yes and the result on the conversation the
   * turn can be stopped, and the answer goes with it. Kept until the conversation shows it, the
   * words are still there to go as a message.
   */
  test("that the door took are still sent, as a message, if the turn is stopped before the answer is filed", async () => {
    const { api, turns } = server();
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await ask(view, turns);

    await sendWords(view, TYPED);
    await view.waitFor(
      () => turns.answers().length === 1,
      "the door to take the answer",
      4000,
    );
    expect(view.host.textContent).not.toContain(WAITS);

    await acted(() => {
      turns.say([
        {
          id: "r-choice",
          role: "tool",
          toolCallId: CALL,
          content: JSON.stringify({ ok: false, code: "laf:stopped" }),
        } as Message,
      ]);
      turns.announce("stopped");
    });
    await view.waitFor(
      () => turns.sends.length === 1,
      "the words to go as a message",
      4000,
    );
    expect(askedIn(turns.sends[0]).map((message) => message.content)).toEqual([
      TYPED,
    ]);
  });

  test("that the door took are forgotten once the conversation shows them as the card's answer", async () => {
    const { api, turns } = server();
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await ask(view, turns);

    await sendWords(view, TYPED);
    await view.waitFor(
      () => turns.answers().length === 1,
      "the door to take the answer",
      4000,
    );
    await acted(() => turns.say([answeredWith(TYPED)]));
    await view.waitFor(() => kept().length === 0, "them to be forgotten", 4000);
    await acted(() => turns.announce("done"));
    await view.settle(300);
    expect(turns.sends).toHaveLength(0);
  });

  /*
   * What the door took is the card's answer whatever words the card then shows: a server that
   * files the answer as it keeps it — trimmed, half a character dropped — shows other words than
   * were typed, and read as "answered by somebody else" they went again as a message.
   */
  test("that the door took are forgotten though the card shows them in the server's own spelling", async () => {
    const { api, turns } = server();
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await ask(view, turns);

    await sendWords(view, TYPED);
    await view.waitFor(
      () => turns.answers().length === 1,
      "the door to take the answer",
      4000,
    );
    await acted(() => turns.say([answeredWith(`${TYPED} `)]));
    await view.waitFor(() => kept().length === 0, "them to be forgotten", 4000);
    await acted(() => turns.announce("done"));
    await view.settle(300);
    expect(turns.sends).toHaveLength(0);
  });

  /*
   * RELOADED BETWEEN THE DOOR TAKING AN ANSWER AND THE BOT BEING FREE TO FILE IT. The answer is
   * taken at once and filed only when the Bot is free again, which behind a routine is minutes.
   * The page that comes back has the words and has made no offer of its own: the card waits on
   * nothing, no result is in, and the turn goes on. They are the card's to show — not drawn as
   * waiting for the turn, and not offered to a door that has them.
   */
  test("kept from before a reload, with the card answered and its answer not yet filed, wait as the card's and are offered nowhere", async () => {
    localStorage.setItem(
      `laf:unsent:${CHANNEL}`,
      JSON.stringify([
        {
          id: "typed-before-reload",
          text: TYPED,
          instructions: [],
          at: "2026-10-03T00:00:00.000Z",
          autoTried: false,
          waiting: true,
          answerTo: CALL,
        },
      ]),
    );
    const { api, turns } = server();
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    // The question was asked and answered before this page: the turn waits on nothing.
    await acted(() => turns.say([QUESTION]));
    await view.waitFor(
      () => view.host.querySelector('[role="log"]')?.children.length !== 0,
      "the call's line",
      6000,
    );
    await view.settle(300);
    expect(view.host.textContent).not.toContain(WAITS);
    expect(isNotSent(view.host)).toBe(false);
    expect(turns.asks()).toBe(0);
    expect(turns.sends).toHaveLength(0);
    expect(kept()).toMatchObject([{ text: TYPED, answerTo: CALL }]);

    // The Bot is free, and the answer is filed: they were the card's answer all along.
    await acted(() => turns.say([answeredWith(TYPED)]));
    await view.waitFor(() => kept().length === 0, "them to be forgotten", 4000);
    await acted(() => turns.announce("done"));
    await view.settle(300);
    expect(turns.sends).toHaveLength(0);
  });

  /*
   * A PROVIDER'S IDS ARE ITS OWN TO MINT. Words kept by the call's id alone were the answer to
   * whatever question carried that id next: kept for a question whose turn died with the server
   * that held it, they were offered to its later namesake as its answer (review, eighth round).
   */
  describe("kept for an earlier question that carried the same id", () => {
    const EARLIER = { ...QUESTION, id: "a-choice-earlier" } as Message;
    const EARLIER_ASK: Message = {
      id: "q-0",
      role: "user",
      content: "점심 메뉴 고르는 걸 도와줘",
    };
    const keepForEarlier = () =>
      localStorage.setItem(
        `laf:unsent:${CHANNEL}`,
        JSON.stringify([
          {
            id: "typed-for-earlier",
            text: TYPED,
            instructions: [],
            at: "2026-10-03T00:00:00.000Z",
            autoTried: false,
            waiting: true,
            answerTo: CALL,
            askedBy: EARLIER.id,
          },
        ]),
      );

    test("are not offered to the one asked now, and are the person's once the record has been read", async () => {
      keepForEarlier();
      // The record holds the earlier question with no result: its server died holding it.
      const { api, turns } = server({
        history: [EARLIER_ASK, EARLIER, ASKED],
      });
      const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
      await ask(view, turns);

      await view.waitFor(
        () => isNotSent(view.host),
        "the words drawn as not sent",
        4000,
      );
      await view.settle(300);
      expect(turns.asks()).toBe(0);
      expect(turns.sends).toHaveLength(0);
      expect(kept()).toMatchObject([
        { text: TYPED, answerTo: CALL, askedBy: EARLIER.id },
      ]);
      expect(kept()[0]?.waiting).toBeUndefined();
    });

    test("and are not taken away by what is typed for the one asked now", async () => {
      await restFor(NEVER_IN_THIS_TEST);
      keepForEarlier();
      const { api, turns } = server({
        history: [EARLIER_ASK, EARLIER, ASKED],
      });
      const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
      await ask(view, turns);
      turns.loseAnswerReply();

      await sendWords(view, "이번에는 비빔밥");
      await view.waitFor(
        () => turns.answers().length === 1,
        "the new words to reach the card's door",
        4000,
      );
      expect(turns.answers()).toEqual([
        { toolCallId: CALL, value: { answer: "이번에는 비빔밥" } },
      ]);
      await view.settle(200);
      // Both are kept: each with the message that asked it.
      const both = kept().map((message) => [message.text, message.askedBy]);
      expect(both).toHaveLength(2);
      expect(both).toContainEqual([TYPED, EARLIER.id]);
      expect(both).toContainEqual(["이번에는 비빔밥", QUESTION.id]);
    });
  });

  /*
   * A sentence another screen sends for the person (목표's [대화에서 시작], `offerSend`) goes
   * through the composer's own submit, and landing while a card waited it was filed as that
   * card's answer — a goal's opening line, in reply to "오늘 저녁 메뉴".
   */
  test("not a sentence another screen sent for the person: that waits for the turn", async () => {
    const { api, turns } = server();
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await ask(view, turns);

    const { offerSend } = await import(
      "../src/components/channels/composer/prefill"
    );
    await acted(() => offerSend(CHANNEL, "이번 주 매출 목표를 같이 시작하자"));
    await view.waitFor(
      () => view.host.textContent?.includes(WAITS) === true,
      "the sentence kept as waiting for the turn",
      4000,
    );
    await view.settle(200);
    expect(turns.asks()).toBe(0);
    expect(kept()).toMatchObject([
      { text: "이번 주 매출 목표를 같이 시작하자" },
    ]);
    expect(kept()[0]?.answerTo).toBeUndefined();
  });
});

describe("the words", () => {
  test("are Korean", () => {
    expect(ko["Not answered"]).toBe("답하지 않음");
    expect(ko["Your answer: {answer}"]).toBe("내 답: {answer}");
  });
});
