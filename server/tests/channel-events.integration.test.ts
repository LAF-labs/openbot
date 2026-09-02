import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  type ChannelActivityEvent,
  createChannelEventHub,
} from "../src/channels/events";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

function event(overrides: Partial<ChannelActivityEvent> = {}) {
  return {
    channelId: "channel_1",
    memberIds: ["user-1"],
    name: "Expense questions",
    lastMessage: "Said something.",
    lastMessageAt: "2026-08-15T10:00:00.000Z",
    lastMessageAgentId: null,
    ...overrides,
  } satisfies ChannelActivityEvent;
}

describe("channel event hub", () => {
  test("delivers only to the members of the channel", () => {
    const hub = createChannelEventHub();
    const member: string[] = [];
    const stranger: string[] = [];
    hub.register("user-1", (payload) => member.push(payload));
    hub.register("user-2", (payload) => stranger.push(payload));

    hub.deliver(event({ memberIds: ["user-1"] }));

    expect(member).toHaveLength(1);
    expect(JSON.parse(member[0] as string).lastMessage).toBe("Said something.");
    // Membership is what authorises delivery, so somebody outside the channel hears nothing.
    expect(stranger).toEqual([]);
  });

  test("reaches every connection a person has open", () => {
    const hub = createChannelEventHub();
    const received: string[] = [];
    hub.register("user-1", (payload) => received.push(`tab-a:${payload}`));
    hub.register("user-1", (payload) => received.push(`tab-b:${payload}`));

    hub.deliver(event());

    expect(received).toHaveLength(2);
    expect(hub.connectionCount("user-1")).toBe(2);
  });

  test("stops delivering once a connection detaches, and forgets the person", () => {
    const hub = createChannelEventHub();
    const received: string[] = [];
    const detach = hub.register("user-1", (payload) => received.push(payload));

    detach();
    hub.deliver(event());

    expect(received).toEqual([]);
    // Dropped rather than left as an empty set, so a long-lived process does not grow one per
    // person who has ever connected.
    expect(hub.connectionCount("user-1")).toBe(0);
  });

  test("one failing connection does not deny the event to the rest", () => {
    const hub = createChannelEventHub();
    const healthy: string[] = [];
    hub.register("user-1", () => {
      throw new Error("this socket is closing");
    });
    hub.register("user-1", (payload) => healthy.push(payload));

    expect(() => hub.deliver(event())).not.toThrow();
    expect(healthy).toHaveLength(1);
  });
});

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
/**
 * The hub the store announces into, built here so the test can watch what reaches it AND what the
 * database holds at the moment it does. See the delivery describe below.
 */
const hub = createChannelEventHub();
const store = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
  (event) => hub.deliver(event),
);
const testPrefix = `channel-events-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

/**
 * Delivery is in process now, and the thing that has to survive the change is the ORDERING.
 *
 * `pg_notify` used to give it for nothing: a NOTIFY issued inside a transaction reaches listeners on
 * commit and never after a rollback, so a message that rolled back was never announced. Nothing in
 * this process does that on its own — announce from inside the transaction and every member's roster
 * moves for a write that may never land, with no correction coming, because the roster query is the
 * only thing that would put it right and nobody has a reason to run it.
 *
 * So the assertion is not "the event arrived": it is that when the event arrives, a reader on a
 * DIFFERENT connection can already see the row. Under `read committed` that is only true after the
 * commit, which makes this test fail if the announcement is ever moved back inside the transaction.
 */
describe("channel activity delivery", () => {
  test("announces a recorded message, and only once the row is readable", async () => {
    const id = `${testPrefix}-user-${randomUUID()}`;
    await database.insert(users).values({
      id,
      email: `${id}@example.test`,
      name: "Channel Events Test User",
    });
    createdUserIds.push(id);
    const owner: AgentActor = { id, role: "user" };

    const profile = await profileStore.create(owner, {
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
      visibility: "private",
    });
    createdAgentIds.push(profile.id);
    const channel = await store.create(owner, [profile.id]);
    createdChannelIds.push(channel.id);

    const delivered: ChannelActivityEvent[] = [];
    /**
     * The roster row as a SEPARATE connection saw it, read the instant the event was handed over.
     *
     * Started inside the delivery callback on purpose. Announced from inside the transaction, this
     * read would find the row as it was before — a plain SELECT under `read committed` does not
     * block on an uncommitted write, it reads the old version — and the assertion below would fail.
     */
    let readOnDelivery: Promise<string | null | undefined> | null = null;
    const detach = hub.register(owner.id, (payload) => {
      delivered.push(JSON.parse(payload));
      readOnDelivery = database
        .select({ lastMessage: channels.lastMessage })
        .from(channels)
        .where(eq(channels.id, channel.id))
        .then(([row]) => row?.lastMessage);
    });

    try {
      await store.recordActivity(owner, channel.id, {
        agentId: profile.id,
        at: new Date(),
        text: "Categorized three expenses.",
      });
    } finally {
      detach();
    }

    expect(await readOnDelivery).toBe("Categorized three expenses.");

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      channelId: channel.id,
      lastMessage: "Categorized three expenses.",
      lastMessageAgentId: profile.id,
      memberIds: [owner.id],
    });
  });

  test("says nothing when the write rolls back", async () => {
    // The store is handed a channel that is not this person's, so `recordActivity` throws and the
    // transaction never commits. An announcement here would move a roster row for a message that
    // does not exist.
    const id = `${testPrefix}-user-${randomUUID()}`;
    await database.insert(users).values({
      id,
      email: `${id}@example.test`,
      name: "Channel Events Rollback User",
    });
    createdUserIds.push(id);
    const owner: AgentActor = { id, role: "user" };

    const heard: ChannelActivityEvent[] = [];
    const detach = hub.register(owner.id, (payload) =>
      heard.push(JSON.parse(payload)),
    );
    try {
      await expect(
        store.recordActivity(owner, `${testPrefix}-no-such-channel`, {
          agentId: null,
          at: new Date(),
          text: "Never happened.",
        }),
      ).rejects.toThrow();
    } finally {
      detach();
    }

    expect(heard).toEqual([]);
  });
});
