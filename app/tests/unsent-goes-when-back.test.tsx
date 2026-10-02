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
 * WORDS THAT DID NOT LEAVE GO BY THEMSELVES WHEN THE CONNECTION IS BACK — ONCE, AND NOT BEFORE.
 *
 * Measured on the running app, 2026-10-02, with the door to the server made unreachable: one press
 * of send made TWO hand-overs 47 ms apart, the line under the message read "보내지 못함 [다시
 * 보내기]" at once, and when the connection came back nothing was sent — the message sat there
 * until somebody pressed. The line it should have read, "연결이 돌아오면 한 번 알아서 보내요", was
 * never drawn, because the one send a kept message gets by itself had already been spent: the
 * effect that sends what was kept "when a turn ends" also ran when a send ended, including the send
 * that had just failed, into the same server in the same instant.
 *
 * So a message typed on a train, or in the minute a server restarts, was never sent by itself —
 * the one thing keeping it on the device was for.
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
  const { forgetUnsentCache } = await import(
    "../src/components/channels/composer/outbox"
  );
  forgetUnsentCache();
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
const ASKED = "오늘 마감 체크리스트 써 줘";
const FOLLOW_UP = "표로 정리해서";
const WAITS = "Sends when the current job is done";
const GOES_BY_ITSELF = "It goes once by itself when the connection is back.";
const unsentLine = '[data-testid="transcript-unsent"]';

type View = Awaited<ReturnType<typeof mountApp>>;

/** What each not-sent line says, without the button beside it. */
const unsentLines = (host: HTMLElement) =>
  [...host.querySelectorAll(unsentLine)].map(
    (line) => line.querySelector("span")?.textContent ?? "",
  );

const composerText = (host: HTMLElement) =>
  host.querySelector('[aria-label="Message"]')?.textContent ?? "";

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

/** A conversation at rest: the Bot is free and nothing is being sent. */
const atRest = (channelId: string) =>
  turnServer({ channelId, history: [EARLIER, EARLIER_ANSWER] });

const open = (channelId: string, server: ReturnType<typeof turnServer>) =>
  mountApp({ path: `/channel/${channelId}`, api: server.api });

/** The browser saying the network is there again. */
const backOnline = () =>
  acted(() => {
    window.dispatchEvent(new Event("online"));
  });

describe("a message the server never got", () => {
  test("is handed over once, kept, and says it will go by itself", async () => {
    const channelId = "channel_unsent-once";
    const server = atRest(channelId);
    const view = await open(channelId, server);
    server.doorDown();
    await typeAndPress(view, channelId, ASKED, "Send message");
    await view.waitFor(
      () => view.host.querySelector(unsentLine) !== null,
      "the line saying it was not sent",
      8000,
    );
    // Long enough for a second hand-over to have gone, had one been on its way.
    await view.settle(400);
    // It was two, 47 ms apart: the same refusal asked for twice, and the one automatic send spent.
    expect(server.sends).toHaveLength(1);
    expect(ko[GOES_BY_ITSELF]).toBe("연결이 돌아오면 한 번 저절로 보내요.");
    expect(unsentLines(view.host)).toEqual([`Not sent · ${GOES_BY_ITSELF}`]);
    // One line about it, and it is the one under the person's own words.
    expect(view.host.textContent).not.toContain("No answer came back.");
    server.close();
    await view.unmount();
  });

  test("goes by itself, once, when the connection is back", async () => {
    const channelId = "channel_unsent-back";
    const server = atRest(channelId);
    const view = await open(channelId, server);
    server.doorDown();
    await typeAndPress(view, channelId, ASKED, "Send message");
    await view.waitFor(
      () => view.host.querySelector(unsentLine) !== null,
      "the line saying it was not sent",
      8000,
    );
    await view.settle(300);
    expect(server.sends).toHaveLength(1);

    server.doorUp();
    await backOnline();
    await view.waitFor(
      () => server.sends.length === 2,
      "the message, sent by itself once the connection was back",
      8000,
    );
    expect(askedIn(server.sends[1]).map((message) => message.content)).toEqual([
      ASKED,
    ]);
    await view.waitFor(
      () => view.host.querySelector(unsentLine) === null,
      "the not-sent line gone once the server has it",
      8000,
    );
    expect(localStorage.getItem(`laf:unsent:${channelId}`)).toBeNull();
    // Said under it, so nobody wonders whether pressing was needed.
    expect(view.host.textContent).toContain(
      "Sent when the connection came back.",
    );
    // And once: the same event again sends nothing more.
    await backOnline();
    await view.settle(300);
    expect(server.sends).toHaveLength(2);
    server.close();
    await view.unmount();
  });

  test("is the person's to send after its one try by itself has failed too", async () => {
    const channelId = "channel_unsent-twice";
    const server = atRest(channelId);
    const view = await open(channelId, server);
    server.doorDown();
    await typeAndPress(view, channelId, ASKED, "Send message");
    await view.waitFor(
      () => view.host.querySelector(unsentLine) !== null,
      "the line saying it was not sent",
      8000,
    );
    // The browser says the network is back and the server is still not there.
    await backOnline();
    await view.waitFor(
      () => server.sends.length === 2,
      "its one send by itself",
      8000,
    );
    await view.waitFor(
      () => unsentLines(view.host).join() === "Not sent",
      "the line no longer promising a send by itself",
      8000,
    );
    await backOnline();
    await view.settle(300);
    expect(server.sends).toHaveLength(2);
    expect(view.buttonNamed("Send again")).not.toBeNull();
    server.close();
    await view.unmount();
  });
});

