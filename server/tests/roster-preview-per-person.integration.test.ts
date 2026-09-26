import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createAccountDeletion } from "../src/account/deletion";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { ChannelActivityEvent } from "../src/channels/events";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  channelMemberships,
  channels,
  channelThreads,
  lafThreadMessages,
  users,
} from "../src/db/schema";
import { createRoutineDelivery } from "../src/routines/deliver";
import { TEST_POOL } from "./support/database";

/**
 * The line under a conversation on the roster belongs to the person reading it.
 *
 * Every person in a channel has a thread of their own, and the preview was stored once per CHANNEL
 * — so in a channel two people were in, one person's last sentence was the other's roster line, and
 * a leaver's last words stayed on the survivor's row after the account was deleted (audit A5-7,
 * measured by seeding exactly this and deleting one of them). A channel reaches two people through
 * data rather than through any route today, which is how the audit reached it too, and how this
 * does: two memberships and two threads, then each of the three writers — the browser's report of
 * a chat turn, a routine's delivery, a room message — writes into the owner's thread.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
  undefined,
  // Seats for a Bot per test for the same owner; one Bot a person is the product's number, not this file's.
  10,
);
const announced: ChannelActivityEvent[] = [];
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("roster-preview-test"),
  (event) => announced.push(event),
);

const run = randomUUID().slice(0, 8);
const OWNER: AgentActor = { id: `preview-owner-${run}`, role: "user" };
const STAFF: AgentActor = { id: `preview-staff-${run}`, role: "user" };
const SECRET = `사장님만 보는 이번 달 매출 ${run}`;
const madeChannels: string[] = [];
const madeThreads: string[] = [];
const madeBots: string[] = [];

afterAll(async () => {
  await database
    .delete(lafThreadMessages)
    .where(inArray(lafThreadMessages.threadId, madeThreads));
  await database.delete(channels).where(inArray(channels.id, madeChannels));
  for (const bot of madeBots) {
    await profileStore.delete(OWNER, bot).catch(() => {});
  }
  await database.delete(users).where(inArray(users.id, [OWNER.id, STAFF.id]));
});

/** The owner's Bot, and one conversation with it that the member of staff is in as well. */
async function sharedConversation() {
  for (const person of [OWNER, STAFF]) {
    await database
      .insert(users)
      .values({
        id: person.id,
        email: `${person.id}@laf.test`,
        name: person.id,
      })
      .onConflictDoNothing();
  }
  const bot = await profileStore.create(OWNER, {
    name: "매출봇",
    roleDescription: "Knows the numbers.",
  });
  madeBots.push(bot.id);
  const channel = await channelStore.create(OWNER, [bot.id]);
  madeChannels.push(channel.id);
  madeThreads.push(channel.threadId);
  const staffThread = `preview-staff-thread-${randomUUID()}`;
  madeThreads.push(staffThread);
  await database
    .insert(channelMemberships)
    .values({ channelId: channel.id, userId: STAFF.id });
  await database
    .insert(channelThreads)
    .values({ channelId: channel.id, userId: STAFF.id, threadId: staffThread });
  return {
    botId: bot.id,
    channelId: channel.id,
    ownerThread: channel.threadId,
  };
}

async function lineFor(person: AgentActor, channelId: string) {
  const row = (await channelStore.list(person)).find(
    (summary) => summary.id === channelId,
  );
  return row ? { lastMessage: row.lastMessage, unread: row.unread } : null;
}

describe("a roster line in a conversation two people are in", () => {
  test("the owner's chat turn is the owner's line and not the staff member's", async () => {
    const { channelId } = await sharedConversation();
    announced.splice(0);

    await channelStore.recordActivity(OWNER, channelId, {
      text: SECRET,
      agentId: null,
      at: new Date(),
    });

    expect(await lineFor(OWNER, channelId)).toEqual({
      lastMessage: SECRET,
      unread: false,
    });
    const staff = await lineFor(STAFF, channelId);
    expect(staff?.lastMessage ?? null).toBeNull();
    // Announced to the person whose row moved, and to nobody else's open tab.
    expect(announced.map((event) => event.memberIds)).toEqual([[OWNER.id]]);
  });

  test("a routine's answer lands on the owner's line alone", async () => {
    const { botId, channelId } = await sharedConversation();

    await createRoutineDelivery(database)({
      agentId: botId,
      userId: OWNER.id,
      routineName: "매출 보고",
      answer: SECRET,
      at: new Date(),
    });
    expect((await lineFor(OWNER, channelId))?.lastMessage).toBe(SECRET);
    expect((await lineFor(STAFF, channelId))?.lastMessage ?? null).toBeNull();
  });

  test("when the owner leaves, nothing they said is left on the staff member's roster", async () => {
    const { channelId } = await sharedConversation();
    await channelStore.recordActivity(OWNER, channelId, {
      text: SECRET,
      agentId: null,
      at: new Date(),
    });

    await createAccountDeletion({ database }).delete({
      userId: OWNER.id,
      by: OWNER.id,
    });

    // The channel stays — the staff member is still in it — and neither its row nor the staff
    // member's own conversation row carries a word of what the owner said. It was the channel's
    // row the audit found the leaver's sentence on.
    const [channel] = await database
      .select()
      .from(channels)
      .where(inArray(channels.id, [channelId]));
    expect(channel).toBeDefined();
    expect(JSON.stringify(channel)).not.toContain(SECRET);
    const staffRows = await database
      .select()
      .from(channelThreads)
      .where(inArray(channelThreads.channelId, [channelId]));
    expect(staffRows.map((row) => row.userId)).toEqual([STAFF.id]);
    expect(JSON.stringify(staffRows)).not.toContain(SECRET);
  });
});
