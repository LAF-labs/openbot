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
import type { PendingApproval } from "../src/lib/approvals";
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
 * THE BOT STOPS TO ASK WHILE THE PERSON IS ON ANOTHER SCREEN OF THE APP — AND THAT SCREEN SAYS SO.
 *
 * The turn is the server's and goes on while the person reads 만든 것. When it stops on a question,
 * the server's outbox sends a frame down the page's socket; nothing on the page read the question
 * itself except the open conversation, so the pill went on saying what it said before and the
 * sidebar's 기다리는 일 stayed empty for the question's ten minutes.
 *
 * Mounted at the network edge, on a screen that is not the conversation. Not pressed on the running
 * app: see `shell-questions.test.ts`.
 */

const CHANNEL = "channel_q-off-screen";
const ASKED: Message = {
  id: "q-1",
  role: "user",
  content: "지난달 카드값 결제해 줘",
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
  const { forgetWatchedQuestions } = await import("../src/lib/turns/questions");
  forgetWatchedQuestions();
});
setDefaultTimeout(30_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

let asked = 0;
/** A question of its own for each test: what was decided on a call outlives its card. */
function question(): PendingApproval {
  asked += 1;
  return {
    id: `appr-${asked}`,
    botId: BOT_ID,
    rule: "",
    subject: {
      kind: "browser",
      intent: "activate",
      host: "pay.example",
      element: { role: "button", name: "결제하기" },
      reason: "policy_ask",
    },
    step: { threadId: THREAD_ID, toolCallId: `call-appr-${asked}` },
    requestedAt: "2026-10-02T09:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

/**
 * The browser's own Notification, which happy-dom does not have: permitted, and remembering what it
 * was asked to show. The page raises a notice by constructing one (`showWebNotice`).
 */
class ShownNotice {
  static permission = "granted";
  static shown: { title: string; tag: string | undefined }[] = [];
  onclick: (() => void) | null = null;
  constructor(title: string, options?: { tag?: string }) {
    ShownNotice.shown.push({ title, tag: options?.tag });
  }
  close() {}
}
function installNotices() {
  ShownNotice.shown = [];
  for (const target of [globalThis, window] as unknown as Record<
    string,
    unknown
  >[]) {
    target.Notification = ShownNotice;
  }
}
function removeNotices() {
  for (const target of [globalThis, window] as unknown as Record<
    string,
    unknown
  >[]) {
    delete target.Notification;
  }
}

/**
 * The server's outbox list, as the tests add to it. A frame is only the nudge: the page reads the
 * list and says what the list holds, so a row has to be in it for the frame to mean anything.
 */
type OutboxRow = {
  id: string;
  kind: string;
  botId: string;
  approvalId?: string;
  createdAt: string;
};
let outboxRows: OutboxRow[] = [];
let outboxClock = Date.parse("2026-10-02T09:00:01.000Z");

/** A second conversation with the same Bot: what an account that kept two has. */
const OTHER_CHANNEL = "channel_q-other";
const OTHER_THREAD = "thread-q-other";

function server(
  options: {
    alreadyTold?: PendingApproval;
    /** The outbox's list is kept on its way until `releaseTold`. */
    holdTold?: boolean;
    /** The account kept a second conversation with this Bot. */
    twoConversations?: boolean;
    /** How many times the outbox's list answers 503 before it answers. */
    toldFailures?: number;
    /** The record of open questions is kept on its way until `releaseApprovals`. */
    holdApprovals?: boolean;
  } = {},
) {
  outboxRows = [];
  const turns = turnServer({
    channelId: CHANNEL,
    history: [ASKED],
    turn: { id: "turn-1", status: "running", asked: [ASKED.id] },
  });
  const state = {
    approvals: options.alreadyTold
      ? [options.alreadyTold]
      : ([] as PendingApproval[]),
    reads: 0,
  };
  let releaseTold = () => {};
  const toldHeld = new Promise<void>((resolve) => {
    releaseTold = resolve;
  });
  let releaseApprovals = () => {};
  const approvalsHeld = new Promise<void>((resolve) => {
    releaseApprovals = resolve;
  });
  let toldReads = 0;
  const api = (request: ApiRequest) => {
    // The outbox's list: what was already waiting for this person when the page opened.
    if (request.pathname === "/api/me/notifications") {
      toldReads += 1;
      if (toldReads <= (options.toldFailures ?? 0)) {
        return new Response("", { status: 503 });
      }
      const since = request.url.searchParams.get("since");
      const rows: OutboxRow[] = [
        ...(options.alreadyTold
          ? [
              {
                id: `n-${options.alreadyTold.id}`,
                kind: "approval.requested",
                botId: BOT_ID,
                approvalId: options.alreadyTold.id,
                createdAt: "2026-10-02T09:00:00.500Z",
              },
            ]
          : []),
        ...outboxRows,
      ].filter((row) => !since || row.createdAt > since);
      // Newest first, as the server answers.
      const told = json({ notifications: rows.reverse() });
      return options.holdTold ? toldHeld.then(() => told) : told;
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
            lastMessageAt: "2026-10-02T09:00:00.000Z",
          },
          ...(options.twoConversations
            ? [
                {
                  id: OTHER_CHANNEL,
                  name: "닻",
                  agentIds: [BOT_ID],
                  threadId: OTHER_THREAD,
                  active: true,
                  unread: false,
                  lastMessageAt: "2026-10-01T09:00:00.000Z",
                },
              ]
            : []),
        ],
      });
    }
    if (request.pathname === `/api/approvals/${BOT_ID}`) {
      state.reads += 1;
      const record = () => json({ approvals: state.approvals });
      return options.holdApprovals ? approvalsHeld.then(record) : record();
    }
    return turns.api(request);
  };
  return {
    api,
    state,
    turns,
    toldReads: () => toldReads,
    releaseTold: () => releaseTold(),
    releaseApprovals: () => releaseApprovals(),
  };
}

