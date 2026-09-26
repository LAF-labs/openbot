import { describe, expect, test } from "bun:test";
import { createAlimtalkAdapter } from "../src/notifications/alimtalk";
import { withOutboxWatch } from "../src/notifications/from-audit";
import {
  createFinishedNotice,
  createSocketAdapter,
  notificationFrame,
} from "../src/notifications/in-app";
import { createWebhookAdapter } from "../src/notifications/notify";
import { solapiSettings } from "../src/plugins/alimtalk/solapi";
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

/** An outbox that records what it was asked to write, or to offer, and writes nothing. */
function spyOutbox(): NotificationOutbox & {
  written: EnqueueInput[];
  offered: string[];
} {
  const written: EnqueueInput[] = [];
  const offered: string[] = [];
  return {
    written,
    offered,
    enqueue: async (input) => {
      written.push(input);
      return { ...RECORD, ...input, deliveredVia: [] };
    },
    recordFleetNotice: async () => {},
    redeliver: async () => 0,
    offer: async (id) => {
      offered.push(id);
      return null;
    },
    acknowledge: async () => false,
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
      expect(String(frame.headline)).toContain("사장님 승인을 기다려요");
      // The one new field: which row this is about, so a receiver can say so back.
      expect(frame.notificationId).toBe("notification-1");
    } finally {
      server.stop(true);
    }
  });

  test("a webhook that answers with an error did not take the notification", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return new Response("down", { status: 500 });
      },
    });
    try {
      const adapter = createWebhookAdapter(
        `http://127.0.0.1:${server.port}/hook`,
      );
      // Reached, and refused: the row must not say `deliveredVia: ["webhook"]` about it.
      expect(await adapter.deliver(RECORD)).toBe(false);
      expect(hits).toBe(1);
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
      settings: null,
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
      settings: solapiSettings({ LAF_ALIMTALK_API_KEY: "key:secret" }),
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
      settings: solapiSettings({ LAF_ALIMTALK_API_KEY: "key:secret" }),
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
      deliverFrame: (frame) => sent.push(frame),
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
      deliverFrame: (frame) => sent.push(frame),
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

describe("a routine that did not finish", () => {
  const ran = (payload: Record<string, unknown>) => ({
    eventType: "routine.ran" as const,
    targetType: "routine",
    targetId: "routine-1",
    payload: {
      agentId: "bot-1",
      name: "리뷰 확인",
      ok: false,
      actor: "person-1",
      failure: "laf:turn_rate_limited",
      channelId: "channel-1",
      ...payload,
    },
  });

  test("the failure that opened a group is offered to the doors, and nothing is written twice", async () => {
    const outbox = spyOutbox();
    const store = withOutboxWatch({ insert: async () => {} }, outbox);

    await store.insert(
      ran({ failureGroup: { id: "group-1", count: 1, opened: true } }),
    );
    await Promise.resolve();

    // The settlement already wrote the row; a second one here would be the duplicate buzz.
    expect(outbox.offered).toEqual(["group-1"]);
    expect(outbox.written).toEqual([]);
  });

  test("a repeat counted into an open group says nothing at all", async () => {
    const outbox = spyOutbox();
    const store = withOutboxWatch({ insert: async () => {} }, outbox);

    for (let count = 2; count <= 10; count += 1) {
      await store.insert(
        ran({ failureGroup: { id: "group-1", count, opened: false } }),
      );
    }
    await Promise.resolve();

    expect(outbox.offered).toEqual([]);
    expect(outbox.written).toEqual([]);
  });

  test("a failure no group could be recorded for is told the old way, once", async () => {
    const outbox = spyOutbox();
    const store = withOutboxWatch({ insert: async () => {} }, outbox);

    await store.insert(ran({}));
    await Promise.resolve();

    expect(outbox.offered).toEqual([]);
    expect(outbox.written).toEqual([
      {
        kind: "run.failed",
        botId: "bot-1",
        userId: "person-1",
        channelId: "channel-1",
        run: {
          origin: "routine",
          label: "리뷰 확인",
          code: "laf:turn_rate_limited",
        },
      },
    ]);
  });

  test("a routine the person stopped themselves rings no bell", async () => {
    // `모두 멈추기`: telling them would be telling them what they just did, as a failure.
    const outbox = spyOutbox();
    const store = withOutboxWatch({ insert: async () => {} }, outbox);

    const { failure: _none, ...stopped } = ran({ stopped: true }).payload;
    await store.insert({ ...ran({}), payload: stopped });
    await Promise.resolve();

    expect(outbox.offered).toEqual([]);
    expect(outbox.written).toEqual([]);
  });
});

/**
 * A Bot's routines paused because their results piled up unread (`routines/unread.ts`), told once.
 *
 * The same seam a failed run is told through: the sweep writes one trail row per pause, and the
 * watch turns that row into one notification. Facts only — which Bot, whose conversation, which
 * routines, how many results were waiting and since when — and the surface writes the sentence.
 */
describe("routines paused for going unread", () => {
  const paused = (payload: Record<string, unknown> = {}) => ({
    eventType: "routine.paused_unread" as const,
    targetType: "routine",
    targetId: "routine-1",
    actorUserId: "person-1",
    payload: {
      agentId: "bot-1",
      actor: "person-1",
      channelId: "channel-1",
      routineIds: ["routine-1", "routine-2"],
      count: 2,
      unread: 5,
      since: "2026-09-09T22:30:00.000Z",
      ...payload,
    },
  });

  test("become one notice, pointing at the conversation the results are waiting in", async () => {
    const outbox = spyOutbox();
    const store = withOutboxWatch({ insert: async () => {} }, outbox);

    await store.insert(paused());
    await Promise.resolve();

    expect(outbox.written).toEqual([
      {
        kind: "routine.paused",
        botId: "bot-1",
        userId: "person-1",
        channelId: "channel-1",
        pause: {
          reason: "unread",
          routineIds: ["routine-1", "routine-2"],
          count: 2,
          unread: 5,
          since: "2026-09-09T22:30:00.000Z",
        },
      },
    ]);
  });

  test("with nobody named to tell, tell nobody", async () => {
    const outbox = spyOutbox();
    const store = withOutboxWatch({ insert: async () => {} }, outbox);

    await store.insert(paused({ actor: undefined }));
    await store.insert(paused({ agentId: "" }));
    await Promise.resolve();

    expect(outbox.written).toEqual([]);
  });

  test("the buzz webhook carries the facts and a headline of its own, and 알림톡 has no template for it", async () => {
    const record: NotificationRecord = {
      ...RECORD,
      kind: "routine.paused",
      channelId: "channel-1",
      pause: {
        reason: "unread",
        routineIds: ["routine-1"],
        count: 1,
        unread: 3,
        since: "2026-09-09T22:30:00.000Z",
      },
    };
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
      expect(await adapter.deliver(record)).toBe(true);
    } finally {
      server.stop(true);
    }
    expect(frames[0]).toMatchObject({
      kind: "routine.paused",
      botId: record.botId,
      channelId: "channel-1",
      pause: { reason: "unread", count: 1, unread: 3 },
    });
    expect(String(frames[0]?.headline)).toContain("루틴");
    expect(notificationFrame(record)).toMatchObject({
      event: "routine.paused",
      channelId: "channel-1",
      pause: { reason: "unread", count: 1 },
    });
  });
});
