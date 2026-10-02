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
 * WHAT THE BOT IS DOING, SAID ON THE SCREENS THAT ARE NOT ITS CONVERSATION.
 *
 * Measured on the running app, 2026-10-02: "올해 달라진 청년 대상 정부 지원 제도를 웹에서 세 가지
 * 찾아서…" was sent and 소식 was opened a second later. Seven seconds in, `/api/agents/working` had
 * the Bot's chat run going and the conversation's row in the sidebar read "처리 중…" — and the pill
 * under the Bot's name, an inch above that row, read "쉬는 중". It went on reading it until the
 * answer landed.
 *
 * The turn is the server's and does not stop when its conversation leaves the screen; the pill was
 * told the turn only by a mounted conversation, which takes its word back as it goes.
 */

const CHANNEL = "channel_off-screen";
const ASKED: Message = {
  id: "q-1",
  role: "user",
  content: "올해 달라진 청년 지원 제도 세 가지 찾아 줘",
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

/** The server of one conversation, and its own list of who is working. */
function server(options: { going: boolean }) {
  const turns = turnServer({
    channelId: CHANNEL,
    history: [ASKED],
    turn: options.going
      ? { id: "turn-1", status: "running", asked: [ASKED.id] }
      : null,
  });
  const state = { listed: options.going, workingReads: 0 };
  const api = (request: ApiRequest) => {
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
    if (request.pathname === "/api/agents/working") {
      state.workingReads += 1;
      return json({
        working: state.listed
          ? [
              {
                agentId: BOT_ID,
                origin: "chat",
                label: "올해 달라진 청년 지원 제도",
                startedAt: "2026-10-02T09:04:07.573Z",
              },
            ]
          : [],
      });
    }
    return turns.api(request);
  };
  return { api, turns, state };
}

/** What the pill beside the Bot's name says: the sidebar's own row, outside the conversation. */
const pill = (host: HTMLElement) => {
  const row = [...host.querySelectorAll("a[aria-label]")].find((link) =>
    link.getAttribute("aria-label")?.startsWith("닻 · "),
  );
  const label = row?.getAttribute("aria-label") ?? "";
  return label.slice("닻 · ".length).replace(/\. Bot profile$/, "");
};

describe("the pill, once the conversation has left the screen", () => {
  test("a turn that is still going reads as working on another screen, and as ready when it ends", async () => {
    const { api, turns, state } = server({ going: true });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(
      () => pill(view.host) === "Thinking",
      "the conversation to tell its turn",
      6000,
    );

    const readsBefore = state.workingReads;
    await view.navigate("/made");
    // No "Ready" on the way: the turn that was going when the conversation left is still going.
    expect(pill(view.host)).toBe("Busy working");
    // And once the server's list has been read again, it is the list that says so.
    await view.waitFor(
      () => state.workingReads > readsBefore,
      "the server's list to be read after leaving",
    );
    await view.settle(50);
    expect(pill(view.host)).toBe("Busy working");

    // It ends where nobody is watching; the list, read again, no longer names it.
    await acted(() => turns.announce("done"));
    state.listed = false;
    await acted(async () => {
      const { workingKeys } = await import("../src/lib/agents/working");
      await view.queryClient.invalidateQueries({ queryKey: workingKeys.all });
    });
    await view.waitFor(
      () => pill(view.host) === "Ready",
      "the pill to say the Bot is free",
      4000,
    );
  });

  test("leaving asks the server at once, rather than waiting for the poll", async () => {
    const { api, state } = server({ going: true });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(
      () => pill(view.host) === "Thinking",
      "the conversation to tell its turn",
      6000,
    );
    await view.settle(50);
    const before = state.workingReads;
    await view.navigate("/made");
    await view.waitFor(
      () => state.workingReads > before,
      "the list to be read again on leaving",
      2000,
    );
  });

  test("a list that still names a turn the conversation saw end does not hold the pill on working", async () => {
    // The poll is the staler of the two: it names the run for a moment after the stream said done.
    const { api, turns } = server({ going: true });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(
      () => pill(view.host) === "Thinking",
      "the conversation to tell its turn",
      6000,
    );
    await acted(() => turns.announce("done"));
    await view.waitFor(
      () => pill(view.host) === "Ready",
      "the pill to follow the conversation",
      4000,
    );
  });

  test("a conversation with nothing going leaves nothing behind", async () => {
    const { api } = server({ going: false });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(() => pill(view.host) === "Ready", "the pill", 6000);
    await view.navigate("/made");
    await view.settle(50);
    expect(pill(view.host)).toBe("Ready");
  });
});
