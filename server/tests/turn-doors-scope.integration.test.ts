/**
 * A conversation belongs to the person whose it is, and the doors of a turn say so.
 *
 * One VM belongs to one person, but an account from before 2026-09-24 can still share it — so
 * "signed in" must never be the whole check standing between one person and another's conversation
 * with their Bot. Every door a window uses on a turn (`turns/routes.ts`) reads whose conversation it
 * is from `channel_threads`, the row the server itself wrote when the conversation was made, and
 * answers anybody else as it answers a thread that is not there.
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
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
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

  const said = (id: string) =>
    ({ id, role: "user", content: id }) as unknown as StoredMessage;

  beforeAll(async () => {
    await database.insert(users).values([
      { id: OWNER, email: `${OWNER}@laf.test`, name: "Owner" },
      { id: STAFF, email: `${STAFF}@laf.test`, name: "Staff" },
    ]);
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

  // Only what this file made: two users, two channels, three threads, by identity.
  afterAll(async () => {
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

  /** The doors as one person reaches them, over an engine that keeps what it was asked. */
  function doorsAs(person: string) {
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
      context.set("mayDriveBot", async () => true);
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
});
