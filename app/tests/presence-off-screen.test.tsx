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
import {
  acted,
  BOT_ID,
  installTurnStreams,
  removeTurnStreams,
  THREAD_ID,
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
function server(options: {
  going: boolean;
  holdFirstList?: boolean;
  /** The conversation's stream is left unanswered until `turns.answerStreams()`. */
  holdStreams?: boolean;
}) {
  const turns = turnServer({
    channelId: CHANNEL,
    history: [ASKED],
    turn: options.going
      ? { id: "turn-1", status: "running", asked: [ASKED.id] }
      : null,
    ...(options.holdStreams ? { holdStreams: true } : {}),
  });
  const state = { listed: options.going, workingReads: 0 };
  /** The first list, kept on its way: written before the turn began, so it names nobody. */
  let releaseFirstList = () => {};
  const firstListHeld = new Promise<void>((resolve) => {
    releaseFirstList = resolve;
  });
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
      if (options.holdFirstList && state.workingReads === 1) {
        return firstListHeld.then(() => json({ working: [] }));
      }
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
  return { api, turns, state, releaseFirstList: () => releaseFirstList() };
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

  /*
   * Codex, on the pull request: the list is timed by when it arrived, and a list asked for before
   * the turn began can arrive after the conversation has left. While the list has never been
   * answered, invalidating it does not start a second request — the first is kept going — so the
   * stale answer landed "after the leaving", named nobody, and the pill said Ready until the poll.
   */
  test("a list already on its way when the conversation left does not speak for the turn it left behind", async () => {
    const { api, state, releaseFirstList } = server({
      going: true,
      holdFirstList: true,
    });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(
      () => pill(view.host) === "Thinking",
      "the conversation to tell its turn",
      6000,
    );
    expect(state.workingReads).toBe(1);

    await view.navigate("/made");
    expect(pill(view.host)).toBe("Busy working");
    // Asked again, after the leaving — not the request that was already out.
    await view.waitFor(
      () => state.workingReads >= 2,
      "a list asked for after leaving",
      2000,
    );
    // The old one lands now, naming nobody. It was written before the turn began.
    await acted(() => releaseFirstList());
    await view.settle(60);
    expect(pill(view.host)).toBe("Busy working");
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

  /*
   * Codex, second round on the pull request. The list was read while the turn ran and names it; the
   * conversation then sees the turn end — stopped, with nothing said, so no frame refreshes the
   * list — and the person leaves. The old list must not bring the turn back on the next screen.
   */
  test("a turn the conversation saw end stays ended on the next screen, whatever the old list says", async () => {
    const { api, turns, state } = server({ going: true });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(
      () => pill(view.host) === "Thinking",
      "the conversation to tell its turn",
      6000,
    );
    await view.waitFor(
      () => state.workingReads >= 1,
      "the list, read while the turn ran",
    );
    await view.settle(50);
    await acted(() => turns.announce("stopped"));
    await view.waitFor(
      () => pill(view.host) === "Ready",
      "the pill to follow the conversation",
      4000,
    );
    const readsBefore = state.workingReads;

    await view.navigate("/made");
    await view.settle(80);
    expect(pill(view.host)).toBe("Ready");
    // Nothing asked the server again: it is the conversation's last word that holds the pill.
    expect(state.workingReads).toBe(readsBefore);
  });

  /*
   * Measured on the running app, 2026-10-02, with the first version of this fix: back in the
   * conversation mid-turn, the pill read 일하는 중 (소식) → 쉬는 중 for a quarter of a second → 일하는
   * 중. A conversation that has just come on screen has not heard how its turn stands; its "idle"
   * was being taken as its word.
   */
  test("a conversation that has not heard its turn yet does not speak for it", async () => {
    const { api, turns } = server({ going: true, holdStreams: true });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    // On screen, its stream not yet answered: the server's list is still the one that knows.
    await view.waitFor(
      () => pill(view.host) === "Busy working",
      "the list to speak while the conversation has not heard",
      6000,
    );
    await view.settle(60);
    expect(pill(view.host)).toBe("Busy working");
    await acted(() => turns.answerStreams());
    await view.waitFor(
      () => pill(view.host) === "Thinking",
      "the conversation to tell its turn once it has heard",
      4000,
    );
  });

  /*
   * Codex, third round: with the telling held back until the stream has spoken, the leaving had been
   * held back with it. A send still on its way publishes "thinking" before any stream answers; a
   * person who left then left that word behind for good — the pill said Thinking from then on.
   */
  test("a conversation that leaves before it has heard still takes its phase back", async () => {
    const { api, turns } = server({ going: false, holdStreams: true });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(
      () => view.host.querySelector('[aria-label="Message"]') !== null,
      "the composer",
      6000,
    );
    // The hand-over is kept on its way: this window's own send is all it knows of a turn.
    turns.holdDoor();
    const { offerDraft } = await import(
      "../src/components/channels/composer/prefill"
    );
    await acted(() => offerDraft(CHANNEL, "표로 정리해 줘"));
    await view.waitFor(
      () =>
        view.host
          .querySelector('[aria-label="Message"]')
          ?.textContent?.trim() === "표로 정리해 줘",
      "the words in the composer",
      4000,
    );
    const send = view.host.querySelector('button[aria-label="Send message"]');
    if (!send) throw new Error("no send button");
    await view.click(send);
    await view.waitFor(
      () => pill(view.host) === "Thinking",
      "the send on its way to read as thinking",
      4000,
    );

    await view.navigate("/made");
    await view.waitFor(
      () => pill(view.host) === "Ready",
      "the pill to stop saying Thinking once the server's list says nobody is working",
      4000,
    );
    await acted(() => turns.answerDoor());
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
