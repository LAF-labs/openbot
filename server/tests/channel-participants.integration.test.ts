/**
 * Changing who is in a conversation that is already going on.
 *
 * There was no way to do either. A room's membership was decided once, at creation, and somebody
 * who wanted a fourth colleague had to start a new room and leave everything already said in the
 * old one. These hold the three things that make the change safe rather than merely possible: the
 * history stays where it is, the room's NAME follows its membership, and the last pair cannot be
 * broken up — see `removeParticipant` for why that last one is not fussiness.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  AgentNotFoundError,
  createAgentProfileStore,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  ChannelMembershipError,
  ChannelNotFoundError,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  channelThreads,
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

const testPrefix = `channel-participants-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(channelThreads)
      .where(eq(channelThreads.channelId, channelId));
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

async function createUser(
  role: AgentActor["role"] = "user",
): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Participants Test User",
  });
  createdUserIds.push(id);
  return { id, role };
}

async function createAgent(owner: AgentActor, name: string) {
  const profile = await profileStore.create(owner, {
    name,
    title: "Colleague",
    roleDescription: "Does a job.",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

async function createRoom(owner: AgentActor, names: string[]) {
  const agentIds: string[] = [];
  for (const name of names) agentIds.push(await createAgent(owner, name));
  const channel = await store.create(owner, agentIds);
  createdChannelIds.push(channel.id);
  return { agentIds, channel };
}

describe("adding a Bot to a conversation", () => {
  test("joins the room and keeps its thread, so nothing said is lost", async () => {
    const owner = await createUser();
    const { channel } = await createRoom(owner, ["일상 비서", "지식 도우미"]);
    const joining = await createAgent(owner, "회계 담당");

    const after = await store.addParticipant?.(owner, channel.id, joining);

    expect(after?.agentIds).toContain(joining);
    expect(after?.agentIds).toHaveLength(3);
    // The whole point of a membership change rather than a new room.
    expect(after?.threadId).toBe(channel.threadId);
  });

  test("renames the room, because the roster row is where a room is named", async () => {
    const owner = await createUser();
    const { channel } = await createRoom(owner, ["일상 비서", "지식 도우미"]);
    const joining = await createAgent(owner, "회계 담당");

    const after = await store.addParticipant?.(owner, channel.id, joining);

    expect(after?.name).toContain("회계 담당");
    // A row still naming two people after a third joined is a row that lies.
    const reread = await store.get(owner, channel.id);
    expect(reread?.name).toBe(after?.name as string);
  });

  /**
   * A room is the other way a Bot gets named, and the id travels in the body.
   *
   * `addParticipant` and `create` both resolve the Bot through `profileStore.getWithin`, so the
   * visibility rule reaches them — but only if it is asked of the actor rather than of the role.
   * An administrator who could add a colleague's private Bot to a room of their own would get its
   * name in the roster row, its title in the room's prompt header, and its answers in a transcript
   * that person never sees.
   */
  test("refuses a private Bot the actor does not own, an administrator included", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const administrator = await createUser("admin");
    const theirs = await createAgent(owner, "정산이");

    for (const outsider of [stranger, administrator]) {
      const own = await createAgent(outsider, "제 것");
      const mine = await createAgent(outsider, "제 것 둘");
      const channel = await store.create(outsider, [own, mine]);
      createdChannelIds.push(channel.id);

      // Into a room of their own, by id.
      await expect(
        store.addParticipant?.(outsider, channel.id, theirs),
      ).rejects.toThrow(AgentNotFoundError);
      // And a new room made around it, which is the same check one function earlier.
      await expect(store.create(outsider, [theirs])).rejects.toThrow(
        AgentNotFoundError,
      );
      const after = await store.get(outsider, channel.id);
      expect(after?.agentIds).not.toContain(theirs);
    }
  });

  test("refuses somebody already in it, with a code and no prose", async () => {
    const owner = await createUser();
    const { agentIds, channel } = await createRoom(owner, ["A", "B"]);

    const attempt = store.addParticipant?.(
      owner,
      channel.id,
      agentIds[0] as string,
    );

    await expect(attempt).rejects.toThrow(ChannelMembershipError);
    await attempt?.catch((error: unknown) => {
      expect((error as ChannelMembershipError).code).toBe(
        "laf:already_in_room",
      );
    });
  });

  test("refuses a channel belonging to somebody else, as absent", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { channel } = await createRoom(owner, ["A", "B"]);
    const joining = await createAgent(stranger, "C");

    // Not "forbidden": another person's conversation must not be confirmed to exist.
    await expect(
      store.addParticipant?.(stranger, channel.id, joining),
    ).rejects.toThrow(ChannelNotFoundError);
  });
});

describe("taking a Bot out of a conversation", () => {
  test("leaves the room, keeps the thread and renames it", async () => {
    const owner = await createUser();
    const { agentIds, channel } = await createRoom(owner, ["A", "B", "C"]);
    const leaving = agentIds[2] as string;

    const after = await store.removeParticipant?.(owner, channel.id, leaving);

    expect(after?.agentIds).not.toContain(leaving);
    expect(after?.agentIds).toHaveLength(2);
    expect(after?.threadId).toBe(channel.threadId);
    expect(after?.name).not.toContain("C");
  });

  test("refuses to break up the last pair", async () => {
    const owner = await createUser();
    const { agentIds, channel } = await createRoom(owner, ["A", "B"]);

    const attempt = store.removeParticipant?.(
      owner,
      channel.id,
      agentIds[0] as string,
    );

    await expect(attempt).rejects.toThrow(ChannelMembershipError);
    await attempt?.catch((error: unknown) => {
      expect((error as ChannelMembershipError).code).toBe("laf:room_too_small");
    });
  });

  test("a room of one would be a second channel `create` never returns", async () => {
    const owner = await createUser();
    const { agentIds, channel } = await createRoom(owner, ["A", "B"]);

    await store
      .removeParticipant?.(owner, channel.id, agentIds[0] as string)
      .catch(() => undefined);

    // The refusal has to actually leave the room alone, not merely report.
    const reread = await store.get(owner, channel.id);
    expect(reread?.agentIds).toHaveLength(2);
  });

  test("refuses somebody who was never in it", async () => {
    const owner = await createUser();
    const { channel } = await createRoom(owner, ["A", "B", "C"]);
    const outsider = await createAgent(owner, "D");

    const attempt = store.removeParticipant?.(owner, channel.id, outsider);

    await attempt?.catch((error: unknown) => {
      expect((error as ChannelMembershipError).code).toBe("laf:not_in_room");
    });
    await expect(attempt).rejects.toThrow(ChannelMembershipError);
  });

  test("a Bot can be taken out and put back", async () => {
    const owner = await createUser();
    const { agentIds, channel } = await createRoom(owner, ["A", "B", "C"]);
    const leaving = agentIds[2] as string;

    await store.removeParticipant?.(owner, channel.id, leaving);
    const after = await store.addParticipant?.(owner, channel.id, leaving);

    expect(after?.agentIds).toContain(leaving);
    expect(after?.threadId).toBe(channel.threadId);
  });
});
