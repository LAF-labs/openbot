import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  AgentNotFoundError,
  createAgentProfileStore,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  ChannelNotFoundError,
  createChannelStore,
} from "../src/channels/routes";
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

const testPrefix = `channel-activity-${randomUUID()}`;
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
    name: "Channel Activity Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(owner: AgentActor, name = "Expense Manager") {
  const profile = await profileStore.create(owner, {
    name,
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

async function createChannel(owner: AgentActor, agentIds: string[]) {
  const channel = await store.create(owner, agentIds);
  createdChannelIds.push(channel.id);
  return channel;
}

/**
 * The roster reads the last thing said from our own row rather than from the Intelligence platform,
 * so it stays one indexed query however long the conversations get. What is stored is whatever the
 * client that ran the agent reported, which is why each of these guards exists.
 */
describe("channel activity", () => {
  test("records the last message and returns it on the roster", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    const at = new Date();

    await store.recordActivity(owner, channel.id, {
      agentId,
      at,
      text: "Categorized three expenses.",
    });

    expect(await store.list(owner)).toEqual([
      {
        ...channel,
        lastMessage: "Categorized three expenses.",
        lastMessageAgentId: agentId,
        lastMessageAt: at,
        // The Bot spoke and nobody has opened the room since, which is the whole definition.
        unread: true,
        createdAt: expect.any(Date),
      },
    ]);
  });

  test("a person's own message does not leave the room unread", async () => {
    /*
     * The condition that is easy to forget. Your own message is the newest thing in the room the
     * instant you send it, so without the "a Bot said it" half, every room you spoke in would mark
     * itself unread the moment you navigated away from it.
     */
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    await store.recordActivity(owner, channel.id, {
      agentId: null,
      at: new Date(),
      text: "Can you check the invoices?",
    });

    expect((await store.list(owner))[0]?.unread).toBe(false);
  });

  test("opening the room clears it, and marking unread brings it back", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    const at = new Date();

    await store.recordActivity(owner, channel.id, {
      agentId,
      at,
      text: "Categorized three expenses.",
    });
    expect((await store.list(owner))[0]?.unread).toBe(true);

    await store.setLastRead(owner, channel.id, new Date(at.getTime() + 1000));
    expect((await store.list(owner))[0]?.unread).toBe(false);

    // One millisecond before the last message: read again, deliberately, which is not the same
    // state as never opened.
    await store.setLastRead(owner, channel.id, new Date(at.getTime() - 1));
    expect((await store.list(owner))[0]?.unread).toBe(true);
  });

  test("a read mark belongs to the person who set it", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    await store.recordActivity(owner, channel.id, {
      agentId,
      at: new Date(),
      text: "Done.",
    });

    // Not a member: the mark cannot be moved, and the room is not even acknowledged to exist.
    await expect(
      store.setLastRead(stranger, channel.id, new Date()),
    ).rejects.toThrow();
    expect((await store.list(owner))[0]?.unread).toBe(true);
  });

  /*
   * THE FIVE TITLING TESTS THAT WERE HERE ARE GONE WITH THE FEATURE THEY GUARDED.
   *
   * A channel used to take its name from the first thing said in it, because a roster of five
   * conversations with the same Bot was five identical rows. That is fixed at the root now — a Bot
   * has one conversation, so a channel is named after its participants — and naming a colleague's
   * one room after whatever was typed into it first would freeze a stale sentence over their name.
   * See "a Bot has one conversation" in channel-conversation-identity.integration.test.ts.
   */

  test("keeps a person's roster to the channels they belong to", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    expect(await store.list(otherUser)).toEqual([]);
    await expect(
      store.recordActivity(otherUser, channel.id, {
        agentId: null,
        at: new Date(),
        text: "Not mine.",
      }),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  test("ignores a report older than what is already stored", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    const newest = new Date();
    const older = new Date(newest.getTime() - 60_000);

    await store.recordActivity(owner, channel.id, {
      agentId,
      at: newest,
      text: "The reply.",
    });
    // A person's message and the agent's reply are two separate reports. A slow one must not
    // overwrite a newer one that already landed.
    await store.recordActivity(owner, channel.id, {
      agentId: null,
      at: older,
      text: "The question.",
    });

    expect((await store.list(owner))[0]?.lastMessage).toBe("The reply.");
  });

  test("stores at most 200 code points, without control characters", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    await store.recordActivity(owner, channel.id, {
      agentId,
      at: new Date(),
      // A terminal escape and a newline: a preview is rendered as text, not replayed as control.
      text: `line one\nline two \u001b[31m ${"x".repeat(400)}`,
    });

    const stored = (await store.list(owner))[0]?.lastMessage ?? "";
    expect(Array.from(stored).length).toBeLessThanOrEqual(200);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they were removed.
    expect(stored).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(stored.startsWith("line one line two")).toBe(true);
  });

  test("refuses an agent that is not in the channel", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const strangerId = await createAgent(owner, "Stranger");
    const channel = await createChannel(owner, [agentId]);

    await expect(
      store.recordActivity(owner, channel.id, {
        agentId: strangerId,
        at: new Date(),
        text: "Not from this channel.",
      }),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  test("puts a channel just created above one that has already been used", async () => {
    const owner = await createUser();
    // Two Bots, because two conversations means two colleagues now: asking for the same Bot twice
    // returns its one conversation. See channel-conversation-identity.integration.test.ts.
    const agentId = await createAgent(owner);
    const otherAgentId = await createAgent(owner, "Knowledge");
    const used = await createChannel(owner, [agentId]);
    await store.recordActivity(owner, used.id, {
      agentId,
      // A minute back, not `now`. The activity time comes from this process and `created_at` comes
      // from Postgres, so two events written in the same instant are ordered by whichever clock is
      // marginally ahead. The property under test is the ordering rule, not the tie-break.
      at: new Date(Date.now() - 60_000),
      text: "Said something a minute ago.",
    });

    // Starting a conversation is the most recent thing this person did, and it is the one they are
    // about to type in. Sorting it under every channel that has a message would bury it.
    const fresh = await createChannel(owner, [otherAgentId]);

    expect((await store.list(owner)).map((channel) => channel.id)).toEqual([
      fresh.id,
      used.id,
    ]);
  });

  test("sorts by recency and leaves silent channels below, not absent", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const quietAgentId = await createAgent(owner, "Knowledge");
    const quiet = await createChannel(owner, [quietAgentId]);
    const busy = await createChannel(owner, [agentId]);

    await store.recordActivity(owner, busy.id, {
      agentId,
      // A minute forward, not `now`, for the reason the sibling test above gives
      // a minute back: the activity time comes from this process and `created_at`
      // comes from Postgres, and a Docker VM's clock drifts far enough (measured
      // +123ms on a laptop after sleep) to reorder two "same instant" writes.
      // The property under test is the ordering rule, not the tie-break.
      at: new Date(Date.now() + 60_000),
      text: "Said something.",
    });

    expect((await store.list(owner)).map((channel) => channel.id)).toEqual([
      busy.id,
      quiet.id,
    ]);
  });
});

