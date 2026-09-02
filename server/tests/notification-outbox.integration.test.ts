import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { lafNotifications, users } from "../src/db/schema";
import type { NotificationAdapter } from "../src/notifications/outbox";
import {
  createNotificationOutbox,
  purgeNotificationsBefore,
} from "../src/notifications/outbox";
import { TEST_POOL } from "./support/database";
import { A_CLICK } from "./support/subjects";

/**
 * The outbox against a real Postgres, because everything that can be wrong here is the database.
 *
 * The delivery record is an array column read back and appended to, the door's read is three
 * predicates and an order, and the cascade is a foreign key. None of those can be wrong in a
 * fake, and every one of them is a way the feature silently stops telling anybody anything.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];

/** A door that takes everything, so the delivery record has something to record. */
const takes = (name: string): NotificationAdapter => ({
  name,
  deliver: async () => true,
});

/** A door that never takes anything — the AlimTalk slot's shape. */
const refuses = (name: string): NotificationAdapter => ({
  name,
  deliver: async () => false,
});

async function createPerson(): Promise<string> {
  const id = `outbox-${suite}-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Outbox Test Person",
  });
  createdUserIds.push(id);
  return id;
}

beforeAll(async () => {
  // A row of ours must never be confused with a row somebody's app put here.
  await database
    .delete(lafNotifications)
    .where(eq(lafNotifications.botId, `bot-${suite}`));
});

afterEach(async () => {
  // Scoped to what this file made, never `delete(table)`: the suite shares one database.
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

describe("the notification outbox", () => {
  test("writes one row and records the doors that took it", async () => {
    const outbox = createNotificationOutbox({
      database,
      adapters: [takes("socket"), refuses("alimtalk"), takes("webhook")],
    });
    const userId = await createPerson();

    const record = await outbox.enqueue({
      kind: "approval.requested",
      botId: `bot-${suite}`,
      userId,
      approvalId: `approval-${suite}`,
      subject: A_CLICK,
    });

    expect(record).not.toBeNull();
    expect(record?.deliveredVia).toEqual(["socket", "webhook"]);
    expect(record?.deliveredAt).toBeTruthy();
    expect(record?.seenAt).toBeUndefined();

    // And it is in the table, not only in the answer.
    const [row] = await database
      .select()
      .from(lafNotifications)
      .where(eq(lafNotifications.id, record?.id ?? ""));
    expect(row?.kind).toBe("approval.requested");
    expect(row?.deliveredVia).toEqual(["socket", "webhook"]);
    expect(row?.deliveredAt).not.toBeNull();
    // The facts travel, so a door can say what is waiting without asking a registry that has
    // already forgotten. Stored as a jsonb OBJECT — see db/schema/json.ts.
    expect((row?.subject as { intent?: string })?.intent).toBe(A_CLICK.intent);
  });

  test("a row nobody could deliver stays undelivered rather than looking delivered", async () => {
    const outbox = createNotificationOutbox({
      database,
      adapters: [refuses("alimtalk")],
    });
    const userId = await createPerson();

    const record = await outbox.enqueue({
      kind: "run.finished",
      botId: `bot-${suite}`,
      userId,
      channelId: `channel-${suite}`,
    });

    expect(record?.deliveredVia).toEqual([]);
    expect(record?.deliveredAt).toBeUndefined();
    // Still readable through the in-app door, which is the whole point of writing the row first.
    expect((await outbox.list(userId)).map((one) => one.id)).toEqual([
      record?.id ?? "",
    ]);
  });

  test("the door hands over this person's unseen rows, newest first", async () => {
    const outbox = createNotificationOutbox({ database });
    const mine = await createPerson();
    const theirs = await createPerson();

    const older = await outbox.enqueue({
      kind: "approval.requested",
      botId: `bot-${suite}`,
      userId: mine,
      approvalId: `older-${suite}`,
    });
    // A distinct instant, so "newest first" is an assertion rather than a coin toss.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await outbox.enqueue({
      kind: "run.needs_you",
      botId: `bot-${suite}`,
      userId: mine,
    });
    await outbox.enqueue({
      kind: "approval.requested",
      botId: `bot-${suite}`,
      userId: theirs,
      approvalId: `theirs-${suite}`,
    });

    expect((await outbox.list(mine)).map((one) => one.id)).toEqual([
      newer?.id ?? "",
      older?.id ?? "",
    ]);
    // Nobody sees anybody else's, and the id comes from the session rather than the URL.
    expect((await outbox.list(theirs)).map((one) => one.kind)).toEqual([
      "approval.requested",
    ]);

    // `since` is the client's bookmark: what arrived after the row it already has.
    expect(
      (await outbox.list(mine, { since: older?.createdAt })).map(
        (one) => one.id,
      ),
    ).toEqual([newer?.id ?? ""]);
  });

  test("seen is per person, once, and answering marks every row about the question", async () => {
    const outbox = createNotificationOutbox({ database });
    const mine = await createPerson();
    const theirs = await createPerson();
    const approvalId = `answered-${suite}`;

    const asked = await outbox.enqueue({
      kind: "approval.requested",
      botId: `bot-${suite}`,
      userId: mine,
      approvalId,
    });
    const expired = await outbox.enqueue({
      kind: "approval.expired",
      botId: `bot-${suite}`,
      userId: mine,
      approvalId,
    });

    // Somebody else's id cannot mark it, and the answer does not say whether it exists.
    expect(await outbox.markSeen(theirs, asked?.id ?? "")).toBe(false);
    expect(await outbox.markSeen(mine, asked?.id ?? "")).toBe(true);
    // Twice is the same nothing as never: there is no row here left to mark.
    expect(await outbox.markSeen(mine, asked?.id ?? "")).toBe(false);

    // The question being answered takes down everything that was about it.
    expect(await outbox.markSeenForApproval(approvalId)).toBe(1);
    expect(await outbox.list(mine)).toHaveLength(0);
    const [row] = await database
      .select()
      .from(lafNotifications)
      .where(eq(lafNotifications.id, expired?.id ?? ""));
    expect(row?.seenAt).not.toBeNull();
  });

  test("a person who does not exist is a log line, never a throw", async () => {
    const logged: string[] = [];
    const outbox = createNotificationOutbox({
      database,
      log: (message) => logged.push(message),
    });

    // The caller was doing something more important than notifying somebody — opening a question,
    // finishing a run — and this must never be what fails it. See the module note.
    const record = await outbox.enqueue({
      kind: "approval.requested",
      botId: `bot-${suite}`,
      userId: `nobody-${suite}`,
    });

    expect(record).toBeNull();
    expect(logged.join(" ")).toContain("could not enqueue");
  });

  test("a person leaving takes their queue with them", async () => {
    const outbox = createNotificationOutbox({ database });
    const userId = await createPerson();
    await outbox.enqueue({
      kind: "run.finished",
      botId: `bot-${suite}`,
      userId,
      channelId: `channel-${suite}`,
    });

    await database.delete(users).where(eq(users.id, userId));
    createdUserIds.splice(createdUserIds.indexOf(userId), 1);

    expect(
      await database
        .select()
        .from(lafNotifications)
        .where(eq(lafNotifications.userId, userId)),
    ).toHaveLength(0);
  });

  test("the sweep takes what has aged out and leaves the rest", async () => {
    const outbox = createNotificationOutbox({ database });
    const userId = await createPerson();
    const old = await outbox.enqueue({
      kind: "run.finished",
      botId: `bot-${suite}`,
      userId,
    });
    const fresh = await outbox.enqueue({
      kind: "run.finished",
      botId: `bot-${suite}`,
      userId,
    });
    // Aged by hand rather than by waiting thirty days.
    await database
      .update(lafNotifications)
      .set({ createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })
      .where(eq(lafNotifications.id, old?.id ?? ""));

    const removed = await purgeNotificationsBefore(
      database,
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    );

    expect(removed).toBe(1);
    expect((await outbox.list(userId)).map((one) => one.id)).toEqual([
      fresh?.id ?? "",
    ]);
  });
});
