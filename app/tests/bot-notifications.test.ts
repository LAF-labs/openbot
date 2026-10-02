import { afterEach, describe, expect, test } from "bun:test";
import {
  canRaiseNotice,
  decideNotice,
  noticeBody,
  type NoticeRequest,
  readNotificationSupport,
  THROTTLE_MS,
  throttleKey,
} from "../src/lib/notifications/bot-notifications";
import {
  isCardOnScreen,
  openChannelFrom,
} from "../src/lib/notifications/use-bot-notifications";

const finished: NoticeRequest = {
  kind: "finished",
  agentId: "risk-analyst",
  notify: true,
  hidden: false,
  visible: true,
  openChannelId: null,
  channelId: "channel_a",
  now: 1_000_000,
};
const needsYou: NoticeRequest = {
  kind: "needs-you",
  agentId: "risk-analyst",
  notify: true,
  hidden: false,
  visible: false,
  now: 1_000_000,
};

describe("whether a Bot finishing is worth interrupting for", () => {
  test("a room that is not on screen is", () => {
    expect(decideNotice(finished, undefined)).toBe("deliver");
    expect(
      decideNotice({ ...finished, openChannelId: "channel_b" }, undefined),
    ).toBe("deliver");
  });

  test("the room the person is reading is not", () => {
    expect(
      decideNotice({ ...finished, openChannelId: "channel_a" }, undefined),
    ).toBe("focused");
  });

  test("that room in a hidden tab is, because nobody is reading it", () => {
    expect(
      decideNotice(
        { ...finished, openChannelId: "channel_a", visible: false },
        undefined,
      ),
    ).toBe("deliver");
  });
});

describe("whether a Bot asking is worth interrupting for", () => {
  test("a hidden tab is: the card is on a screen nobody is looking at", () => {
    expect(decideNotice(needsYou, undefined)).toBe("deliver");
  });

  test("a visible window with the card on screen is not — the card is right there", () => {
    expect(
      decideNotice(
        { ...needsYou, visible: true, cardOnScreen: true },
        undefined,
      ),
    ).toBe("focused");
  });

  /*
   * The turn is the server's and goes on while the person reads another screen of the app. A
   * visible window used to be enough to stay quiet, so the one interruption that runs out in ten
   * minutes was withheld exactly where no card was drawn.
   */
  test("a visible window showing another screen is: nothing on it is asking", () => {
    expect(
      decideNotice(
        { ...needsYou, visible: true, cardOnScreen: false },
        undefined,
      ),
    ).toBe("deliver");
  });

  test("a caller that cannot tell where the card is keeps the old answer", () => {
    expect(decideNotice({ ...needsYou, visible: true }, undefined)).toBe(
      "focused",
    );
  });

  test("the card being on screen does not silence a window nobody is looking at", () => {
    expect(decideNotice({ ...needsYou, cardOnScreen: true }, undefined)).toBe(
      "deliver",
    );
  });

  test("the mute, the put-away Bot and the throttle still come first", () => {
    const asking = { ...needsYou, visible: true, cardOnScreen: false };
    expect(decideNotice({ ...asking, notify: false }, undefined)).toBe("muted");
    expect(decideNotice({ ...asking, hidden: true }, undefined)).toBe("hidden");
    expect(decideNotice(asking, asking.now - 1_000)).toBe("throttled");
  });
});

