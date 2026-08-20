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
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * A Bot has one conversation.
 *
 * Every other table in this server is keyed on the Bot — policy identity, approvals, repetition
 * counts, credentials, the audit trail — and the conversation was the one thing that was not, so
 * every message from Home minted another channel and the roster filled with the same colleague.
 * These guard the rule at the only place it is decided.
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
  createThreadIdentity("test-deployment"),
);

const testPrefix = `channel-identity-${randomUUID()}`;
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

async function createUser(): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Conversation Identity Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(owner: AgentActor, name: string) {
  const profile = await profileStore.create(owner, {
    name,
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

describe("a Bot has one conversation", () => {
  test("asking for the same Bot twice returns the same channel", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner, "Expense Manager");

    const first = await store.create(owner, [agentId]);
    createdChannelIds.push(first.id);
    const second = await store.create(owner, [agentId]);

    expect(second.id).toBe(first.id);
    // The thread is what carries the history; a new one would be a new conversation wearing the
    // old one's name.
    expect(second.threadId).toBe(first.threadId);
    expect(await store.list(owner)).toHaveLength(1);
  });

  test("a different Bot is a different conversation", async () => {
    const owner = await createUser();
    const first = await createAgent(owner, "Expense Manager");
    const second = await createAgent(owner, "Knowledge");

    const one = await store.create(owner, [first]);
    createdChannelIds.push(one.id);
    const two = await store.create(owner, [second]);
    createdChannelIds.push(two.id);

    expect(two.id).not.toBe(one.id);
    expect(await store.list(owner)).toHaveLength(2);
  });

  test("another person's conversation with the same Bot is not reused", async () => {
    const owner = await createUser();
    const other = await createUser();
    const agentId = await createAgent(owner, "Shared Assistant");
    // Reachable by both: a private Bot is only ever its owner's.
    await profileStore.update(owner, agentId, { visibility: "public" });

    const mine = await store.create(owner, [agentId]);
    createdChannelIds.push(mine.id);
    const theirs = await store.create(other, [agentId]);
    createdChannelIds.push(theirs.id);

    expect(theirs.id).not.toBe(mine.id);
  });

  test("a group is a new conversation every time it is assembled", async () => {
    const owner = await createUser();
    const first = await createAgent(owner, "Expense Manager");
    const second = await createAgent(owner, "Knowledge");

    const one = await store.create(owner, [first, second]);
    createdChannelIds.push(one.id);
    const two = await store.create(owner, [first, second]);
    createdChannelIds.push(two.id);

    expect(two.id).not.toBe(one.id);
  });

  test("a group with a Bot does not become that Bot's conversation", async () => {
    const owner = await createUser();
    const first = await createAgent(owner, "Expense Manager");
    const second = await createAgent(owner, "Knowledge");

    const group = await store.create(owner, [first, second]);
    createdChannelIds.push(group.id);
    const alone = await store.create(owner, [first]);
    createdChannelIds.push(alone.id);

    expect(alone.id).not.toBe(group.id);
  });
});
