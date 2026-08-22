import { describe, expect, test } from "bun:test";
import {
  shouldNotify,
  shouldNotifyApproval,
} from "../src/lib/notifications/bot-notifications";
import { openChannelFrom } from "../src/lib/notifications/use-bot-notifications";

const base = {
  agentId: "risk-analyst",
  notify: true,
  openChannelId: null as string | null,
  channelId: "channel_a",
  visible: true,
};

describe("whether a Bot speaking is worth interrupting for", () => {
  test("a Bot speaking in a room that is not on screen is", () => {
    expect(shouldNotify(base)).toBe(true);
    expect(shouldNotify({ ...base, openChannelId: "channel_b" })).toBe(true);
  });

  test("the room the person is reading is not", () => {
    expect(shouldNotify({ ...base, openChannelId: "channel_a" })).toBe(false);
  });

  test("a room open in a hidden tab is, because nobody is reading it", () => {
    expect(
      shouldNotify({ ...base, openChannelId: "channel_a", visible: false }),
    ).toBe(true);
  });

  test("the person's own message never is", () => {
    expect(shouldNotify({ ...base, agentId: null })).toBe(false);
  });

  test("a muted Bot never is, wherever the person is looking", () => {
    expect(shouldNotify({ ...base, notify: false })).toBe(false);
  });

  test("a Bot the roster has not loaded yet is, rather than silently dropped", () => {
    // `notify` defaults to true on the server; an undefined here means "not loaded", and staying
    // quiet on it would lose the first notification after every reload.
    expect(shouldNotify({ ...base, notify: undefined })).toBe(true);
  });
});

describe("whether a Bot stopping to ask is worth interrupting for", () => {
  test("a hidden tab is, because the card is on a screen nobody is looking at", () => {
    expect(shouldNotifyApproval({ notify: true, visible: false })).toBe(true);
  });

  test("a visible tab is not: the card and the status line already say it", () => {
    expect(shouldNotifyApproval({ notify: true, visible: true })).toBe(false);
  });

  test("a muted Bot is not, even blocked", () => {
    expect(shouldNotifyApproval({ notify: false, visible: false })).toBe(false);
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
