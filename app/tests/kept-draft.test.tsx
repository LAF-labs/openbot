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
  keepDraft,
  keptDraft,
} from "../src/components/channels/composer/kept-draft";
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
 * WHAT WAS TYPED AND NOT SENT IS STILL IN THE BOX WHEN THE PERSON COMES BACK.
 *
 * Measured on the running app, 2026-10-02: a sentence typed into the conversation, 소식 opened, the
 * conversation opened again — an empty box. The composer let go of its text whenever it left the
 * screen. Here: the conversation is taken off the screen and drawn again, which is what going to
 * another screen and back is — and what a reload is, since the words are kept on the device.
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
const HALF_TYPED = "내일 오전 회의 안건 세 가지만 정리해";

type View = Awaited<ReturnType<typeof mountApp>>;

const composerText = (host: HTMLElement) =>
  host.querySelector('[aria-label="Message"]')?.textContent ?? "";

const atRest = (channelId: string) =>
  turnServer({ channelId, history: [EARLIER, EARLIER_ANSWER] });

const open = (channelId: string, server: ReturnType<typeof turnServer>) =>
  mountApp({ path: `/channel/${channelId}`, api: server.api });

/** Put words in the box the way another screen's offer does, which lands as typing lands. */
async function type(view: View, channelId: string, words: string) {
  const { offerDraft } = await import(
    "../src/components/channels/composer/prefill"
  );
  await acted(() => offerDraft(channelId, words));
  await view.waitFor(
    () => composerText(view.host).trim() === words,
    "the words in the composer",
    4000,
  );
}

describe("words typed and not sent", () => {
  test("are in the box again when the conversation is opened again", async () => {
    const channelId = "channel_draft-kept";
    const server = atRest(channelId);
    let view = await open(channelId, server);
    await type(view, channelId, HALF_TYPED);
    await view.settle(50);
    expect(keptDraft(channelId)).toBe(HALF_TYPED);

    // Another screen, or a reload: the conversation is gone from the screen and drawn again.
    await view.unmount();
    view = await open(channelId, server);
    await view.waitFor(
      () => composerText(view.host).trim() === HALF_TYPED,
      "the words back in the box",
      8000,
    );
    // Nothing was sent by coming back.
    expect(server.sends).toHaveLength(0);
    server.close();
    await view.unmount();
  });

  test("are not kept once they have been sent", async () => {
    const channelId = "channel_draft-sent";
    const server = atRest(channelId);
    let view = await open(channelId, server);
    await type(view, channelId, HALF_TYPED);
    const send = view.host.querySelector('button[aria-label="Send message"]');
    if (!send) throw new Error("no send button");
    await view.click(send);
    await view.waitFor(() => server.sends.length === 1, "the send", 8000);
    expect(askedIn(server.sends[0]).map((message) => message.content)).toEqual([
      HALF_TYPED,
    ]);
    await view.waitFor(
      () => keptDraft(channelId) === null,
      "nothing kept once it has gone",
      4000,
    );

    await view.unmount();
    view = await open(channelId, server);
    await view.settle(300);
    // It is a message now, not something to send twice.
    expect(composerText(view.host).trim()).toBe("");
    server.close();
    await view.unmount();
  });

  test("come back to the conversation they were typed in, and no other", async () => {
    const typedIn = "channel_draft-here";
    const other = "channel_draft-elsewhere";
    keepDraft(typedIn, HALF_TYPED);
    const server = atRest(other);
    const view = await open(other, server);
    await view.settle(300);
    expect(composerText(view.host).trim()).toBe("");
    // And opening the other one did not forget them.
    expect(keptDraft(typedIn)).toBe(HALF_TYPED);
    server.close();
    await view.unmount();
  });

  test("are not forgotten by a conversation that opens and is closed without a key pressed", async () => {
    const channelId = "channel_draft-untouched";
    keepDraft(channelId, HALF_TYPED);
    const server = atRest(channelId);
    let view = await open(channelId, server);
    await view.waitFor(
      () => composerText(view.host).trim() === HALF_TYPED,
      "the words back in the box",
      8000,
    );
    await view.unmount();
    expect(keptDraft(channelId)).toBe(HALF_TYPED);
    // And a second time, as many times as it is opened.
    view = await open(channelId, server);
    await view.waitFor(
      () => composerText(view.host).trim() === HALF_TYPED,
      "the words back in the box again",
      8000,
    );
    server.close();
    await view.unmount();
  });
});

describe("what the device keeps of a box", () => {
  test("is the words, by conversation, and nothing once the box is empty", () => {
    keepDraft("channel_a", "가나다");
    keepDraft("channel_b", "라마바");
    expect(keptDraft("channel_a")).toBe("가나다");
    expect(keptDraft("channel_b")).toBe("라마바");
    // Deleted by the person, or sent: the box is empty and so is what is kept.
    keepDraft("channel_a", "");
    expect(keptDraft("channel_a")).toBeNull();
    expect(localStorage.getItem("laf:draft:channel_a")).toBeNull();
    // Spaces are not something somebody typed and meant.
    keepDraft("channel_b", "   \n");
    expect(keptDraft("channel_b")).toBeNull();
    // Exactly as typed otherwise: the line breaks are the person's.
    keepDraft("channel_a", "첫 줄\n둘째 줄 ");
    expect(keptDraft("channel_a")).toBe("첫 줄\n둘째 줄 ");
    expect(keptDraft("channel_never")).toBeNull();
  });

  test("a device that keeps nothing is not a reason to fail", () => {
    const described = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(() => keepDraft("channel_a", "가나다")).not.toThrow();
      expect(keptDraft("channel_a")).toBeNull();
    } finally {
      if (described) {
        Object.defineProperty(globalThis, "localStorage", described);
      }
    }
  });
});
