import { afterEach, describe, expect, test } from "bun:test";
import {
  decideNotice,
  noticeBody,
  type NoticeRequest,
  readNotificationSupport,
  THROTTLE_MS,
  throttleKey,
} from "../src/lib/notifications/bot-notifications";
import { openChannelFrom } from "../src/lib/notifications/use-bot-notifications";

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

  test("a visible tab is not, whatever room is open — the card is right there", () => {
    expect(decideNotice({ ...needsYou, visible: true }, undefined)).toBe(
      "focused",
    );
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
 * The synchronous check reads `window.Notification`, which WKWebView does not have — so in the
 * desktop shell the app called its own notifications unsupported and hid the control that turns
 * them on, while the shell had been posting them through the OS all along.
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
