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
import { BOT_ID } from "./support/channel-server";
import {
  acted,
  askedIn,
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * WHAT SOMEBODY QUEUED WHILE THE BOT WORKED IS STILL WAITING AFTER A RELOAD, AND GOES WHEN THE TURN ENDS.
 *
 * Found by a read-only review on 2026-10-02 and reproduced here before anything was changed. The
 * person sends a task, types a correction while the Bot is working, presses the button — "메시지
 * 대기열에 넣기" — and sees it waiting. Then they reload, or close the laptop: the very thing a turn
 * the server owns exists for. The correction lived in React state in that one mount
 * (`ConversationView`), so it was gone, and nothing said so.
 *
 * It goes through the outbox now (`composer/outbox.ts`): kept on the device, marked as waiting for
 * the Bot, and sent when the turn is over by the send that already takes what the device kept. What
 * must not have changed is held here too: it goes when the turn is over however it ended — Stop is
 * still a way to steer — several go as one turn in the order they were typed, and one taken back
 * does not go at all.
 */

/*
 * At phone width, for the file after it: mounting the conversation leaves the window's width in
 * `lib/computer/screen-panel.ts` for the rest of the process (see `draft-to-composer.test.tsx`).
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
  localStorage.clear();
  await freshTab();
});
setDefaultTimeout(30_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

const EARLIER: Message = {
  id: "q-earlier",
  role: "user",
  content: "오늘 날짜 알려줘",
};
const EARLIER_ANSWER: Message = {
  id: "a-earlier",
  role: "assistant",
  content: "오늘은 10월 2일이에요.",
};
const TASK: Message = {
  id: "q-task",
  role: "user",
  content: "경제 뉴스 알려줘",
};
const CORRECTION = "아 그거 말고 IT 뉴스로";
const SECOND = "세 줄로 줄여서";
const WAITS = "Sends when the current job is done";
const unsentLine = '[data-testid="transcript-unsent"]';

/**
 * What the not-sent lines say, never the elements: an assertion that fails holding a happy-dom
 * element prints the whole document it hangs from, and the run sits printing for minutes (measured).
 */
const unsentLines = (host: HTMLElement) =>
  [...host.querySelectorAll(unsentLine)].map((line) => line.textContent);

/**
 * A device that will not keep what the outbox hands it — site data blocked, or the disk full — until
 * the function handed back is called. Only the outbox's own keys, so the rest of the app goes on.
 */
function refusingStorage(): () => void {
  /*
   * The storage itself is stood in for, not `Storage.prototype.setItem` patched: happy-dom hands
   * out the method it resolved the first time, so in a file that has already written to storage a
   * patched prototype refuses nothing, and a test of "storage refuses" passes having stored
   * everything (measured: this file's two cases passed in the file and failed alone).
   */
  const real = globalThis.localStorage;
  const described = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const refusing = {
    get length() {
      return real.length;
    },
    key: (index: number) => real.key(index),
    getItem: (key: string) => real.getItem(key),
    removeItem: (key: string) => real.removeItem(key),
    clear: () => real.clear(),
    setItem: (key: string, value: string) => {
      if (key.startsWith("laf:unsent:")) throw new Error("QuotaExceededError");
      real.setItem(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: refusing,
  });
  return () => {
    if (described) Object.defineProperty(globalThis, "localStorage", described);
  };
}

/** A page that has just loaded holds nothing in memory: only what `localStorage` kept. */
async function freshTab() {
  const { forgetUnsentCache } = await import(
    "../src/components/channels/composer/outbox"
  );
  forgetUnsentCache();
}

/** The Bot is in the middle of the task the person sent. */
const working = (channelId: string, more: { active?: boolean } = {}) =>
  turnServer({
    channelId,
    history: [EARLIER, EARLIER_ANSWER, TASK],
    turn: { id: "turn-0", status: "running", asked: [TASK.id] },
    turnMessages: [TASK],
    ...more,
  });

/** The words drawn as waiting for the Bot: faded, with the line saying when they go. */
const waiting = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-slot="message"]')]
    .filter((row) => row.textContent?.includes(WAITS))
    .map(
      (row) =>
        row.querySelector('[data-slot="bubble-content"]')?.textContent ?? "",
    );

const bubblesSaying = (host: HTMLElement, words: string) =>
  [
    ...host.querySelectorAll('[role="log"] [data-slot="bubble-content"]'),
  ].filter((bubble) => bubble.textContent?.trim() === words).length;

const composerText = (host: HTMLElement) =>
  host.querySelector('[aria-label="Message"]')?.textContent ?? "";

type View = Awaited<ReturnType<typeof mountApp>>;

/** Type into the composer and press its one button, named for what it is about to do. */
async function typeAndPress(
  view: View,
  channelId: string,
  words: string,
  button: "Send message" | "Queue message",
) {
  const { offerDraft } = await import(
    "../src/components/channels/composer/prefill"
  );
  await acted(() => offerDraft(channelId, words));
  await view.waitFor(
    () => composerText(view.host).trim() === words,
    "the words in the composer",
    4000,
  );
  const pressed = view.host.querySelector(`button[aria-label="${button}"]`);
  if (!pressed) throw new Error(`the composer's button is not "${button}"`);
  await view.click(pressed);
}

/** Mid-turn the button is "메시지 대기열에 넣기", and what is typed lands under the conversation. */
async function queue(view: View, channelId: string, words: string) {
  await typeAndPress(view, channelId, words, "Queue message");
  await view.waitFor(
    () => waiting(view.host).includes(words),
    `"${words}" drawn as waiting`,
    4000,
  );
}

const send = (view: View, channelId: string, words: string) =>
  typeAndPress(view, channelId, words, "Send message");

/** The Bot finishes the task it was on. */
const finish = (server: ReturnType<typeof turnServer>) =>
  acted(() => {
    server.say([
      { id: "a-task", role: "assistant", content: "경제 뉴스예요." },
    ]);
    server.announce("done");
  });

const open = (channelId: string, server: ReturnType<typeof turnServer>) =>
  mountApp({ path: `/channel/${channelId}`, api: server.api });

/** A correction another page load of this device left waiting (`laf:unsent:<channel>`). */
function leftWaiting(
  channelId: string,
  entries: Array<{ id: string; text: string; instructions?: string[] }>,
) {
  localStorage.setItem(
    `laf:unsent:${channelId}`,
    JSON.stringify(
      entries.map((entry) => ({
        instructions: [],
        // Before anything a test types now: what is kept goes in the order it was typed.
        at: "2026-10-01T10:23:00.000Z",
        autoTried: false,
        waiting: true,
        ...entry,
      })),
    ),
  );
}

describe("a correction queued while the Bot works", () => {
  test("is still waiting after a reload, and goes when the turn is over", async () => {
    const channelId = "channel_queued-reload";
    const server = working(channelId);
    let view = await open(channelId, server);
    expect(ko["Queue message"]).toBe("메시지 대기열에 넣기");
    await queue(view, channelId, CORRECTION);
    expect(waiting(view.host)).toEqual([CORRECTION]);
    expect(server.sends).toHaveLength(0);

    // The reload: the page is gone, and with it everything the tab held in memory.
    await view.unmount();
    await freshTab();
    view = await open(channelId, server);
    await view.waitFor(
      () => server.historyReads() >= 2,
      "the conversation read again by the page that loaded",
      8000,
    );
    await view.settle(200);
    expect(waiting(view.host)).toEqual([CORRECTION]);
    // The Bot is still on the task: nothing goes yet.
    expect(server.sends).toHaveLength(0);

    await finish(server);
    await view.waitFor(
      () => server.sends.length === 1,
      "the correction, sent once the turn was over",
      8000,
    );
    expect(askedIn(server.sends[0]).map((message) => message.content)).toEqual([
      CORRECTION,
    ]);
    expect(server.sends[0]?.botId).toBe(BOT_ID);
    await view.waitFor(
      () => localStorage.getItem(`laf:unsent:${channelId}`) === null,
      "the device keeping nothing once the server has it",
      8000,
    );
    // It is the person's message in the conversation now, and nothing says it ever failed.
    expect(waiting(view.host)).toEqual([]);
    expect(bubblesSaying(view.host, CORRECTION)).toBe(1);
    expect(unsentLines(view.host)).toEqual([]);
    expect(view.host.textContent).not.toContain(
      "Sent when the connection came back.",
    );
    // The roster hears the person's line when it goes, as it did when the queue drained in the tab.
    expect(
      view.requests
        .filter((request) => request.pathname.endsWith("/activity"))
        .map((request) => (request.body as { text: string }).text),
    ).toEqual([CORRECTION]);
    server.close();
    await view.unmount();
  });

  test("is not sent on a reload until the stream has said how the turn stands", async () => {
    const channelId = "channel_queued-untold";
    leftWaiting(channelId, [{ id: "q-correction", text: CORRECTION }]);
    // The page is in before the stream has answered: the window does not know a turn is going.
    const server = turnServer({
      channelId,
      history: [EARLIER, EARLIER_ANSWER, TASK],
      turn: { id: "turn-0", status: "running", asked: [TASK.id] },
      turnMessages: [TASK],
      holdStreams: true,
    });
    const view = await open(channelId, server);
    await view.waitFor(
      () => server.historyReads() >= 1,
      "the conversation's page",
      8000,
    );
    await view.settle(300);
    expect(server.sends).toHaveLength(0);
    expect(waiting(view.host)).toEqual([CORRECTION]);
    expect(bubblesSaying(view.host, String(EARLIER_ANSWER.content))).toBe(1);

    await acted(() => server.answerStreams());
    await view.settle(300);
    expect(server.sends).toHaveLength(0);

    await finish(server);
    await view.waitFor(
      () => server.sends.length === 1,
      "the correction, sent once the turn was over",
      8000,
    );
    expect(askedIn(server.sends[0]).map((message) => message.id)).toEqual([
      "q-correction",
    ]);
    server.close();
    await view.unmount();
  });

  test("several go as one turn, in the order they were typed", async () => {
    const channelId = "channel_queued-order";
    const server = working(channelId);
    let view = await open(channelId, server);
    await queue(view, channelId, CORRECTION);
    await queue(view, channelId, SECOND);
    expect(waiting(view.host)).toEqual([CORRECTION, SECOND]);

    await view.unmount();
    await freshTab();
    view = await open(channelId, server);
    await view.waitFor(
      () => waiting(view.host).length === 2,
      "both, still waiting after the reload",
      8000,
    );
    expect(waiting(view.host)).toEqual([CORRECTION, SECOND]);

    await finish(server);
    await view.waitFor(
      () => server.sends.length > 0,
      "the turn they go as",
      8000,
    );
    await view.settle(300);
    // One hand-over, so one turn: the Bot reads both before it answers either.
    expect(server.sends).toHaveLength(1);
    expect(askedIn(server.sends[0]).map((message) => message.content)).toEqual([
      CORRECTION,
      SECOND,
    ]);
    server.close();
    await view.unmount();
  });

  test("goes when the turn is stopped: Stop is still a way to steer", async () => {
    const channelId = "channel_queued-stop";
    const server = working(channelId);
    const view = await open(channelId, server);
    await queue(view, channelId, CORRECTION);
    await view.click(view.buttonNamed("Stop and send this") as Element);
    await view.waitFor(
      () => server.sends.length === 1,
      "the correction, sent once the turn was stopped",
      8000,
    );
    expect(server.stops()).toBe(1);
    expect(askedIn(server.sends[0]).map((message) => message.content)).toEqual([
      CORRECTION,
    ]);
    server.close();
    await view.unmount();
  });

  test("taken back, it is off the device and does not go", async () => {
    const channelId = "channel_queued-removed";
    const server = working(channelId);
    let view = await open(channelId, server);
    await queue(view, channelId, CORRECTION);
    await view.unmount();
    await freshTab();
    view = await open(channelId, server);
    await view.waitFor(
      () => waiting(view.host).length === 1,
      "the correction, still waiting after the reload",
      8000,
    );
    await view.click(view.buttonNamed("Remove") as Element);
    expect(waiting(view.host)).toEqual([]);
    expect(localStorage.getItem(`laf:unsent:${channelId}`)).toBeNull();

    await finish(server);
    await view.settle(400);
    expect(server.sends).toHaveLength(0);
    server.close();
    await view.unmount();
  });

  test("that the server did not take says it was not sent, with a way to send it", async () => {
    const channelId = "channel_queued-refused";
    const server = working(channelId);
    const view = await open(channelId, server);
    await queue(view, channelId, CORRECTION);
    server.doorDown();
    await finish(server);
    await view.waitFor(
      () => view.host.querySelector(unsentLine) !== null,
      "the line saying it was not sent",
      8000,
    );
    // Never left drawn as waiting for a turn that is over: that would promise a send nobody makes.
    expect(waiting(view.host)).toEqual([]);
    expect(bubblesSaying(view.host, CORRECTION)).toBe(1);
    expect(view.host.querySelector(unsentLine)?.textContent).toContain(
      "Not sent",
    );
    await view.settle(300);
    // Its one send by itself was the one that failed.
    expect(server.sends).toHaveLength(1);

    server.doorUp();
    await view.click(view.buttonNamed("Send again") as Element);
    await view.waitFor(
      () => server.sends.length === 2,
      "the correction, sent by the person's press",
      8000,
    );
    expect(askedIn(server.sends[1]).map((message) => message.content)).toEqual([
      CORRECTION,
    ]);
    await view.waitFor(
      () => view.host.querySelector(unsentLine) === null,
      "the line gone once the server has it",
      8000,
    );
    server.close();
    await view.unmount();
  });

  test("goes when the turn is over on a device that refuses to keep anything", async () => {
    const channelId = "channel_queued-no-storage";
    const server = working(channelId);
    const view = await open(channelId, server);
    // A private window with site data blocked, or a full disk: nothing can be written down.
    const restore = refusingStorage();
    try {
      await queue(view, channelId, CORRECTION);
      await finish(server);
      await view.waitFor(
        () => server.sends.length === 1,
        "the correction, sent once the turn was over",
        8000,
      );
      expect(
        askedIn(server.sends[0]).map((message) => message.content),
      ).toEqual([CORRECTION]);
    } finally {
      restore();
    }
    server.close();
    await view.unmount();
  });

  test("is not sent into a conversation whose Bot was deleted", async () => {
    const channelId = "channel_queued-deleted";
    leftWaiting(channelId, [{ id: "q-correction", text: CORRECTION }]);
    const server = turnServer({
      channelId,
      history: [EARLIER, EARLIER_ANSWER],
      active: false,
    });
    const view = await open(channelId, server);
    await view.waitFor(
      () => waiting(view.host).length === 1,
      "the correction, still on screen",
      8000,
    );
    await view.settle(400);
    expect(server.sends).toHaveLength(0);
    server.close();
    await view.unmount();
  });

  test("the same skill asked for twice is one instruction in the turn they go as", async () => {
    const channelId = "channel_queued-skill";
    const SKILL = "주간 보고 형식으로 써 줘.";
    leftWaiting(channelId, [
      { id: "q-one", text: CORRECTION, instructions: [SKILL] },
      { id: "q-two", text: SECOND, instructions: [SKILL] },
    ]);
    const server = turnServer({
      channelId,
      history: [EARLIER, EARLIER_ANSWER],
    });
    const view = await open(channelId, server);
    await view.waitFor(
      () => server.sends.length === 1,
      "what was left waiting, sent once the page and the stream were in",
      8000,
    );
    expect(
      server.sends[0]?.messages.map((message) => [
        message.role,
        message.content,
      ]),
    ).toEqual([
      ["system", SKILL],
      ["user", CORRECTION],
      ["user", SECOND],
    ]);
    server.close();
    await view.unmount();
  });

  test("typed while the message before it was still on its way, it goes after that message", async () => {
    const channelId = "channel_queued-behind-a-send";
    const server = turnServer({
      channelId,
      history: [EARLIER, EARLIER_ANSWER],
    });
    const view = await open(channelId, server);
    await view.waitFor(
      () => bubblesSaying(view.host, String(EARLIER_ANSWER.content)) === 1,
      "the conversation",
      8000,
    );
    // The task's hand-over is on its way, and will not arrive.
    server.doorDown();
    server.holdDoor();
    await send(view, channelId, String(TASK.content));
    await view.waitFor(
      () => server.sends.length === 1,
      "the task's send",
      4000,
    );
    // The Bot has the turn as far as the person can see: the correction is parked behind it.
    await queue(view, channelId, CORRECTION);

    await acted(() => server.answerDoor());
    await view.settle(300);
    // Not into the server that just failed to answer: what was kept waits for the connection
    // (`unsent-goes-when-back.test.tsx`).
    expect(server.sends).toHaveLength(1);
    server.doorUp();
    await acted(() => {
      window.dispatchEvent(new Event("online"));
    });
    await view.waitFor(
      () => server.sends.length === 2,
      "what this device kept, sent again",
      8000,
    );
    /*
     * The task was kept AFTER the correction — only once its send had failed — and typed before
     * it. What is kept goes in the order it was typed, or the correction runs ahead of the
     * sentence it corrects.
     */
    expect(askedIn(server.sends[1]).map((message) => message.content)).toEqual([
      TASK.content,
      CORRECTION,
    ]);
    server.close();
    await view.unmount();
  });

  test("an idle send takes what is waiting with it, ahead of the new words", async () => {
    const channelId = "channel_queued-carried";
    leftWaiting(channelId, [{ id: "q-correction", text: CORRECTION }]);
    // The stream has not answered, so nothing has gone by itself; the person types on.
    const server = turnServer({
      channelId,
      history: [EARLIER, EARLIER_ANSWER],
      holdStreams: true,
    });
    const view = await open(channelId, server);
    await view.waitFor(
      () => waiting(view.host).length === 1,
      "the correction, waiting",
      8000,
    );
    await send(view, channelId, SECOND);
    await view.waitFor(() => server.sends.length === 1, "the send", 8000);
    expect(askedIn(server.sends[0]).map((message) => message.content)).toEqual([
      CORRECTION,
      SECOND,
    ]);
    server.close();
    await view.unmount();
  });

  test("on its way for the first time, it is the person's message and nothing says it is being sent again", async () => {
    const channelId = "channel_queued-leaving";
    const server = working(channelId);
    const view = await open(channelId, server);
    await queue(view, channelId, CORRECTION);
    server.holdDoor();
    await finish(server);
    await view.waitFor(
      () => server.sends.length === 1,
      "the correction's send, on its way",
      8000,
    );
    await view.settle(100);
    expect(waiting(view.host)).toEqual([]);
    expect(bubblesSaying(view.host, CORRECTION)).toBe(1);
    // "다시 보내는 중…" is for words that failed to leave once. These never did.
    expect(unsentLines(view.host)).toEqual([]);
    // Still on the device until the server answers: a reload in this moment does not lose them.
    expect(localStorage.getItem(`laf:unsent:${channelId}`)).not.toBeNull();

    await acted(() => server.answerDoor());
    await view.waitFor(
      () => localStorage.getItem(`laf:unsent:${channelId}`) === null,
      "the device keeping nothing once the server has it",
      8000,
    );
    server.close();
    await view.unmount();
  });

  test("sent along into a turn this window had not heard of, it goes on waiting behind that turn", async () => {
    const channelId = "channel_queued-carried-refused";
    leftWaiting(channelId, [{ id: "q-correction", text: CORRECTION }]);
    // A turn is going, and the stream has not said so: to this window the conversation is free.
    const server = turnServer({
      channelId,
      history: [EARLIER, EARLIER_ANSWER, TASK],
      turn: { id: "turn-0", status: "running", asked: [TASK.id] },
      turnMessages: [TASK],
      holdStreams: true,
    });
    const view = await open(channelId, server);
    await view.waitFor(
      () => waiting(view.host).length === 1,
      "the correction, waiting",
      8000,
    );
    await send(view, channelId, SECOND);
    await view.waitFor(() => server.sends.length === 1, "the send", 8000);
    await view.settle(200);
    // Refused, because the Bot has a turn: which is exactly what the correction was waiting behind.
    expect(waiting(view.host)).toEqual([CORRECTION]);
    expect(bubblesSaying(view.host, SECOND)).toBe(1);
    expect(unsentLines(view.host)).toHaveLength(1);
    expect(server.sends).toHaveLength(1);

    await acted(() => server.answerStreams());
    await finish(server);
    await view.waitFor(
      () => server.sends.length === 2,
      "both, sent once the turn was over",
      8000,
    );
    expect(askedIn(server.sends[1]).map((message) => message.content)).toEqual([
      CORRECTION,
      SECOND,
    ]);
    server.close();
    await view.unmount();
  });

  test("sent along to a server that is not there, it was not sent — and is not drawn as waiting for a job", async () => {
    const channelId = "channel_queued-carried-lost";
    leftWaiting(channelId, [{ id: "q-correction", text: CORRECTION }]);
    const server = turnServer({
      channelId,
      history: [EARLIER, EARLIER_ANSWER],
      holdStreams: true,
    });
    server.doorDown();
    const view = await open(channelId, server);
    await view.waitFor(
      () => waiting(view.host).length === 1,
      "the correction, waiting",
      8000,
    );
    await send(view, channelId, SECOND);
    await view.waitFor(() => server.sends.length === 1, "the send", 8000);
    await view.settle(200);
    expect(waiting(view.host)).toEqual([]);
    expect(bubblesSaying(view.host, CORRECTION)).toBe(1);
    expect(bubblesSaying(view.host, SECOND)).toBe(1);
    expect(unsentLines(view.host)).toHaveLength(2);
    server.close();
    await view.unmount();
  });
});

describe("the outbox, holding what waits for the Bot", () => {
  const AT = "2026-10-02T10:23:00.000Z";

  test("a waiting message is claimed once, by one tab, and is still marked as waiting while it goes", async () => {
    const outbox = await import("../src/components/channels/composer/outbox");
    outbox.keepUnsent("channel_wait-claim", {
      id: "m1",
      text: CORRECTION,
      instructions: [],
      at: AT,
      waiting: true,
    });
    const [kept] = outbox.readUnsent("channel_wait-claim");
    expect(kept && outbox.isWaitingForBot(kept)).toBe(true);

    const claimed = outbox.claimAutoSend("channel_wait-claim");
    expect(claimed.map((message) => message.id)).toEqual(["m1"]);
    // Another tab of the same conversation, hearing the same turn end a moment later.
    outbox.forgetUnsentCache();
    expect(outbox.claimAutoSend("channel_wait-claim")).toEqual([]);
    /*
     * On its way, not waiting any more — and still known as a first send, so nothing draws
     * "다시 보내는 중" under words that never failed.
     */
    const [onItsWay] = outbox.readUnsent("channel_wait-claim");
    expect(onItsWay).toMatchObject({ waiting: true, autoTried: true });
    expect(onItsWay && outbox.isWaitingForBot(onItsWay)).toBe(false);
  });

  test("is in the order things were typed, whichever was kept first", async () => {
    const outbox = await import("../src/components/channels/composer/outbox");
    // The correction was parked at once; the task before it was kept only when its send failed.
    outbox.keepUnsent("channel_wait-order", {
      id: "correction",
      text: CORRECTION,
      instructions: [],
      at: "2026-10-02T10:23:05.000Z",
      waiting: true,
    });
    outbox.keepUnsent("channel_wait-order", {
      id: "task",
      text: String(TASK.content),
      instructions: [],
      at: "2026-10-02T10:23:00.000Z",
    });
    outbox.keepUnsent("channel_wait-order", {
      id: "later",
      text: SECOND,
      instructions: [],
      at: "2026-10-02T10:23:09.000Z",
      waiting: true,
    });
    expect(
      outbox.readUnsent("channel_wait-order").map((message) => message.id),
    ).toEqual(["task", "correction", "later"]);
    // Kept again under its id, a message stays where it is.
    outbox.keepUnsent("channel_wait-order", {
      id: "correction",
      text: CORRECTION,
      instructions: [],
      at: "2026-10-02T10:23:05.000Z",
    });
    expect(
      outbox.claimAutoSend("channel_wait-order").map((message) => message.id),
    ).toEqual(["task", "correction", "later"]);
  });

  test("a message that only failed to leave is stored as it always was", async () => {
    const outbox = await import("../src/components/channels/composer/outbox");
    outbox.keepUnsent("channel_wait-shape", {
      id: "m2",
      text: CORRECTION,
      instructions: [],
      at: AT,
    });
    const stored = JSON.parse(
      localStorage.getItem("laf:unsent:channel_wait-shape") ?? "[]",
    ) as Record<string, unknown>[];
    expect(Object.keys(stored[0] ?? {}).sort()).toEqual([
      "at",
      "autoTried",
      "id",
      "instructions",
      "text",
    ]);
    const [kept] = outbox.readUnsent("channel_wait-shape");
    expect(kept && outbox.isWaitingForBot(kept)).toBe(false);
  });

  test("a mark that is anything but true is read as no mark", async () => {
    const outbox = await import("../src/components/channels/composer/outbox");
    localStorage.setItem(
      "laf:unsent:channel_wait-odd",
      JSON.stringify([
        {
          id: "m3",
          text: CORRECTION,
          instructions: [],
          at: AT,
          autoTried: false,
          waiting: "yes",
        },
      ]),
    );
    const [kept] = outbox.readUnsent("channel_wait-odd");
    expect(kept && "waiting" in kept).toBe(false);
  });

  test("what a storage that refuses could not take is claimed from this tab, once", async () => {
    const outbox = await import("../src/components/channels/composer/outbox");
    const restore = refusingStorage();
    try {
      outbox.keepUnsent("channel_wait-full", {
        id: "m4",
        text: CORRECTION,
        instructions: [],
        at: AT,
        waiting: true,
      });
      /*
       * The claim reads storage, where another tab would have written its own. Storage held
       * nothing, and the claim took that as the truth: nothing to send, and nothing kept either.
       */
      expect(
        outbox.claimAutoSend("channel_wait-full").map((message) => message.id),
      ).toEqual(["m4"]);
      expect(outbox.readUnsent("channel_wait-full")).toHaveLength(1);
      expect(outbox.claimAutoSend("channel_wait-full")).toEqual([]);
    } finally {
      restore();
    }
  });
});