/** The server's outbox, saying down the socket that the Bot stopped to ask. */
async function outboxSays(approvalId: string) {
  await outboxFrame({
    id: `n-${approvalId}`,
    event: "approval.requested",
    approvalId,
  });
}

/** A row written to the outbox: in its list from now on, and a frame down the socket. */
async function outboxFrame(row: {
  id: string;
  event: string;
  approvalId?: string;
}) {
  const { NOTIFICATION_FRAME, notificationFrames } = await import(
    "../src/lib/notifications/outbox"
  );
  outboxClock += 1_000;
  const at = new Date(outboxClock).toISOString();
  outboxRows.push({
    id: row.id,
    kind: row.event,
    botId: BOT_ID,
    ...(row.approvalId ? { approvalId: row.approvalId } : {}),
    createdAt: at,
  });
  await acted(() => {
    notificationFrames.dispatchEvent(
      new CustomEvent(NOTIFICATION_FRAME, {
        detail: { kind: "notification", botId: BOT_ID, at, ...row },
      }),
    );
  });
}

/** A window nobody is looking at, until the returned function is called. */
function windowHidden(): () => void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  return () => {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  };
}

const pill = (host: HTMLElement) => {
  const row = [...host.querySelectorAll("a[aria-label]")].find((link) =>
    link.getAttribute("aria-label")?.startsWith("닻 · "),
  );
  const label = row?.getAttribute("aria-label") ?? "";
  return label.slice("닻 · ".length).replace(/\. Bot profile$/, "");
};

/** The sidebar's rows under "Waiting on the owner". */
const waitingRows = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].filter((button) =>
    button.textContent?.includes("Approval needed"),
  );