describe("which screens draw a Bot's question", () => {
  const channels = [
    { id: "channel_mine", agentIds: ["risk-analyst"], threadId: "thread-mine" },
    { id: "channel_other", agentIds: ["someone-else"], threadId: "thread-x" },
  ];
  const on = (pathname: string, approvalId?: string, threadId?: string) =>
    isCardOnScreen({
      pathname,
      botId: "risk-analyst",
      approvalId,
      threadId,
      channels,
    });

  test("the conversation it was raised in does", () => {
    expect(on("/channel/channel_mine", "appr_1", "thread-mine")).toBe(true);
    // The Bot's one conversation, before anybody has read which conversation the question is in.
    expect(on("/channel/channel_mine")).toBe(true);
  });

  test("another Bot's conversation does not", () => {
    expect(on("/channel/channel_other")).toBe(false);
    expect(on("/channel/channel_other", "appr_1", "thread-mine")).toBe(false);
  });

  test("소식, 만든 것, 설정 — no screen that is not a conversation does", () => {
    for (const pathname of [
      "/feed",
      "/made",
      "/ideas",
      "/goals",
      "/settings",
    ]) {
      expect(on(pathname)).toBe(false);
    }
  });

  test("the page a notice opens for this question does, and for another it does not", () => {
    expect(on("/approve/appr_1", "appr_1")).toBe(true);
    expect(on("/approve/appr_2", "appr_1")).toBe(false);
    expect(on("/approve/appr_1")).toBe(false);
  });

  test("before the list of conversations has been read, an open conversation is taken as the right one", () => {
    expect(
      isCardOnScreen({
        pathname: "/channel/channel_mine",
        botId: "risk-analyst",
        channels: undefined,
      }),
    ).toBe(true);
  });

  test("a list that has been read and does not hold the open one draws no card: the compose screen, a conversation that is gone", () => {
    expect(on("/channel/new")).toBe(false);
    expect(on("/channel/channel_deleted")).toBe(false);
  });

  /*
   * Codex, on the pull request: an account that kept what it had before the limit can hold several
   * conversations with one Bot, and each draws only its own thread's cards. Deciding by "a
   * conversation with this Bot is open" withheld the notice for a question raised in another one.
   */
  describe("an account that kept two conversations with one Bot", () => {
    const kept = [
      { id: "channel_a", agentIds: ["risk-analyst"], threadId: "thread-a" },
      { id: "channel_b", agentIds: ["risk-analyst"], threadId: "thread-b" },
    ];
    const inB = (threadId?: string) =>
      isCardOnScreen({
        pathname: "/channel/channel_b",
        botId: "risk-analyst",
        approvalId: "appr_1",
        threadId,
        channels: kept,
      });

    test("a question raised in the other one is not on this screen", () => {
      expect(inB("thread-a")).toBe(false);
    });

    test("one raised in this one is", () => {
      expect(inB("thread-b")).toBe(true);
    });

    test("and one whose conversation nobody has read yet is not guessed to be here", () => {
      expect(inB(undefined)).toBe(false);
    });
  });
});

describe("the rules both kinds share", () => {
  test("a muted Bot says nothing", () => {
    expect(decideNotice({ ...finished, notify: false }, undefined)).toBe(
      "muted",
    );
    expect(decideNotice({ ...needsYou, notify: false }, undefined)).toBe(
      "muted",
    );
  });

  test("a Bot put away says nothing, even unmuted — hidden is the stronger statement", () => {
    expect(
      decideNotice({ ...finished, hidden: true, notify: true }, undefined),
    ).toBe("hidden");
    expect(
      decideNotice({ ...needsYou, hidden: true, notify: true }, undefined),
    ).toBe("hidden");
  });

  test("a Bot the roster has not loaded still notifies, rather than being dropped", () => {
    expect(
      decideNotice(
        { ...finished, notify: undefined, hidden: undefined },
        undefined,
      ),
    ).toBe("deliver");
  });

  test("five seconds of quiet per Bot per kind", () => {
    // One turn is several runs on the wire once a Bot touches its computer, so the events arrive
    // in a burst. Without this a single errand left a row of notifications.
    expect(decideNotice(finished, finished.now - 1)).toBe("throttled");
    expect(decideNotice(finished, finished.now - THROTTLE_MS)).toBe("deliver");
  });

  test("the throttle is per kind, so a finishing Bot can still say it needs you", () => {
    expect(throttleKey(finished)).not.toBe(throttleKey(needsYou));
  });
});

