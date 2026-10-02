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

/** A conversation whose Bot may ask with a choice card, in the middle of a turn. */
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
      () => view.host.textContent?.includes(WAITS) === true,
      "the words kept as waiting for the Bot",
      4000,
    );
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
      await view.waitFor(
        () => view.host.textContent?.includes(WAITS) === true,
        "the words kept as waiting",
        4000,
      );
      await view.settle(300);
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
      await view.waitFor(
        () => view.host.textContent?.includes(WAITS) === true,
        "the words kept as waiting",
        4000,
      );
      expect(turns.answers()).toHaveLength(0);
      /*
       * Asked again and again while it is down, behind words that stay where they are. They used
       * to leave the list of waiting words for every offer and come back when it failed: a blink
       * on each retry, and the transcript pulled to the end each time (adversarial read,
       * 2026-10-03).
       */
      let isGoneAtAnyTime = false;
      const watch = new MutationObserver(() => {
        if (!view.host.textContent?.includes(WAITS)) isGoneAtAnyTime = true;
      });
      watch.observe(view.host, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      await view.waitFor(() => turns.asks() >= 4, "the door asked again", 4000);
      watch.disconnect();
      expect(isGoneAtAnyTime).toBe(false);

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
      // The first is not offered again meanwhile: the second is what reaches the door.
      await restFor(NEVER_IN_THIS_TEST);
      const { api, turns } = server();
      const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
      await ask(view, turns);
      turns.answersDown();

      await sendWords(view, TYPED);
      await view.waitFor(() => kept().length === 1, "the first kept", 4000);
      turns.answersUp();
      await sendWords(view, "아니, 그냥 비빔밥");
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
        await acted(() => turns.announceUnheard("done"));
        // The read of the record that follows a turn's end brings what the stream did not.
        await view.waitFor(
          () => kept().length === 0,
          "them to be forgotten",
          4000,
        );
        await view.settle(300);
        expect(turns.sends).toHaveLength(0);
        expect(isNotSent(view.host)).toBe(false);
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
      await view.waitFor(
        () => view.host.textContent?.includes(WAITS) === true,
        "the words kept as waiting, the reply having been lost",
        4000,
      );
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