describe("a question raised while another screen is open", () => {
  test("the pill turns to the person's turn and the sidebar lists it, with the way to the card", async () => {
    const { api, state } = server();
    const view = await mountApp({ path: "/made", api });
    await view.waitFor(() => pill(view.host) !== "", "the Bot's row", 6000);
    expect(pill(view.host)).not.toBe("Needs your OK");
    expect(waitingRows(view.host)).toHaveLength(0);

    const asking = question();
    state.approvals = [asking];
    await outboxSays(asking.id);

    await view.waitFor(
      () => pill(view.host) === "Needs your OK",
      "the pill to say the Bot is waiting on the person",
      4000,
    );
    await view.waitFor(
      () => waitingRows(view.host).length === 1,
      "the sidebar to list what is waiting",
      4000,
    );
    // The row is the way to the card: the conversation, on the line of the call that asked.
    const row = waitingRows(view.host)[0] as HTMLButtonElement;
    await view.click(row);
    await view.waitFor(
      () => view.router.state.location.pathname === `/channel/${CHANNEL}`,
      "the conversation to open",
      6000,
    );
  });

  test("answered somewhere else, the screen stops saying it is waiting", async () => {
    const { api, state } = server();
    const asking = question();
    state.approvals = [asking];
    const view = await mountApp({ path: "/made", api });
    // Open when the screen was: found by the look on mounting, with no frame at all.
    await view.waitFor(
      () => pill(view.host) === "Needs your OK",
      "the pill to say the Bot is waiting",
      6000,
    );
    state.approvals = [{ ...asking, granted: true }];
    await view.waitFor(
      () => pill(view.host) !== "Needs your OK",
      "the pill to stop saying it",
      6000,
    );
    expect(waitingRows(view.host)).toHaveLength(0);
  });

  test("with nothing open the shell does not go on asking the server", async () => {
    const { api, state } = server();
    const view = await mountApp({ path: "/made", api });
    await view.waitFor(() => state.reads >= 1, "the look on mounting", 6000);
    await view.settle(300);
    expect(state.reads).toBe(1);
  });
});

/*
 * Codex, on the pull request. The approval's own page puts the question on a line of its own, and
 * the shell's watch — mounted on that page as on every other — puts it on the conversation's. Two
 * lines for one question were two rows under 기다리는 일.
 */
describe("the approval's own page", () => {
  test("lists the question once in the sidebar, and the row leads to the conversation's card", async () => {
    const { api, state } = server();
    const asking = question();
    state.approvals = [asking];
    const view = await mountApp({ path: `/approve/${asking.id}`, api });
    await view.waitFor(
      () => pill(view.host) === "Needs your OK",
      "the pill to say the Bot is waiting",
      6000,
    );
    // Long enough for both lines to be registered: the page's own, and the shell's.
    await view.waitFor(
      () => state.reads >= 2,
      "the page and the shell to have read the record",
      4000,
    );
    await view.settle(80);
    expect(waitingRows(view.host)).toHaveLength(1);
    await view.click(waitingRows(view.host)[0] as HTMLButtonElement);
    await view.waitFor(
      () => view.router.state.location.pathname === `/channel/${CHANNEL}`,
      "the conversation to open",
      6000,
    );
  });
});

