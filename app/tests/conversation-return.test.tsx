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
import { BOT_ID, THREAD_ID } from "./support/channel-server";
import {
  acted,
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * COMING BACK TO THE CONVERSATION FINDS IT AS IT WAS.
 *
 * Pressed on the running app, 2026-10-02: from 대화 to 소식 and back. 60 ms after the press the
 * screen drew the Bot's greeting — "안녕하세요, 저는 새벽이에요. 부탁하시면 제가 직접 찾아보고…" —
 * above an empty conversation; 313 ms after it the history had been read again and thirty-three
 * bubbles took the greeting's place. On the local stack, where the server is a millisecond away.
 * The screen a person returns to most said hello again every time.
 *
 * Mounted at the network edge, with the read of the history held on its way: what is on the screen
 * before that read answers is what somebody sees while it is out.
 */

const CHANNEL = "channel_return";
const ASKED: Message = {
  id: "q-1",
  role: "user",
  content: "내일 날씨 알려 줘",
};
const ANSWERED: Message = {
  id: "a-1",
  role: "assistant",
  content: "내일은 맑고 최고 26도예요.",
};

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
});
setDefaultTimeout(30_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

/** One conversation's server, whose read of the history a test can keep on its way. */
function server(history: Message[]) {
  const turns = turnServer({ channelId: CHANNEL, history, turn: null });
  const state = { holding: false, reads: 0 };
  let release = () => {};
  let held = new Promise<void>((resolve) => {
    release = resolve;
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
    if (request.pathname === `/api/turns/${THREAD_ID}/history`) {
      state.reads += 1;
      if (state.holding) {
        const waiting = held;
        return waiting.then(() => turns.api(request) as Response);
      }
    }
    return turns.api(request);
  };
  return {
    api,
    turns,
    state,
    /** Reads of the history from now on are kept on their way until `releaseHistory`. */
    holdHistory: () => {
      state.holding = true;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    releaseHistory: () => {
      state.holding = false;
      release();
    },
  };
}

/** Whether the Bot's greeting is drawn. A yes or no: an element in a failed expectation is the whole page. */
const greets = (host: HTMLElement) =>
  host.querySelector("[data-greeting]") !== null;
/** Whether anything of a conversation is drawn at all. */
const hasBubbles = (host: HTMLElement) =>
  host.querySelector('[data-slot="bubble-content"]') !== null;
const says = (host: HTMLElement, words: string) =>
  [...host.querySelectorAll('[data-slot="bubble-content"]')].some((bubble) =>
    bubble.textContent?.includes(words),
  );

describe("coming back from another place", () => {
  test("the conversation is on the screen at once, while its history is still being read again", async () => {
    const { api, holdHistory, releaseHistory } = server([ASKED, ANSWERED]);
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(() => says(view.host, "최고 26도"), "the answer", 6000);

    await view.navigate("/made");
    expect(says(view.host, "최고 26도")).toBe(false);

    holdHistory();
    await view.navigate(`/channel/${CHANNEL}`);
    // Nothing has answered: this is what somebody sees while the read is out.
    expect(says(view.host, "최고 26도")).toBe(true);
    await acted(() => releaseHistory());
    await view.settle(100);
    expect(says(view.host, "최고 26도")).toBe(true);
  });

  test("what a routine delivered meanwhile is there too", async () => {
    const delivered: Message = {
      id: "a-2",
      role: "assistant",
      content: "아침 브리핑이에요. 오늘은 흐려요.",
    };
    const { api, turns } = server([ASKED, ANSWERED]);
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(() => says(view.host, "최고 26도"), "the answer", 6000);

    await view.navigate("/made");
    // Written by something that is not a turn: no frame on the conversation's stream says so.
    turns.deliver([delivered]);
    await view.navigate(`/channel/${CHANNEL}`);
    await view.waitFor(
      () => says(view.host, "아침 브리핑"),
      "the routine's delivery",
      6000,
    );
    expect(says(view.host, "최고 26도")).toBe(true);
  });
});

describe("the rows of a conversation somebody came back to", () => {
  test("are drawn at once: the cascade is for a conversation that is arriving", async () => {
    const { createFirstPaintDelays } = await import(
      "../src/components/channels/chat-transcript"
    );
    // The newest of twelve rows, on the first paint that has any.
    expect(
      createFirstPaintDelays(false).delayFor("a-1", 11, 12),
    ).toBeGreaterThan(0);
    expect(createFirstPaintDelays(true).delayFor("a-1", 11, 12)).toBe(0);
  });
});

describe("a conversation opened for the first time", () => {
  test("does not say hello before it has been read", async () => {
    const { api, holdHistory, releaseHistory } = server([ASKED, ANSWERED]);
    holdHistory();
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.settle(150);
    // The read is out. Hello, above nothing, is what used to be drawn meanwhile.
    expect(hasBubbles(view.host)).toBe(false);
    expect(greets(view.host)).toBe(false);
    await acted(() => releaseHistory());
    await view.waitFor(() => says(view.host, "최고 26도"), "the answer", 6000);
  });

  test("and says hello when it turns out nothing has been said yet", async () => {
    const { api } = server([]);
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(() => greets(view.host), "the Bot's greeting", 6000);
  });
});
