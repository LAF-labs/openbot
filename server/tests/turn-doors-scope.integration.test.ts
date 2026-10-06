/**
 * A conversation belongs to the person whose it is, and the doors of a turn say so.
 *
 * One VM belongs to one person, but an account from before 2026-09-24 can still share it — so
 * "signed in" must never be the whole check standing between one person and another's conversation
 * with their Bot. Six of the seven doors a window uses on a turn (`turns/routes.ts`) name a
 * conversation, and each reads whose it is from `channel_threads`, the row the server itself wrote
 * when the conversation was made, and answers anybody else as it answers a thread that is not there.
 *
 * THE SEVENTH NAMES NO CONVERSATION. 건너뛰기 (`POST /api/turns/skips`) is handed a Bot and a call,
 * so there is no `channel_threads` row for it to read: what it asks is whose the Bot is — the rule
 * every door that names a Bot asks (`mayDriveBot`, read from `agent_profiles`) — and it answers
 * somebody else's Bot as it answers one that is not there. That is all it asks, and all that is
 * held for it here: the skip is then filed under the call's id alone (`turns/people.ts`), so the
 * door holds whose Bot was named, not that the call is that Bot's.
 *
 * These facts were held for the doors a window-driven turn used — the CopilotKit runtime's thread
 * routes, primed by the runner — until those went with the run door (2026-10-06). The doors a turn
 * has now had no test of whose conversation they open; this is it, moved to where the product is.
 *
 * Two real people in a real database, because the rule is a fact about a row in Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import {
  type AppVariables,
  actorMayDriveBot,
  lookupBotOwner,
} from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  channelThreads,
  lafThreadMessages,
  users,
} from "../src/db/schema";
import { appendMessages, type StoredMessage } from "../src/runner/thread-store";
import type { TurnEngine } from "../src/turns/engine";
import type { TurnHub } from "../src/turns/hub";
import type { PersonAnswers } from "../src/turns/people";
import { createTurnRoutes } from "../src/turns/routes";
import { TEST_POOL } from "./support/database";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("whose conversation a turn's doors open", () => {
  const database = createDatabase(databaseUrl ?? "", TEST_POOL);
  const run = randomUUID().slice(0, 8);

  /** Two people on the one VM they share. */
  const OWNER = `turn-scope-owner-${run}`;
  const STAFF = `turn-scope-staff-${run}`;
  const ownerThread = `turn-scope-owner-thread-${run}`;
  const staffThread = `turn-scope-staff-thread-${run}`;
  const ownerChannel = `turn-scope-owner-channel-${run}`;
  const staffChannel = `turn-scope-staff-channel-${run}`;
  /** Rows, and nobody's: no `channel_threads` row says whose this is. */
  const orphan = `turn-scope-orphan-${run}`;
  /** The owner's Bot, by the row that says so, and an id no row answers to. */
  const ownerBot = `turn-scope-owner-bot-${run}`;
  const noSuchBot = `turn-scope-no-such-bot-${run}`;

  const said = (id: string) =>
    ({ id, role: "user", content: id }) as unknown as StoredMessage;

  beforeAll(async () => {
    await database.insert(users).values([
      { id: OWNER, email: `${OWNER}@laf.test`, name: "Owner" },
      { id: STAFF, email: `${STAFF}@laf.test`, name: "Staff" },
    ]);
    await database.insert(agents).values({
      id: ownerBot,
      name: "Owner's Bot",
      type: "remote_ag_ui",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: ownerBot,
      ownerUserId: OWNER,
      roleDescription: "Answers its owner.",
      avatarSeed: ownerBot,
    });
    await database.insert(channels).values([
      { id: ownerChannel, name: "Owner", description: "owner" },
      { id: staffChannel, name: "Staff", description: "staff" },
    ]);
    await database.insert(channelThreads).values([
      { userId: OWNER, channelId: ownerChannel, threadId: ownerThread },
      { userId: STAFF, channelId: staffChannel, threadId: staffThread },
    ]);
    await appendMessages(database, ownerThread, [said("owner-said-this")]);
    await appendMessages(database, staffThread, [said("staff-said-this")]);
    await appendMessages(database, orphan, [said("nobody-said-this")]);
  });

  // Only what this file made: two users, a Bot, two channels, three threads, by identity.
  afterAll(async () => {
    // The Bot's profile goes with its row.
    await database.delete(agents).where(inArray(agents.id, [ownerBot]));
    await database
      .delete(lafThreadMessages)
      .where(
        inArray(lafThreadMessages.threadId, [ownerThread, staffThread, orphan]),
      );
    await database
      .delete(channelThreads)
      .where(inArray(channelThreads.userId, [OWNER, STAFF]));
    await database
      .delete(channels)
      .where(inArray(channels.id, [ownerChannel, staffChannel]));
    await database.delete(users).where(inArray(users.id, [OWNER, STAFF]));
    await database.$client.close();
  });

  /**
   * The doors as one person reaches them, over an engine that keeps what it was asked.
   *
   * Every Bot is theirs to drive unless a test says whose it is: on the doors that name a
   * conversation, the conversation's row is then the only thing standing between two people.
   */
  function doorsAs(
    person: string,
    mayDriveBot: (botId: string) => Promise<boolean> = async () => true,
  ) {
    const reached: string[] = [];
    const engine = {
      send: async () => {
        reached.push("engine.send");
        return { ok: true as const, turnId: "turn-1" };
      },
      stop: () => {
        reached.push("engine.stop");
        return true;
      },
      busy: () => {
        reached.push("engine.busy");
        return false;
      },
    } as unknown as TurnEngine;
    const hub = {
      epoch: "epoch-1",
      state: () => {
        reached.push("hub.state");
        return { seq: 0, turn: null };
      },
      subscribe: () => {
        reached.push("hub.subscribe");
        return () => {};
      },
    } as unknown as TurnHub;
    const people = {
      answer: () => {
        reached.push("people.answer");
        return true;
      },
      awaiting: () => {
        reached.push("people.awaiting");
        return [];
      },
      skip: () => {
        reached.push("people.skip");
      },
    } as unknown as PersonAnswers;
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: person,
        email: `${person}@laf.test`,
        role: "user",
      });
      context.set("mayDriveBot", mayDriveBot);
      await next();
    };
    const app = new Hono().route(
      "/api/turns",
      createTurnRoutes({ database, engine, hub, people, requireUser }),
    );
    return { app, reached };
  }

  /** Every door a turn has that names a conversation, as a window presses it. */
  const doorsOf = (threadId: string): [string, string, unknown?][] => [
    [
      "POST",
      `/api/turns/${threadId}`,
      { botId: "bot-1", messages: [{ id: "m1", role: "user", content: "hi" }] },
    ],
    ["GET", `/api/turns/${threadId}`],
    ["POST", `/api/turns/${threadId}/stop`],
    ["POST", `/api/turns/${threadId}/answers/call-1`, { value: "yes" }],
    ["GET", `/api/turns/${threadId}/history`],
    ["GET", `/api/turns/${threadId}/stream`],
  ];

  const press = (
    app: ReturnType<typeof doorsAs>["app"],
    [method, path, body]: [string, string, unknown?],
  ) =>
    app.request(`http://laf.test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });

  test("somebody else's conversation is not there, on every door, and nothing of it is reached", async () => {
    const { app, reached } = doorsAs(STAFF);

    for (const door of doorsOf(ownerThread)) {
      const response = await press(app, door);
      expect([
        door[0],
        door[1],
        response.status,
        await response.json(),
      ]).toEqual([
        door[0],
        door[1],
        404,
        { error: "laf:thread_not_found", code: "laf:thread_not_found" },
      ]);
    }
    // Refused before the engine, the hub or the waiting answers were asked anything: the same
    // answer as for a thread that does not exist, and no way to tell the two apart.
    expect(reached).toEqual([]);
  });

  test("a person's own conversation is read, and holds nothing of anybody else's", async () => {
    const mine = await press(doorsAs(OWNER).app, [
      "GET",
      `/api/turns/${ownerThread}/history`,
    ]);
    const theirs = await press(doorsAs(STAFF).app, [
      "GET",
      `/api/turns/${staffThread}/history`,
    ]);

    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("no-store");
    expect(
      ((await mine.json()) as { messages: { id: string }[] }).messages.map(
        (message) => message.id,
      ),
    ).toEqual(["owner-said-this"]);
    expect(
      ((await theirs.json()) as { messages: { id: string }[] }).messages.map(
        (message) => message.id,
      ),
    ).toEqual(["staff-said-this"]);
  });

  test("a thread with no owner row is refused rather than read", async () => {
    // It holds a message, so a refusal here is the rule and not an empty answer. A thread nothing
    // recorded an owner for belongs to nobody, not to everybody.
    const { app, reached } = doorsAs(OWNER);

    for (const door of doorsOf(orphan)) {
      const response = await press(app, door);
      expect([door[0], door[1], response.status]).toEqual([
        door[0],
        door[1],
        404,
      ]);
    }
    expect(reached).toEqual([]);
  });

  test("건너뛰기 is pressed for a Bot the person may drive: somebody else's is not there, and nothing is skipped", async () => {
    /** Whose a Bot is, as `requireUser` puts it beside the actor: the rule, over the row. */
    const mayDriveAs =
      (person: string) =>
      async (botId: string): Promise<boolean> =>
        actorMayDriveBot(
          { id: person, role: "user" },
          await lookupBotOwner(database, botId),
        );
    const skip = (botId: string): [string, string, unknown] => [
      "POST",
      "/api/turns/skips",
      { botId, toolCallId: "call-1" },
    ];

    const staff = doorsAs(STAFF, mayDriveAs(STAFF));
    // The same answer for a Bot that is the owner's and for one that is nobody's row at all.
    for (const botId of [ownerBot, noSuchBot]) {
      const response = await press(staff.app, skip(botId));
      expect([botId, response.status, await response.json()]).toEqual([
        botId,
        404,
        { error: "laf:bot_not_found", code: "laf:bot_not_found" },
      ]);
    }
    expect(staff.reached).toEqual([]);

    const owner = doorsAs(OWNER, mayDriveAs(OWNER));
    const response = await press(owner.app, skip(ownerBot));
    expect([response.status, await response.json()]).toEqual([
      200,
      { skipped: true },
    ]);
    expect(owner.reached).toEqual(["people.skip"]);
  });
});