describe("a message the server refused", () => {
  test("is handed over once and says so in one line, with the press that sends it", async () => {
    const channelId = "channel_refused-once";
    const server = atRest(channelId);
    const view = await open(channelId, server);
    // The door is there and says no: not a connection that will come back.
    server.doorRefuses("laf:turn_refused");
    await typeAndPress(view, channelId, ASKED, "Send message");
    await view.waitFor(
      () => view.host.querySelector(unsentLine) !== null,
      "the line saying it was not sent",
      8000,
    );
    await view.settle(400);
    expect(server.sends).toHaveLength(1);
    // No promise of a send by itself: nothing is coming back that would make one.
    expect(unsentLines(view.host)).toEqual(["Not sent"]);
    /*
     * ONE LINE FOR ONE FAILURE. It drew two — "보내지 못함 [다시 보내기]" under the message and
     * "답을 받지 못했어요 [다시 시도]" where the answer would be — with two buttons that did the
     * same thing, the second saying the Bot had not answered a message it was never given.
     */
    expect(view.host.textContent).not.toContain("No answer came back.");
    expect(
      view.host.querySelector('[data-testid="transcript-stopped"]'),
    ).toBeNull();

    server.doorAccepts();
    await view.click(view.buttonNamed("Send again") as Element);
    await view.waitFor(
      () => server.sends.length === 2,
      "the message, sent by the person's press",
      8000,
    );
    expect(askedIn(server.sends[1]).map((message) => message.content)).toEqual([
      ASKED,
    ]);
    server.close();
    await view.unmount();
  });
});

describe("a correction typed while a send was on its way", () => {
  test("is not left waiting for a job that never started, and goes with the message it follows", async () => {
    const channelId = "channel_unsent-follow-up";
    const server = atRest(channelId);
    const view = await open(channelId, server);
    server.doorDown();
    server.holdDoor();
    await typeAndPress(view, channelId, ASKED, "Send message");
    // The send is on its way, so the button queues; the follow-up waits for the job.
    await typeAndPress(view, channelId, FOLLOW_UP, "Queue message");
    await view.waitFor(
      () => view.host.textContent?.includes(WAITS) === true,
      "the follow-up drawn as waiting",
      4000,
    );
    // The send comes back: the server never took it. There is no job to wait behind.
    await acted(() => server.answerDoor());
    await view.waitFor(
      () => unsentLines(view.host).length === 2,
      "both said not sent",
      8000,
    );
    await view.settle(400);
    expect(view.host.textContent).not.toContain(WAITS);
    expect(server.sends).toHaveLength(1);
    expect(unsentLines(view.host)).toEqual([
      `Not sent · ${GOES_BY_ITSELF}`,
      `Not sent · ${GOES_BY_ITSELF}`,
    ]);

    server.doorUp();
    await backOnline();
    await view.waitFor(
      () => server.sends.length === 2,
      "both, sent by themselves once the connection was back",
      8000,
    );
    // In the order they were typed, as one turn.
    expect(askedIn(server.sends[1]).map((message) => message.content)).toEqual([
      ASKED,
      FOLLOW_UP,
    ]);
    server.close();
    await view.unmount();
  });
});
