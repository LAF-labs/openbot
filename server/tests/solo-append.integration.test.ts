import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  channelThreads,
  lafThreadMessages,
  users,
} from "../src/db/schema";
import {
  appendToSoloConversation,
  createRoutineDelivery,
} from "../src/routines/deliver";
import { messagesFor } from "../src/runner/thread-store";
import { TEST_POOL } from "./support/database";

/**
 * Writing into the one conversation a Bot has with a person — and the difference between the two
 * things that do it.
 *
 * A ROUTINE IS NEWS AND RINGS THE BELL. A HANDOFF IS A RECEIPT AND DOES NOT. The person watched the
 * handoff happen in the other Bot's window a second ago; lighting the unread dot on this one would
 * send them to read what they had just read. Both still land in the transcript, because a Bot that
 * cannot remember what it was asked is not a colleague — which is the whole reason the second
 * writer exists.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const store = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("solo-append-test"),
);

const prefix = `solo-append-${randomUUID().slice(0, 8)}`;
const userIds: string[] = [];
const agentIds: string[] = [];
const channelIds: string[] = [];
const threadIds: string[] = [];

afterEach(async () => {
  for (const threadId of threadIds.splice(0)) {
    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
  }
  for (const channelId of channelIds.splice(0)) {
    await database
      .delete(channelThreads)
      .where(eq(channelThreads.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of agentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of userIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser(): Promise<AgentActor> {
  const id = `${prefix}-user-${randomUUID().slice(0, 8)}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Solo Append Tester" });
  userIds.push(id);
  return { id, role: "user" };
}

async function createBot(owner: AgentActor, name: string) {
  const profile = await profileStore.create(owner, {
    name,
    title: "Coworker",
    roleDescription: "Answers questions.",
    visibility: "private",
  });
  agentIds.push(profile.id);
  return profile.id;
}

async function createSolo(owner: AgentActor, agentId: string) {
  const channel = await store.create(owner, [agentId]);
  channelIds.push(channel.id);
  const [mapping] = await database
    .select({ threadId: channelThreads.threadId })
    .from(channelThreads)
    .where(eq(channelThreads.channelId, channel.id));
  if (mapping?.threadId) threadIds.push(mapping.threadId);
  return channel;
}

async function messagesIn(threadId: string) {
  return (await messagesFor(database, threadId)) as unknown as Array<{
    role: string;
    content: string;
    lafAgentId?: string;
  }>;
}

describe("writing into a Bot's own conversation", () => {
  test("a handoff is recorded in the transcript and leaves the roster alone", async () => {
    const owner = await createUser();
    const answering = await createBot(owner, "Knowledge");
    const channel = await createSolo(owner, answering);

    const target = await appendToSoloConversation(database, {
      agentId: answering,
      userId: owner.id,
      heading: "General Assistant → Knowledge",
      body: "> Where are the Q3 numbers?\n\nIn the wiki, under Finance.",
      at: new Date(),
    });
    if (!target) throw new Error("no solo conversation");

    const written = await messagesIn(target.threadId);
    expect(written).toHaveLength(1);
    expect(written[0]?.role).toBe("assistant");
    // Attributed to the Bot whose conversation this is — an unattributed message would be a hole
    // in a record the transcript reads as complete.
    expect(written[0]?.lafAgentId).toBe(answering);
    expect(written[0]?.content).toContain("General Assistant → Knowledge");
    expect(written[0]?.content).toContain("In the wiki, under Finance.");

    // The bell was NOT rung: no preview, nothing to make the room unread.
    const [row] = await database
      .select({
        lastMessage: channels.lastMessage,
        lastMessageAt: channels.lastMessageAt,
      })
      .from(channels)
      .where(eq(channels.id, channel.id));
    expect(row?.lastMessage ?? null).toBeNull();
    expect(row?.lastMessageAt ?? null).toBeNull();
  });

  test("a routine delivery writes the same way and does ring it", async () => {
    const owner = await createUser();
    const botId = await createBot(owner, "Morning");
    const channel = await createSolo(owner, botId);

    await createRoutineDelivery(database)({
      agentId: botId,
      userId: owner.id,
      routineName: "아침 리뷰 요약",
      answer: "Two reviews came in overnight.",
      at: new Date(),
    });

    const [row] = await database
      .select({
        lastMessage: channels.lastMessage,
        lastMessageAgentId: channels.lastMessageAgentId,
      })
      .from(channels)
      .where(eq(channels.id, channel.id));
    expect(row?.lastMessage).toContain("Two reviews came in overnight.");
    expect(row?.lastMessageAgentId).toBe(botId);
  });

  test("a routine with nothing to report writes nothing and rings nothing", async () => {
    // The `[SILENT]` the routine prompt asks for. Delivering it would put a marker in the
    // transcript and light the unread dot for a morning on which nothing happened.
    const owner = await createUser();
    const botId = await createBot(owner, "Quiet");
    const channel = await createSolo(owner, botId);
    const announced: unknown[] = [];

    await createRoutineDelivery(database, (event) => {
      announced.push(event);
    })({
      agentId: botId,
      userId: owner.id,
      routineName: "아침 리뷰 요약",
      answer: "[SILENT]",
      at: new Date(),
    });

    const threadId = threadIds.at(-1);
    if (!threadId) throw new Error("no solo thread");
    expect(await messagesIn(threadId)).toHaveLength(0);
    const [row] = await database
      .select({
        lastMessage: channels.lastMessage,
        lastMessageAt: channels.lastMessageAt,
      })
      .from(channels)
      .where(eq(channels.id, channel.id));
    expect(row?.lastMessage ?? null).toBeNull();
    expect(row?.lastMessageAt ?? null).toBeNull();
    expect(announced).toEqual([]);
  });

  test("a Bot with no conversation yet is left without one", async () => {
    // Creating a conversation as a side effect of a schedule or a handoff is a surprise, not a
    // feature: the person never opened this Bot, and a room appearing on its own says they did.
    const owner = await createUser();
    const botId = await createBot(owner, "Unopened");

    const target = await appendToSoloConversation(database, {
      agentId: botId,
      userId: owner.id,
      heading: "A → B",
      body: "nothing to see",
      at: new Date(),
    });

    expect(target).toBeNull();
    expect(await store.list(owner)).toEqual([]);
  });
});
