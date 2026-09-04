import { describe, expect, test } from "bun:test";
import { createAlimtalkAdapter } from "../src/notifications/alimtalk";
import { withOutboxWatch } from "../src/notifications/from-audit";
import {
  createFinishedNotice,
  createSocketAdapter,
  notificationFrame,
} from "../src/notifications/in-app";
import { createWebhookAdapter } from "../src/notifications/notify";
import type {
  EnqueueInput,
  NotificationOutbox,
  NotificationRecord,
} from "../src/notifications/outbox";
import type { PartnerConnections } from "../src/plugins/partner-connections";
import { A_CLICK } from "./support/subjects";

/**
 * The doors, one at a time, with nothing behind them.
 *
 * The table is tested next door against a real Postgres. What is tested here is the half that
 * decides whether anybody is actually reached: whether a door reports delivery honestly, whether a
 * frame goes to a socket nobody is on, and whether the two paths that raise a notification without
 * going through the approval registry raise one at all.
 */

const RECORD: NotificationRecord = {
  id: "notification-1",
  kind: "approval.requested",
  botId: "bot-1",
  userId: "person-1",
  approvalId: "approval-1",
  subject: A_CLICK,
  createdAt: "2026-09-03T13:00:00.000Z",
  deliveredVia: [],
};

/** An outbox that records what it was asked to write and writes nothing. */
function spyOutbox(): NotificationOutbox & { written: EnqueueInput[] } {
  const written: EnqueueInput[] = [];
  return {
    written,
    enqueue: async (input) => {
      written.push(input);
      return { ...RECORD, ...input, deliveredVia: [] };
    },
    list: async () => [],
    markSeen: async () => true,
    markSeenForApproval: async () => 0,
  };
}

describe("the webhook door", () => {
  test("sends what it always sent, plus the row it is about", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        frames.push((await request.json()) as Record<string, unknown>);
        return new Response("ok");
      },
    });
    try {
      const adapter = createWebhookAdapter(
        `http://127.0.0.1:${server.port}/hook`,
      );
      expect(await adapter.deliver(RECORD)).toBe(true);
      expect(frames).toHaveLength(1);
      const frame = frames[0] ?? {};
      expect(frame.kind).toBe("approval.requested");
      expect(frame.approvalId).toBe("approval-1");
      expect(String(frame.headline)).toContain("기다립니다");
      // The one new field: which row this is about, so a receiver can say so back.
      expect(frame.notificationId).toBe("notification-1");
    } finally {
      server.stop(true);
    }
  });

  test("a dead webhook reports that it did not deliver, and does not throw", async () => {
    const adapter = createWebhookAdapter("http://127.0.0.1:1/hook");
    expect(await adapter.deliver(RECORD)).toBe(false);
  });
});

describe("the alimtalk door", () => {
  /** A partner store that holds nothing, which is what an unconnected deployment has. */
  const NOBODY_CONNECTED = {
    find: async () => null,
    templatesFor: async () => [],
  } as unknown as PartnerConnections;

  test("says the deployment holds no key, once, and never claims delivery", async () => {
    const said: string[] = [];
    const adapter = createAlimtalkAdapter({
      partners: NOBODY_CONNECTED,
      environment: {},
      log: (message) => said.push(message),
    });

    expect(await adapter.deliver(RECORD)).toBe(false);
    expect(await adapter.deliver(RECORD)).toBe(false);

    // One line per reason per process, not one per question: the fact it reports does not change
    // between notifications, and a line on every one would bury the lines that matter.
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("솔라피");
  });

  test("configured but unconnected stays queued, and says which", async () => {
    const said: string[] = [];
    const adapter = createAlimtalkAdapter({
      partners: NOBODY_CONNECTED,
      environment: { LAF_ALIMTALK_API_KEY: "key:secret" },
      log: (message) => said.push(message),
    });

    // The one thing this door must never do is put its name in `delivered_via` for a message
    // nobody sent.
    expect(await adapter.deliver(RECORD)).toBe(false);
    expect(said[0]).toContain("카카오톡 채널");
  });

  test("a kind with no owner template is not a failure and not a log line", async () => {
    const said: string[] = [];
    const adapter = createAlimtalkAdapter({
      partners: NOBODY_CONNECTED,
      environment: { LAF_ALIMTALK_API_KEY: "key:secret" },
      log: (message) => said.push(message),
    });

    // `approval.expired` is deliberately not an interruption: nobody can answer a question that has
    // run out, so it belongs in the app's list and not on somebody's phone at 2am.
    expect(await adapter.deliver({ ...RECORD, kind: "approval.expired" })).toBe(
      false,
    );
    expect(said).toHaveLength(0);
  });
});