describe("whose clock decides when something was said", () => {
  test("a browser running ahead cannot write a time past the database's own", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    // An hour ahead: what a laptop with a wrong clock reports.
    await store.recordActivity(owner, channel.id, {
      agentId,
      at: new Date(Date.now() + 3_600_000),
      text: "From the future.",
    });

    const [row] = await store.list(owner);
    const written = new Date(row?.lastMessageAt ?? 0).getTime();
    expect(written).toBeLessThan(Date.now() + 60_000);
    /*
     * And not clamped so hard that it lands behind the room's own `created_at`. Postgres runs its
     * own clock — measured ~66 ms ahead of this process — so clamping to `new Date()` here put a
     * message a person had just sent BELOW the moment the room was created, and the room did not
     * move to the top of their roster.
     */
    expect(written).toBeGreaterThanOrEqual(
      new Date(row?.createdAt ?? 0).getTime(),
    );
  });
});

describe("marking a room unread", () => {
  test("moves the boundary back, and never forward over messages nobody read", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);

    // Read up to here, then five replies land that nobody has read.
    const readAt = new Date(Date.now() - 60_000);
    await store.setLastRead(owner, channel.id, readAt);
    const newest = new Date(Date.now() - 1_000);

    /*
     * "Mark unread" puts the boundary just before the newest thing said. Taken literally on a room
     * that already had unread replies, that moved the mark FORWARD — and marked the earlier four
     * read. It must only ever move back.
     */
    const back = await store.setLastRead(
      owner,
      channel.id,
      new Date(newest.getTime() - 1),
      { neverForward: true },
    );
    expect(back.at?.getTime()).toBe(readAt.getTime());

    // From a room that WAS fully read, the same call does move the boundary back.
    await store.setLastRead(owner, channel.id, new Date());
    const later = await store.setLastRead(
      owner,
      channel.id,
      new Date(newest.getTime() - 1),
      { neverForward: true },
    );
    expect(later.at?.getTime()).toBe(newest.getTime() - 1);
  });
});