describe("whether the person is interrupted", () => {
  afterEach(() => removeNotices());

  test("on another screen of the app they are: a visible window with no card on it is not looking at the question", async () => {
    installNotices();
    const { api, state } = server();
    const view = await mountApp({ path: "/made", api });
    await view.waitFor(() => state.reads >= 1, "the look on mounting", 6000);
    await view.settle(50);
    expect(ShownNotice.shown).toHaveLength(0);

    const asking = question();
    state.approvals = [asking];
    await outboxSays(asking.id);
    await view.waitFor(
      () => ShownNotice.shown.length > 0,
      "the notice that the Bot is waiting",
      4000,
    );
    await view.settle(100);
    // Once, whichever of the two paths heard of it first.
    expect(ShownNotice.shown).toHaveLength(1);
    expect(ShownNotice.shown[0]?.title).toBe("닻 needs you");
  });

  test("in the Bot's own conversation they are not: the card is on the screen in front of them", async () => {
    installNotices();
    const { api, state } = server();
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(() => state.reads >= 1, "the conversation's look", 6000);
    const asking = question();
    state.approvals = [asking];
    await outboxSays(asking.id);
    await view.waitFor(
      () => pill(view.host) === "Needs your OK",
      "the question to be drawn",
      6000,
    );
    await view.settle(100);
    expect(ShownNotice.shown).toHaveLength(0);
  });

  test("a question that was already waiting when the page opened is shown, not shouted", async () => {
    installNotices();
    // The worst order: the question is on screen before the page has read what was already told.
    const { api, releaseTold } = server({
      alreadyTold: question(),
      holdTold: true,
    });
    const view = await mountApp({ path: "/made", api });
    await view.waitFor(
      () => pill(view.host) === "Needs your OK",
      "the pill to say the Bot is waiting",
      6000,
    );
    await view.settle(100);
    expect(ShownNotice.shown).toHaveLength(0);
    await acted(() => releaseTold());
    await view.settle(150);
    expect(ShownNotice.shown).toHaveLength(0);
  });

  test("and one the outbox's list does not name is said once that list has been read", async () => {
    installNotices();
    const { api, state, releaseTold } = server({ holdTold: true });
    const asking = question();
    state.approvals = [asking];
    const view = await mountApp({ path: "/made", api });
    await view.waitFor(
      () => pill(view.host) === "Needs your OK",
      "the pill to say the Bot is waiting",
      6000,
    );
    await view.settle(100);
    expect(ShownNotice.shown).toHaveLength(0);
    await acted(() => releaseTold());
    await view.waitFor(
      () => ShownNotice.shown.length === 1,
      "the notice, once the page knows it was not already told",
      4000,
    );
  });

  /*
   * Codex, second round. A list that could not be read marks nothing as told; letting the questions
   * effect go then announced every question that was open when the page was — on the page load
   * where the server was having a bad moment.
   */
  test("a first read the server did not answer does not turn what was already waiting into news", async () => {
    installNotices();
    const told = question();
    const { api, toldReads } = server({ alreadyTold: told, toldFailures: 1 });
    const view = await mountApp({ path: "/made", api });
    await view.waitFor(
      () => pill(view.host) === "Needs your OK",
      "the pill to say the Bot is waiting",
      6000,
    );
    await view.settle(150);
    expect(toldReads()).toBe(1);
    expect(ShownNotice.shown).toHaveLength(0);

    // The socket is back: the list is asked for again, answers, and names the question as told.
    const { SOCKET_RECONNECTED, socketState } = await import(
      "../src/lib/channels/use-channel-events"
    );
    await acted(() => {
      socketState.dispatchEvent(new Event(SOCKET_RECONNECTED));
    });
    await view.waitFor(
      () => toldReads() >= 2,
      "the list to be asked for again",
    );
    await view.settle(150);
    expect(ShownNotice.shown).toHaveLength(0);
  });

  test("a frame that arrives before that first read is answered is said, and only it", async () => {
    installNotices();
    const told = question();
    const { api, state, toldReads } = server({
      alreadyTold: told,
      toldFailures: 1,
    });
    const view = await mountApp({ path: "/made", api });
    await view.waitFor(() => toldReads() >= 1, "the first, failed read", 6000);
    await view.settle(60);

    const fresh = question();
    state.approvals = [...state.approvals, fresh];
    await outboxSays(fresh.id);
    await view.waitFor(
      () => ShownNotice.shown.length === 1,
      "the notice for the question the frame was about",
      4000,
    );
    await view.settle(200);
    // The one that was waiting before the page opened is still not news.
    expect(ShownNotice.shown).toHaveLength(1);
  });
});

/*
 * Codex, on the pull request, over two rounds. An account that kept what it had before the limit
 * can hold two conversations with one Bot; each draws only its own thread's cards.
 */