describe("the in-app door", () => {
  test("says nothing to a person with no socket open", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const adapter = createSocketAdapter({
      connectionCount: () => 0,
      deliverRoom: (frame) => sent.push(frame),
    });

    expect(await adapter.deliver(RECORD)).toBe(false);
    // Not "sent to nobody and recorded as delivered", which is what a socket door that skipped this
    // check would write into the column people read as evidence.
    expect(sent).toHaveLength(0);
  });

  test("sends one addressed frame when somebody is listening", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const adapter = createSocketAdapter({
      connectionCount: () => 2,
      deliverRoom: (frame) => sent.push(frame),
    });

    expect(await adapter.deliver(RECORD)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.memberIds).toEqual(["person-1"]);
    // `kind` is the discriminator the roster's activity event does not have; `event` is what
    // happened. A frame with neither would be spread onto a roster row by an older bundle.
    expect(sent[0]?.kind).toBe("notification");
    expect(sent[0]?.event).toBe("approval.requested");
    expect(sent[0]?.id).toBe("notification-1");
  });

  test("the frame carries the facts and not a sentence", () => {
    const frame = notificationFrame(RECORD);
    expect(frame.subject).toEqual(
      A_CLICK as unknown as Record<string, unknown>,
    );
    expect(
      Object.values(frame).every((value) => typeof value !== "function"),
    ).toBe(true);
  });
});

describe("a run that finished while nobody watched", () => {
  const activity = {
    channelId: "channel-1",
    memberIds: ["away", "watching"],
    name: "Room",
    lastMessage: "Done.",
    lastMessageAt: "2026-09-03T13:00:00.000Z",
    lastMessageAgentId: "bot-1",
  };

  test("writes a row only for the member with no tab open", async () => {
    const outbox = spyOutbox();
    const notice = createFinishedNotice(
      { connectionCount: (userId) => (userId === "watching" ? 1 : 0) },
      outbox,
    );

    notice(activity);
    await Promise.resolve();

    expect(outbox.written).toHaveLength(1);
    expect(outbox.written[0]?.userId).toBe("away");
    expect(outbox.written[0]?.kind).toBe("run.finished");
    expect(outbox.written[0]?.channelId).toBe("channel-1");
  });

  test("a person's own message is never news", async () => {
    const outbox = spyOutbox();
    const notice = createFinishedNotice({ connectionCount: () => 0 }, outbox);

    notice({ ...activity, lastMessageAgentId: null });
    await Promise.resolve();

    expect(outbox.written).toEqual([]);
  });
});

describe("the Bot asking for a person's own hands", () => {
  const asked = {
    eventType: "computer.secret_requested" as const,
    targetType: "computer",
    targetId: "computer-1",
    actorUserId: "person-1",
    payload: { bot: "bot-1", actor: "person-1", reason: "Password (into #pw)" },
  };

  test("a help or secret row raises one, because neither goes through the registry", async () => {
    const outbox = spyOutbox();
    const inserted: string[] = [];
    const store = withOutboxWatch(
      { insert: async (event) => void inserted.push(event.eventType) },
      outbox,
    );

    await store.insert(asked);
    await store.insert({ ...asked, eventType: "computer.help_requested" });
    await Promise.resolve();

    expect(inserted).toEqual([
      "computer.secret_requested",
      "computer.help_requested",
    ]);
    expect(outbox.written.map((one) => one.kind)).toEqual([
      "run.needs_you",
      "run.needs_you",
    ]);
    expect(outbox.written[0]?.botId).toBe("bot-1");
    expect(outbox.written[0]?.userId).toBe("person-1");
  });

  test("every other row in the trail passes through untouched", async () => {
    const outbox = spyOutbox();
    const store = withOutboxWatch({ insert: async () => {} }, outbox);

    await store.insert({ ...asked, eventType: "computer.control_taken" });
    // Nothing to address it to: no actor in the payload and none on the row either.
    await store.insert({
      ...asked,
      actorUserId: undefined,
      payload: { bot: "bot-1" },
    });
    await Promise.resolve();

    expect(outbox.written).toEqual([]);
  });

  test("the fixture actor is still somebody to tell", async () => {
    const outbox = spyOutbox();
    const store = withOutboxWatch({ insert: async () => {} }, outbox);

    /*
     * MEASURED, ON A RUNNING SERVER. `actor_user_id` is left empty for the local development
     * fixture on purpose (dev-actor.ts), so a watcher reading only that column wrote the trail row
     * and told nobody — on the machine where this feature is actually looked at. The id is in the
     * payload either way.
     */
    await store.insert({ ...asked, actorUserId: undefined });
    await Promise.resolve();

    expect(outbox.written.map((one) => one.userId)).toEqual(["person-1"]);
  });

  test("the trail is the record: a failing outbox cannot fail a row", async () => {
    const written: string[] = [];
    const store = withOutboxWatch(
      { insert: async (event) => void written.push(event.eventType) },
      {
        ...spyOutbox(),
        enqueue: async () => {
          throw new Error("the outbox is having a bad minute");
        },
      },
    );

    await store.insert(asked);
    await Promise.resolve();
    expect(written).toEqual(["computer.secret_requested"]);
  });
});
