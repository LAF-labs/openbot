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
  BOT_ID,
  channelServer,
  type WireMessage,
} from "./support/channel-server";

/**
 * WHAT SOMEBODY TYPED WHILE THE SERVER WAS GONE IS NOT LOST ON A RELOAD, AND GOES WHEN IT IS BACK.
 *
 * MEASURED 2026-09-24 (UI/UX audit 0.5.3, item 6) on a local stack: the API stopped, "오늘 마감
 * 체크리스트 써 줘" sent — "서버에 닿지 못했습니다 [다시 시도]" under it. The server came back and
 * nothing was sent; a reload and the message was gone without a trace. The server keeps a person's
 * words when a run begins, so the one message it can lose is the one whose run never reached it —
 * and that one is kept on the device now (`composer/outbox.ts`).
 */

/*
 * At phone width, for the file after it: mounting the conversation leaves the window's width in
 * `lib/computer/screen-panel.ts` for the rest of the process, and `detail-sheet.test.tsx` draws its
 * sheet only at 375px (see `draft-to-composer.test.tsx`). Nothing here depends on the width.
 */
beforeAll(async () => {
  await installAppDom();
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
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const EARLIER = { id: "q-earlier", role: "user", content: "오늘 날짜 알려줘" };
const EARLIER_ANSWER = {
  id: "a-earlier",
  role: "assistant",
  content: "오늘은 9월 24일이에요.",
};
const TYPED = "오늘 마감 체크리스트 써 줘";
const ANSWER = "불 끄고 문 잠그세요.";
const unsentLine = '[data-testid="transcript-unsent"]';

const userMessages = (messages: readonly WireMessage[] = []) =>
  messages.filter((message) => message.role === "user");

const bubblesSaying = (host: HTMLElement, words: string) =>
  [
    ...host.querySelectorAll('[role="log"] [data-slot="bubble-content"]'),
  ].filter((bubble) => bubble.textContent?.trim() === words).length;

/** What a tab that lost the server left behind: the words, under the id they were sent with. */
function keptOnThisDevice(channelId: string, autoTried = false) {
  localStorage.setItem(
    `laf:unsent:${channelId}`,
    JSON.stringify([
      {
        id: "q-typed",
        text: TYPED,
        instructions: [],
        at: "2026-09-24T10:23:00.000Z",
        autoTried,
      },
    ]),
  );
}

describe("a message the server never got", () => {
  test("is kept on this device when the run cannot reach the server", async () => {
    const { stashFirstMessage } = await import(
      "../src/components/channels/transcript-messages"
    );
    const channelId = "channel_unsent-kept";
    stashFirstMessage(channelId, TYPED);
    const server = channelServer({
      channelId,
      runs: [() => new Response("Bad Gateway", { status: 502 })],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => view.host.querySelector(unsentLine) !== null,
      "the not-sent line",
      8000,
    );
    const kept = JSON.parse(
      localStorage.getItem(`laf:unsent:${channelId}`) ?? "[]",
    ) as { id: string; text: string }[];
    expect(kept.map((message) => message.text)).toEqual([TYPED]);
    // Under the id the run tried to send it with, so sending it again is the same message.
    expect(kept[0]?.id).toBe(
      userMessages(server.runs[0]?.messages)[0]?.id ?? "",
    );
    expect(view.host.querySelector(unsentLine)?.textContent).toContain(
      "It goes once by itself when the connection is back.",
    );
    await view.unmount();
  });

  test("is still there after a reload, and goes by itself once the server answers", async () => {
    const channelId = "channel_unsent-reload";
    keptOnThisDevice(channelId);
    const server = channelServer({
      channelId,
      history: [EARLIER, EARLIER_ANSWER],
      runs: [answering(ANSWER)],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => bubblesSaying(view.host, ANSWER) === 1,
      "the answer to the kept message",
      8000,
    );
    // Sent once, under the id it was kept with, after what the thread already held.
    expect(server.runs).toHaveLength(1);
    expect(
      userMessages(server.runs[0]?.messages).map((message) => message.id),
    ).toEqual(["q-earlier", "q-typed"]);
    expect(bubblesSaying(view.host, TYPED)).toBe(1);
    expect(view.host.querySelector(unsentLine)).toBeNull();
    expect(view.host.textContent).toContain(
      "Sent when the connection came back.",
    );
    expect(ko["Sent when the connection came back."]).toBe(
      "다시 연결돼서 보냈어요.",
    );
    // The server has it now; the device keeps nothing.
    expect(localStorage.getItem(`laf:unsent:${channelId}`)).toBeNull();
    await view.unmount();
  });

  test("goes by itself only once, and then waits for the person", async () => {
    const channelId = "channel_unsent-tried";
    keptOnThisDevice(channelId, true);
    const server = channelServer({
      channelId,
      history: [EARLIER, EARLIER_ANSWER],
      runs: [answering(ANSWER)],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => view.host.querySelector(unsentLine) !== null,
      "the kept message and its line",
      8000,
    );
    await view.settle(200);
    expect(server.runs).toHaveLength(0);
    expect(bubblesSaying(view.host, TYPED)).toBe(1);

    await view.click(view.buttonNamed("Send again") as Element);
    await view.waitFor(
      () => bubblesSaying(view.host, ANSWER) === 1,
      "the answer to the message sent again",
      8000,
    );
    expect(
      userMessages(server.runs[0]?.messages).map((message) => message.id),
    ).toEqual(["q-earlier", "q-typed"]);
    expect(view.host.querySelector(unsentLine)).toBeNull();
    await view.unmount();
  });

  /*
   * Review of the typed-answer change, third round. Words a turn the server owned kept for a card
   * (`answerTo`) are left out of every hand-over until it is known what became of them. A
   * deployment can then be switched to turns the window drives: this screen drew them 보내지 못함,
   * and its 다시 보내기 could neither send them nor take them away. They are settled here once the
   * conversation is in — and not on a press, which decided from a thread that had not arrived.
   */
  describe("words a turn the server owned kept for a card, on this screen", () => {
    // As the screen that asks the card writes them: waiting for the Bot, with the card's call.
    const keptForACard = (channelId: string, answerTo: string) =>
      localStorage.setItem(
        `laf:unsent:${channelId}`,
        JSON.stringify([
          {
            id: "q-typed",
            text: TYPED,
            instructions: [],
            at: "2026-09-24T10:23:00.000Z",
            autoTried: false,
            waiting: true,
            answerTo,
          },
        ]),
      );
    const keptNow = (channelId: string) =>
      JSON.parse(localStorage.getItem(`laf:unsent:${channelId}`) ?? "[]") as {
        answerTo?: string;
        waiting?: boolean;
        autoTried?: boolean;
      }[];
    const asking = (callId: string) => ({
      id: "a-choice",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: callId,
          type: "function",
          function: {
            name: "askChoice",
            arguments: JSON.stringify({
              title: "무엇을 쓸까요?",
              options: [{ id: "a", label: "체크리스트" }],
            }),
          },
        },
      ],
    });

    test("are the person's to send, where the conversation shows nothing of what became of their card", async () => {
      const channelId = "channel_unsent-answer";
      keptForACard(channelId, "call-gone");
      const server = channelServer({
        channelId,
        history: [EARLIER, EARLIER_ANSWER],
        runs: [answering(ANSWER)],
      });
      const view = await mountApp({
        path: `/channel/${channelId}`,
        api: server.api,
      });
      await view.waitFor(
        () => keptNow(channelId)[0]?.autoTried === true,
        "them to be handed to the person once the conversation is in",
        8000,
      );
      await view.settle(200);
      // They may have been the card's answer: never by themselves. The line, and the person's press.
      expect(keptNow(channelId)[0]?.waiting).toBeUndefined();
      expect(server.runs).toHaveLength(0);
      expect(view.host.querySelector(unsentLine)).not.toBeNull();

      await view.click(view.buttonNamed("Send again") as Element);
      await view.waitFor(
        () => bubblesSaying(view.host, ANSWER) === 1,
        "the answer to the words sent as a message",
        8000,
      );
      expect(
        userMessages(server.runs[0]?.messages).map((message) => message.id),
      ).toEqual(["q-earlier", "q-typed"]);
      expect(view.host.querySelector(unsentLine)).toBeNull();
      await view.unmount();
    });

    test("go once by themselves, where the conversation shows the question over some other way", async () => {
      const channelId = "channel_unsent-passed";
      keptForACard(channelId, "call-1");
      const server = channelServer({
        channelId,
        history: [
          EARLIER,
          asking("call-1"),
          {
            id: "r-choice",
            role: "tool",
            toolCallId: "call-1",
            content: JSON.stringify({ ok: false, code: "laf:stopped" }),
          },
          EARLIER_ANSWER,
        ] as unknown as WireMessage[],
        runs: [answering(ANSWER)],
      });
      const view = await mountApp({
        path: `/channel/${channelId}`,
        api: server.api,
      });
      // Not the card's answer, whatever it was: words typed mid-turn, and the turn is long over.
      await view.waitFor(
        () => bubblesSaying(view.host, ANSWER) === 1,
        "the answer to the words, sent by themselves",
        8000,
      );
      expect(server.runs).toHaveLength(1);
      expect(
        userMessages(server.runs[0]?.messages).map((message) => message.id),
      ).toContain("q-typed");
      expect(localStorage.getItem(`laf:unsent:${channelId}`)).toBeNull();
      await view.unmount();
    });

    /*
     * Review, fifth round. The gate before the first message opens whether or not the history
     * came, and these words were settled when it did: against a conversation that had not arrived
     * they were handed to the person as theirs to send, for good, though the record held them as
     * the card's answer — and their press, or the next thing they said, sent them a second time.
     */
    test("are left as they are while the conversation cannot be read, and settled when it is", async () => {
      const channelId = "channel_unsent-unread";
      keptForACard(channelId, "call-1");
      const server = channelServer({
        channelId,
        history: [
          EARLIER,
          asking("call-1"),
          {
            id: "r-choice",
            role: "tool",
            toolCallId: "call-1",
            content: JSON.stringify({ answer: TYPED }),
          },
          EARLIER_ANSWER,
        ] as unknown as WireMessage[],
        runs: [answering(ANSWER)],
      });
      let isHistoryDown = true;
      const view = await mountApp({
        path: `/channel/${channelId}`,
        api: (request) =>
          isHistoryDown && request.pathname.includes("/copilotkit/threads/")
            ? new Response("", { status: 503 })
            : server.api(request),
      });
      await view.settle(1500);
      // Not theirs to send, not sent, not forgotten: nothing is known of their card yet.
      expect(keptNow(channelId)).toMatchObject([
        { answerTo: "call-1", waiting: true, autoTried: false },
      ]);
      expect(server.runs).toHaveLength(0);
      // Nor drawn as not sent, over a press that would send nothing.
      expect(view.host.querySelector(unsentLine) === null).toBe(true);
      expect(bubblesSaying(view.host, TYPED)).toBe(0);

      // The record can be read again, and something says to read it: a Bot spoke.
      isHistoryDown = false;
      const { channelActivity, CHANNEL_ACTIVITY } = await import(
        "../src/lib/channels/use-channel-events"
      );
      channelActivity.dispatchEvent(
        new CustomEvent(CHANNEL_ACTIVITY, {
          detail: { channelId, lastMessageAgentId: BOT_ID },
        }),
      );
      await view.waitFor(
        () => localStorage.getItem(`laf:unsent:${channelId}`) === null,
        "the words to be forgotten once the conversation is in",
        8000,
      );
      expect(server.runs).toHaveLength(0);
      await view.unmount();
    });

    test("are forgotten, and never sent, where the conversation shows the card answered with them", async () => {
      const channelId = "channel_unsent-answered";
      keptForACard(channelId, "call-1");
      const asked = asking("call-1");
      const answered = {
        id: "r-choice",
        role: "tool",
        toolCallId: "call-1",
        content: JSON.stringify({ answer: TYPED }),
      };
      const server = channelServer({
        channelId,
        history: [
          EARLIER,
          asked,
          answered,
          EARLIER_ANSWER,
        ] as unknown as WireMessage[],
        runs: [answering(ANSWER)],
      });
      const view = await mountApp({
        path: `/channel/${channelId}`,
        api: server.api,
      });
      await view.waitFor(
        () => localStorage.getItem(`laf:unsent:${channelId}`) === null,
        "the words to be forgotten once the conversation is in",
        8000,
      );
      await view.settle(200);
      expect(view.host.querySelector(unsentLine)).toBeNull();
      expect(server.runs).toHaveLength(0);
      await view.unmount();
    });
  });

  test("offline, says to check the internet, and goes when the connection is back", async () => {
    const channelId = "channel_unsent-offline";
    keptOnThisDevice(channelId);
    let isOnline = false;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => isOnline,
    });
    try {
      const server = channelServer({
        channelId,
        history: [EARLIER, EARLIER_ANSWER],
        runs: [answering(ANSWER)],
      });
      const view = await mountApp({
        path: `/channel/${channelId}`,
        api: server.api,
      });
      await view.waitFor(
        () => view.host.querySelector(unsentLine) !== null,
        "the kept message",
        8000,
      );
      await view.settle(200);
      // No network: nothing is tried, and the line says where the problem is.
      expect(server.runs).toHaveLength(0);
      expect(view.host.querySelector(unsentLine)?.textContent).toContain(
        "Check your internet connection.",
      );
      expect(ko["Check your internet connection."]).toBe(
        "인터넷 연결을 확인해 주세요.",
      );

      const { socketState, SOCKET_RECONNECTED } = await import(
        "../src/lib/channels/use-channel-events"
      );
      isOnline = true;
      socketState.dispatchEvent(new Event(SOCKET_RECONNECTED));
      await view.waitFor(
        () => bubblesSaying(view.host, ANSWER) === 1,
        "the answer once the connection is back",
        8000,
      );
      expect(server.runs).toHaveLength(1);
      expect(view.host.textContent).toContain(
        "Sent when the connection came back.",
      );
      await view.unmount();
    } finally {
      delete (navigator as { onLine?: boolean }).onLine;
    }
  });
});

describe("the kept list itself", () => {
  test("a second claim on the one automatic send gets nothing", async () => {
    const outbox = await import("../src/components/channels/composer/outbox");
    outbox.keepUnsent("channel_claim", {
      id: "m1",
      text: TYPED,
      instructions: [],
      at: "2026-09-24T10:23:00.000Z",
    });
    expect(
      outbox.claimAutoSend("channel_claim").map((message) => message.id),
    ).toEqual(["m1"]);
    // Another tab of the same conversation, hearing the same reconnect a moment later.
    outbox.forgetUnsentCache();
    expect(outbox.claimAutoSend("channel_claim")).toEqual([]);
    // Still kept, for the person to send.
    expect(outbox.readUnsent("channel_claim")).toHaveLength(1);
    outbox.forgetUnsent("channel_claim", ["m1"]);
    expect(outbox.readUnsent("channel_claim")).toHaveLength(0);
  });

  test("keeps nothing but the words and what was asked with them", async () => {
    const outbox = await import("../src/components/channels/composer/outbox");
    outbox.keepUnsent("channel_shape", {
      id: "m2",
      text: TYPED,
      instructions: ["주간 보고 형식으로"],
      at: "2026-09-24T10:23:00.000Z",
    });
    const stored = JSON.parse(
      localStorage.getItem("laf:unsent:channel_shape") ?? "[]",
    ) as Record<string, unknown>[];
    expect(Object.keys(stored[0] ?? {}).sort()).toEqual([
      "at",
      "autoTried",
      "id",
      "instructions",
      "text",
    ]);
  });

  test("a storage that refuses is the same as nothing kept, and nothing throws", async () => {
    const outbox = await import("../src/components/channels/composer/outbox");
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      outbox.keepUnsent("channel_full", {
        id: "m3",
        text: TYPED,
        instructions: [],
        at: "2026-09-24T10:23:00.000Z",
      });
      // Kept for this tab, then: still drawn, still sent when the connection returns.
      expect(outbox.readUnsent("channel_full")).toHaveLength(1);
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });
});