describe("what fits on a lock screen", () => {
  test("newlines collapse and a long answer is cut with an ellipsis", () => {
    expect(noticeBody("  두 줄\n\n짜리  ")).toBe("두 줄 짜리");
    const long = "가".repeat(300);
    expect(Array.from(noticeBody(long))).toHaveLength(140);
    expect(noticeBody(long).endsWith("…")).toBe(true);
  });
});

describe("which room is on screen", () => {
  test("a channel route names its channel", () => {
    expect(openChannelFrom("/channel/channel_abc")).toBe("channel_abc");
  });

  test("anything under it is still that channel, not a room nothing matches", () => {
    expect(openChannelFrom("/channel/channel_abc/settings")).toBe(
      "channel_abc",
    );
  });

  test("any other screen is no room at all", () => {
    expect(openChannelFrom("/settings")).toBeNull();
    expect(openChannelFrom("/")).toBeNull();
  });
});

/**
 * WHO IS ACTUALLY GOING TO SHOW THE NOTICE.
 *
 * The synchronous check reads `window.Notification`, and the shell's answer is a promise — so the
 * app called its own notifications unsupported and hid the control that turns them on, while the
 * shell had been posting them through the OS all along.
 *
 * "WKWebView has no `Notification`" is written all over this area and, measured 2026-09, is no
 * longer the reason: `tauri-plugin-notification` injects an init script that DEFINES
 * `window.Notification` in every webview (`src/init-iife.js`), mapping it onto
 * `plugin:notification|notify`. What the synchronous check gets wrong now is subtler — it answers
 * for the webview when the thing that will show the notice is the shell — but it is wrong in the
 * same direction, so these stay as they are.
 */
describe("what will show a notice", () => {
  type WindowWithTauri = typeof globalThis & { __TAURI__?: unknown };

  afterEach(() => {
    (globalThis as WindowWithTauri).__TAURI__ = undefined;
  });

  test("the shell answers for itself, whatever the webview lacks", async () => {
    (globalThis as WindowWithTauri).__TAURI__ = {
      notification: {
        isPermissionGranted: async () => true,
        requestPermission: async () => "granted",
        sendNotification: () => {},
      },
    };
    expect(await readNotificationSupport()).toBe("granted");
  });

  test("a shell that has not been asked yet is something to ask about", async () => {
    (globalThis as WindowWithTauri).__TAURI__ = {
      notification: {
        isPermissionGranted: async () => false,
        requestPermission: async () => "granted",
        sendNotification: () => {},
      },
    };
    expect(await readNotificationSupport()).toBe("ask");
  });

  test("without a shell the browser answers, and in this runtime it has nothing to offer", async () => {
    expect(await readNotificationSupport()).toBe("unsupported");
  });
});

/**
 * The gate one line above every notice, which asked the webview about the shell.
 *
 * The shell's own permission is a promise, and `notificationSupport()` is a synchronous read of
 * `window.Notification`. Measured 2026-09 in the installed app: the notification plugin defines
 * that object and sets `permission` to "granted" from an async round trip a moment after load, so
 * the gate mostly passed — and silently dropped anything raised before that resolved. The shell
 * does not need the webview's opinion either way.
 */
describe("whether a notice can be attempted at all", () => {
  test("the shell is never refused on the browser's missing Notification", () => {
    expect(canRaiseNotice({ inShell: true, browser: "unsupported" })).toBe(
      true,
    );
    // The shell asks the OS itself and falls back when refused; there is nothing to decide here.
    expect(canRaiseNotice({ inShell: true, browser: "denied" })).toBe(true);
  });

  test("a browser tab still answers for itself, every time it is asked", () => {
    expect(canRaiseNotice({ inShell: false, browser: "granted" })).toBe(true);
    for (const browser of ["ask", "denied", "unsupported"] as const) {
      expect(canRaiseNotice({ inShell: false, browser })).toBe(false);
    }
  });
});