describe("an account that kept two conversations with one Bot", () => {
  afterEach(() => removeNotices());

  const elsewhere = (): PendingApproval => {
    const asking = question();
    return {
      ...asking,
      step: {
        threadId: OTHER_THREAD,
        toolCallId: asking.step?.toolCallId ?? "",
      },
    };
  };

  test("a question raised in the other one is listed and announced while this one is on screen", async () => {
    installNotices();
    const { api, state } = server({ twoConversations: true });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(() => state.reads >= 1, "the first look", 6000);
    const asking = elsewhere();
    state.approvals = [asking];
    await outboxSays(asking.id);
    await view.waitFor(
      () => pill(view.host) === "Needs your OK",
      "the pill to say the Bot is waiting",
      6000,
    );
    await view.waitFor(
      () => ShownNotice.shown.length === 1,
      "the notice: its card is not on this screen",
      4000,
    );
  });

  test("and this conversation's transcript does not say it is waiting for an answer", async () => {
    const { api, state } = server({ twoConversations: true });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(() => state.reads >= 1, "the first look", 6000);
    const asking = elsewhere();
    state.approvals = [asking];
    await outboxSays(asking.id);
    await view.waitFor(
      () => pill(view.host) === "Needs your OK",
      "the question to be known",
      6000,
    );
    await view.settle(100);
    // The turn here is going and is not waiting on anybody: the card is in the other conversation.
    expect(view.main()?.textContent ?? "").not.toContain(
      "Waiting for your answer",
    );
  });

  test("a question raised in THIS one is not announced, even when the frame is read before the record", async () => {
    installNotices();
    const { api, state, turns, releaseApprovals } = server({
      twoConversations: true,
      holdApprovals: true,
    });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(
      () => state.reads >= 1,
      "the first look to be asked",
      6000,
    );
    const asking = question();
    /*
     * The turn's own step: the call the question is about is a line in this transcript. A connected
     * service's tool rather than the browser's: a browser call marks the Bot's browser as in use for
     * 2.5 s after the conversation leaves, on a timer the DOM takes with it when this file ends —
     * and the next file's pill then read 일하는 중 for good.
     */
    await acted(() =>
      turns.say([
        {
          id: "a-asking",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: asking.step?.toolCallId ?? "",
              type: "function",
              function: { name: "mail__send_message", arguments: "{}" },
            },
          ],
        },
      ]),
    );
    state.approvals = [asking];
    // The frame's own read of the outbox wins: the record of the question is still on its way.
    await outboxSays(asking.id);
    await view.settle(200);
    expect(ShownNotice.shown).toHaveLength(0);
    // The record lands and names this conversation: the card is here, and nothing is said.
    await acted(() => releaseApprovals());
    await view.waitFor(
      () => pill(view.host) === "Needs your OK",
      "the question to be drawn",
      6000,
    );
    await view.settle(150);
    expect(ShownNotice.shown).toHaveLength(0);
    expect(view.main()?.textContent ?? "").toContain("Waiting for your answer");
  });

  /*
   * Third round. "Not known" had been left for the questions effect to announce — which never
   * happens for what never reaches the store: a request for help or a password (no approval), and
   * a routine's question (no step). Even a window nobody was looking at lost its only notice.
   */
  test("a request for a password is said to a window nobody is looking at", async () => {
    installNotices();
    const { api, state } = server({ twoConversations: true });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(() => state.reads >= 1, "the first look", 6000);
    await view.settle(60);
    const show = windowHidden();
    try {
      await outboxFrame({ id: "n-needs-1", event: "run.needs_you" });
      await view.waitFor(
        () => ShownNotice.shown.length === 1,
        "the notice that the Bot needs the person",
        4000,
      );
    } finally {
      show();
    }
  });

  test("and to a visible one it is not, in a conversation of the Bot's: that is where the request is drawn", async () => {
    installNotices();
    const { api, state } = server({ twoConversations: true });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(() => state.reads >= 1, "the first look", 6000);
    await view.settle(60);
    await outboxFrame({ id: "n-needs-2", event: "run.needs_you" });
    await view.settle(250);
    expect(ShownNotice.shown).toHaveLength(0);
  });

  test("a routine's question has no card on any conversation, so it is said even here", async () => {
    installNotices();
    const { api, state } = server({ twoConversations: true });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(() => state.reads >= 1, "the first look", 6000);
    const { step: _step, ...stepless } = question();
    state.approvals = [stepless];
    await outboxSays(stepless.id);
    await view.waitFor(
      () => ShownNotice.shown.length === 1,
      "the notice for a question no conversation draws",
      4000,
    );
    // It never reaches the store, so nothing on this screen was going to say it.
    expect(pill(view.host)).not.toBe("Needs your OK");
  });

  test("a question answered before its record could be read is not announced at all", async () => {
    installNotices();
    const { api, state } = server({ twoConversations: true });
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    await view.waitFor(() => state.reads >= 1, "the first look", 6000);
    const asking = question();
    // The record no longer holds it: answered in another window, or run out.
    state.approvals = [];
    await outboxSays(asking.id);
    await view.settle(250);
    expect(ShownNotice.shown).toHaveLength(0);
  });
});
