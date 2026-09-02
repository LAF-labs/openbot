import { afterEach, describe, expect, test } from "bun:test";
import {
  destinationOf,
  isNotificationFrame,
  markNotificationSeen,
  type NotificationFrame,
  readNotifications,
} from "../src/lib/notifications/outbox";
import {
  bodyFor,
  noticeKindOf,
} from "../src/lib/notifications/use-bot-notifications";

/**
 * The page's half of the outbox.
 *
 * Two things here are load-bearing and neither is visible from a green typecheck. First: this frame
 * has to be told apart from the socket's other traffic BEFORE anything reads it, because the roster
 * recognises its own activity event by having no `kind` at all — an unrecognised frame gets spread
 * onto a roster row. Second: an expired question must stay silent, because nobody can answer a
 * question that has run out and a notice about one is an interruption a person can do nothing with.
 */

const FRAME: NotificationFrame = {
  kind: "notification",
  id: "notification-1",
  event: "approval.requested",
  botId: "bot-1",
  approvalId: "approval-1",
  at: "2026-09-03T13:00:00.000Z",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("telling the socket's traffic apart", () => {
  test("a notification frame is one, and nothing else is", () => {
    expect(isNotificationFrame(FRAME)).toBe(true);
    // The roster's activity event: no `kind`, and the reason the check exists.
    expect(
      isNotificationFrame({
        channelId: "channel-1",
        name: "Room",
        lastMessage: "Done.",
        lastMessageAt: "2026-09-03T13:00:00.000Z",
        lastMessageAgentId: "bot-1",
      }),
    ).toBe(false);
    // A room frame has a `kind`, and it is not this one.
    expect(
      isNotificationFrame({ kind: "room.delta", channelId: "c", turnId: "t" }),
    ).toBe(false);
    expect(isNotificationFrame(null)).toBe(false);
    expect(isNotificationFrame("notification")).toBe(false);
    // Shaped like one but missing what a click would need.
    expect(isNotificationFrame({ kind: "notification", id: 7 })).toBe(false);
  });
});

describe("where acting on one lands somebody", () => {
  test("the question first, then the room, and otherwise nowhere", () => {
    expect(destinationOf(FRAME)).toEqual({ kind: "approve", id: "approval-1" });
    expect(
      destinationOf({
        ...FRAME,
        approvalId: undefined,
        channelId: "channel-1",
      }),
    ).toEqual({ kind: "channel", id: "channel-1" });
    // A row that names no place is not a notice: there is nothing for a click to do.
    expect(
      destinationOf({ ...FRAME, approvalId: undefined, channelId: undefined }),
    ).toBeNull();
  });
});

describe("which of the two interruptions a row is", () => {
  test("blocked on you leads, finished follows, expired is silent", () => {
    expect(noticeKindOf("approval.requested")).toBe("needs-you");
    expect(noticeKindOf("run.needs_you")).toBe("needs-you");
    expect(noticeKindOf("run.finished")).toBe("finished");
    expect(noticeKindOf("run.failed")).toBe("finished");
    // Nobody can answer a question that has run out. It is still a row, and still in the list.
    expect(noticeKindOf("approval.expired")).toBeNull();
    // A newer server may send a word this build has never heard.
    expect(noticeKindOf("run.something_else")).toBeNull();
  });

  test("the line under the title says what happened", () => {
    expect(bodyFor("approval.requested", "‘출금 승인’을 누르려 합니다")).toBe(
      "‘출금 승인’을 누르려 합니다",
    );
    // Every one of these goes through `t()`, so a Korean reader gets Korean — the server sends no
    // prose for a lock screen.
    // Four different things happened, so four different lines. A Bot that finished and a Bot that
    // could not finish saying the same words is the notice that teaches somebody to ignore them.
    const lines = [
      bodyFor("run.finished", null),
      bodyFor("run.failed", null),
      bodyFor("run.needs_you", null),
      bodyFor("approval.requested", null),
    ];
    expect(lines.every((line) => line.length > 0)).toBe(true);
    expect(new Set(lines).size).toBe(4);
  });
});

describe("reading the door", () => {
  test("maps the server's row onto the frame the page already handles", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          notifications: [
            {
              id: "notification-2",
              kind: "run.finished",
              botId: "bot-2",
              channelId: "channel-2",
              createdAt: "2026-09-03T14:00:00.000Z",
              deliveredVia: [],
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    const rows = await readNotifications();
    expect(rows).toEqual([
      {
        kind: "notification",
        id: "notification-2",
        // The server calls it `kind` and the frame calls it `event`, because `kind` is already
        // taken by the discriminator. Mapped in one place so the two words cannot be confused.
        event: "run.finished",
        botId: "bot-2",
        channelId: "channel-2",
        at: "2026-09-03T14:00:00.000Z",
      },
    ]);
  });

  test("a server that could not be asked is null, never an empty list", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    // The distinction `readApprovals` already makes: a page must never read a failed request as
    // "nothing is waiting for you".
    expect(await readNotifications()).toBeNull();
    expect(await markNotificationSeen("notification-1")).toBe(false);
  });

  test("the bookmark rides in the query", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ notifications: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await readNotifications("2026-09-03T13:00:00.000Z");
    await markNotificationSeen("notification-1");

    expect(asked[0]).toContain("since=2026-09-03T13%3A00%3A00.000Z");
    expect(asked[1]).toBe("/api/me/notifications/notification-1/seen");
  });
});
