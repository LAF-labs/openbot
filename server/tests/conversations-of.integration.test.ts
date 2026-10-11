/**
 * ONE JOIN FOR "THIS PERSON'S CONVERSATIONS", AND "NOT BEING DELETED" IS IN IT (review,
 * 2026-10-10): each reader that goes through `conversationsOf` does not return a conversation
 * marked for deletion, and the two that say `includingDeleting` — the deletion itself, the count
 * behind the project limit — do. Pinned reader by reader, where the review found the condition
 * kept by hand.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  createProject,
  PROJECTS_PER_BOT,
  ProjectLimitError,
} from "../src/channels/conversations";
import { conversationsOf } from "../src/channels/conversations-of";
import { createProjectDeletion } from "../src/channels/deleting";
import { listChannels, readChannel } from "../src/channels/roster";
import { soloConversationOf } from "../src/channels/solo-channel";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const tag = randomUUID().slice(0, 8);
const ME = `of-me-${tag}`;
const BOT = `of-bot-${tag}`;
const actor = { id: ME } as AgentActor;
const made: string[] = [];

/** A conversation of this person's with the Bot: the four rows one is, marked or not. */
async function conversation(
  kind: "main" | "project",
  options?: { deleting?: boolean; count?: number },
) {
  const ids = Array.from(
    { length: options?.count ?? 1 },
    () => `of-${kind}-${randomUUID().slice(0, 8)}-${tag}`,
  );
  made.push(...ids);
  await database.insert(channels).values(
    ids.map((id) => ({
      id,
      name: "가을 메뉴 개편",
      description: "",
      kind,
      deletingAt: options?.deleting ? new Date() : null,
    })),
  );
  await database
    .insert(channelMemberships)
    .values(ids.map((channelId) => ({ channelId, userId: ME })));
  await database
    .insert(channelAgents)
    .values(ids.map((channelId) => ({ channelId, agentId: BOT })));
  await database.insert(channelThreads).values(
    ids.map((channelId) => ({
      userId: ME,
      channelId,
      threadId: randomUUID(),
    })),
  );
  return ids;
}

const mark = (channelId: string, deleting: boolean) =>
  database
    .update(channels)
    .set({ deletingAt: deleting ? new Date() : null })
    .where(eq(channels.id, channelId));

beforeAll(async () => {
  await database.insert(users).values({
    id: ME,
    email: `${ME}@laf.test`,
    name: ME,
    emailVerified: true,
  });
  await database.insert(agents).values({
    id: BOT,
    name: BOT,
    type: "remote_ag_ui" as const,
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: BOT,
    ownerUserId: ME,
    roleDescription: "",
    avatarSeed: "seed",
  });
});

afterAll(async () => {
  // Memberships, the Bot's link and the thread go with the channel, by their foreign keys.
  await database.delete(channels).where(inArray(channels.id, made));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.delete(users).where(eq(users.id, ME));
  await database.$client.end();
});

describe("the one join", () => {
  test("does not return a conversation marked for deletion", async () => {
    const [live] = await conversation("project");
    const [going] = await conversation("project", { deleting: true });
    const found = (
      await conversationsOf(
        database,
        { id: channels.id },
        { userId: ME, agentId: BOT },
      )
    ).map((row) => row.id);
    expect(found).toContain(live);
    expect(found).not.toContain(going);
  });

  test("returns one, said on the line that reads", async () => {
    const [going] = await conversation("project", { deleting: true });
    const found = (
      await conversationsOf(
        database,
        { id: channels.id },
        { userId: ME, agentId: BOT, includingDeleting: true },
      )
    ).map((row) => row.id);
    expect(found).toContain(going);
  });
});

describe("the Bot's main conversation (solo-channel.ts)", () => {
  test("is not answered while marked for deletion", async () => {
    const [main] = await conversation("main", { deleting: true });
    if (!main) throw new Error("no main");
    expect(await soloConversationOf(database, ME, BOT)).toBeNull();
    await mark(main, false);
    expect((await soloConversationOf(database, ME, BOT))?.channelId).toBe(main);
    // Left marked again: another file's `soloConversationOf` must not find this person's row.
    await mark(main, true);
  });
});

describe("the roster (roster.ts)", () => {
  test("does not read a project marked for deletion by its id", async () => {
    const [going] = await conversation("project", { deleting: true });
    if (!going) throw new Error("no project");
    expect(await readChannel(database, actor, going)).toBeNull();
    await mark(going, false);
    expect((await readChannel(database, actor, going))?.id).toBe(going);
  });

  test("does not list a project marked for deletion", async () => {
    const [live] = await conversation("project");
    const [going] = await conversation("project", { deleting: true });
    const listed = (await listChannels(database, actor)).map((one) => one.id);
    expect(listed).toContain(live);
    expect(listed).not.toContain(going);
  });
});

describe("the project limit (conversations.ts)", () => {
  test("counts a project being deleted: it holds its place until it is gone", async () => {
    const deps = {
      database,
      profileStore: createAgentProfileStore(
        database,
        new URL("https://managed.example.test/ag-ui"),
      ),
      threadIdentity: createThreadIdentity("test-deployment"),
    };
    const before = (
      await conversationsOf(
        database,
        { id: channels.id },
        { userId: ME, agentId: BOT, includingDeleting: true },
      ).where(eq(channels.kind, "project"))
    ).length;
    // Filled to one short of the limit with live projects, and the last place taken by one going.
    await conversation("project", { count: PROJECTS_PER_BOT - 1 - before });
    await conversation("project", { deleting: true });
    await expect(
      createProject(deps, actor, BOT, "one more"),
    ).rejects.toBeInstanceOf(ProjectLimitError);
  }, 30_000);
});

describe("the deletion (deleting.ts)", () => {
  test("finds a project already marked, and finishes it", async () => {
    const [going] = await conversation("project", { deleting: true });
    if (!going) throw new Error("no project");
    const deletion = createProjectDeletion({
      database,
      stopThread: async () => {},
    });
    const outcome = await deletion.delete({ userId: ME, channelId: going });
    expect(outcome).toMatchObject({ ok: true, counts: { channels: 1 } });
  });
});
