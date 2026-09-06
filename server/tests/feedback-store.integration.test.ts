import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { lafFeedback, lafNotifications, users } from "../src/db/schema";
import {
  createNotificationOutbox,
  type NotificationAdapter,
  type NotificationRecord,
} from "../src/notifications/outbox";
import { createFeedbackStore } from "../src/support/feedback";
import { TEST_POOL } from "./support/database";

/**
 * The feedback row against a real Postgres, and the outbox's two rules about support rows.
 *
 * The row's cascade is a foreign key and cannot be wrong in a fake. The two outbox rules — a
 * support row goes only to a door that asked for it, and never into the person's own list — are a
 * filter and a predicate, and the predicate is SQL: `not like 'support.%'` is exactly the kind of
 * thing that is right in a test double and wrong on the wire.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createFeedbackStore(database);
const made: string[] = [];

async function person(): Promise<string> {
  const id = `feedback-${randomUUID()}`;
  made.push(id);
  await database.insert(users).values({
    id,
    email: `${id}@laf.test`,
    name: "Somebody",
    emailVerified: true,
  });
  return id;
}

afterEach(async () => {
  if (made.length > 0) {
    await database.delete(users).where(inArray(users.id, made.splice(0)));
  }
});

afterAll(async () => {
  await database.$client.end();
});

describe("the feedback row", () => {
  test("keeps the words, the two screen facts, and when", async () => {
    const userId = await person();
    const before = Date.now();

    const receipt = await store.record({
      userId,
      text: "리뷰 요약이 어제부터 안 됩니다",
      route: "/channel/abc",
      failureCode: "laf:turn_rate_limited",
    });

    const [row] = await database
      .select()
      .from(lafFeedback)
      .where(eq(lafFeedback.id, receipt.id));
    expect(row).toMatchObject({
      userId,
      text: "리뷰 요약이 어제부터 안 됩니다",
      route: "/channel/abc",
      failureCode: "laf:turn_rate_limited",
    });
    expect(receipt.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
  });

  test("keeps nothing about the screen when nothing was attached", async () => {
    const userId = await person();
    const receipt = await store.record({ userId, text: "고맙습니다" });

    const [row] = await database
      .select({ route: lafFeedback.route, code: lafFeedback.failureCode })
      .from(lafFeedback)
      .where(eq(lafFeedback.id, receipt.id));
    expect(row).toEqual({ route: null, code: null });
  });

  test("leaves with the person", async () => {
    const userId = await person();
    const receipt = await store.record({ userId, text: "안녕히" });

    await database.delete(users).where(eq(users.id, userId));
    made.splice(made.indexOf(userId), 1);

    const rows = await database
      .select({ id: lafFeedback.id })
      .from(lafFeedback)
      .where(eq(lafFeedback.id, receipt.id));
    expect(rows).toEqual([]);
  });
});

describe("a support row in the outbox", () => {
  const took: Record<string, NotificationRecord[]> = {};
  const door = (
    name: string,
    accepts?: NotificationAdapter["accepts"],
  ): NotificationAdapter => ({
    name,
    ...(accepts ? { accepts } : {}),
    deliver: async (record) => {
      took[name] = [...(took[name] ?? []), record];
      return true;
    },
  });

  test("goes only to the door that asked for it, and is read back with its facts", async () => {
    const userId = await person();
    const outbox = createNotificationOutbox({
      database,
      adapters: [
        door("socket"),
        door("webhook"),
        door("support-webhook", (kind) => kind === "support.feedback"),
      ],
    });

    const record = await outbox.enqueue({
      kind: "support.feedback",
      botId: "",
      userId,
      support: { feedbackId: "f-1", text: "안 됩니다", route: "/routines" },
    });

    expect(record?.deliveredVia).toEqual(["support-webhook"]);
    expect(took.socket ?? []).toEqual([]);
    expect(took.webhook ?? []).toEqual([]);
    expect(took["support-webhook"]?.[0]?.support).toEqual({
      feedbackId: "f-1",
      text: "안 됩니다",
      route: "/routines",
    });
  });

  test("and the door that asked for support rows gets nothing else", async () => {
    const userId = await person();
    const outbox = createNotificationOutbox({
      database,
      adapters: [
        door("socket2"),
        door("support-only", (kind) => kind === "support.feedback"),
      ],
    });

    const record = await outbox.enqueue({
      kind: "run.finished",
      botId: `bot-${userId}`,
      userId,
      channelId: "channel-1",
    });

    expect(record?.deliveredVia).toEqual(["socket2"]);
    expect(took["support-only"] ?? []).toEqual([]);
  });

  test("never appears in the person's own list", async () => {
    const userId = await person();
    const outbox = createNotificationOutbox({ database, adapters: [] });

    await outbox.enqueue({
      kind: "support.feedback",
      botId: "",
      userId,
      support: { feedbackId: "f-2", text: "고맙습니다" },
    });
    await outbox.enqueue({
      kind: "run.finished",
      botId: `bot-${userId}`,
      userId,
      channelId: "channel-1",
    });

    const listed = await outbox.list(userId);
    expect(listed.map((row) => row.kind)).toEqual(["run.finished"]);

    // The support row is still there; it is only not theirs to be shown.
    const stored = await database
      .select({ kind: lafNotifications.kind })
      .from(lafNotifications)
      .where(eq(lafNotifications.userId, userId));
    expect(stored.map((row) => row.kind).sort()).toEqual([
      "run.finished",
      "support.feedback",
    ]);
  });
});
