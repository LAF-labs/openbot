/**
 * The turns that ended without an answer, read back out of the ledger that already held them.
 *
 * Measured on 2026-09-06 against a Bot pointed at a dead port: `laf_thread_runs` had the failed run
 * with `status = 'error'` and the reason, and the person's own message in `laf_thread_messages`
 * carried the same `run_id` — and nothing in the app ever asked. The person saw a red English
 * sentence, and after a reload their question sat alone with no answer and nothing to say why.
 *
 * These hold the read: the right message, only real failures, and no prose crossing to the surface.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import {
  classifyTurnFailure,
  createTurnFailureReader,
  TURN_FAILURE_CODES,
} from "../src/channels/turn-failures";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  channelThreads,
  lafThreadMessages,
  lafThreadRuns,
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
const readFailures = createTurnFailureReader(database);

const testPrefix = `turn-failures-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdThreadIds: string[] = [];
const createdRunIds: string[] = [];

// Scoped to what this file made, every time. An unscoped delete here once erased a whole table.
afterEach(async () => {
  if (createdRunIds.length > 0) {
    await database
      .delete(lafThreadRuns)
      .where(inArray(lafThreadRuns.runId, createdRunIds.splice(0)));
  }
  for (const threadId of createdThreadIds.splice(0)) {
    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
  }
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

async function createUser(): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Turn Failure Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(owner: AgentActor) {
  const profile = await profileStore.create(owner, {
    name: "Disconnected Bot",
    title: "Dead endpoint",
    roleDescription: "Points nowhere.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

async function createChannel(owner: AgentActor) {
  const agentId = await createAgent(owner);
  const channel = await store.create(owner, [agentId]);
  createdChannelIds.push(channel.id);
  createdThreadIds.push(channel.threadId);
  return { agentId, channel };
}

/** One turn: a person's message, and the run that was supposed to answer it. */
async function recordTurn(
  threadId: string,
  agentId: string,
  userId: string,
  seq: number,
  outcome: { status: "error" | "done" | "stopped"; error?: string },
) {
  const runId = randomUUID();
  const messageId = randomUUID();
  createdRunIds.push(runId);
  await database.insert(lafThreadRuns).values({
    runId,
    threadId,
    agentId,
    userId,
    status: outcome.status,
    origin: "chat",
    startedAt: new Date(),
    finishedAt: new Date(),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  });
  await database.insert(lafThreadMessages).values({
    threadId,
    seq,
    runId,
    message: { id: messageId, role: "user", content: "오늘 매출 정리해줘" },
  });
  return { messageId, runId };
}

describe("classifyTurnFailure", () => {
  test("places the sentence a dead endpoint actually threw", () => {
    // Measured verbatim, 2026-09-06. This exact string was rendered in red on a Korean screen.
    expect(
      classifyTurnFailure(
        "Unable to connect. Is the computer able to access the url?",
      ),
    ).toBe(TURN_FAILURE_CODES.unreachable);
  });

  test("places a 404 with it: to the person, the Bot is simply not answering", () => {
    expect(classifyTurnFailure('HTTP 404: {"error":"Not found."}')).toBe(
      TURN_FAILURE_CODES.unreachable,
    );
  });

  test("keeps waiting, looking and asking-for-less apart", () => {
    expect(classifyTurnFailure("HTTP 429 Too Many Requests")).toBe(
      TURN_FAILURE_CODES.rateLimited,
    );
    expect(classifyTurnFailure("the request timed out")).toBe(
      TURN_FAILURE_CODES.timedOut,
    );
    expect(classifyTurnFailure("HTTP 401 Unauthorized")).toBe(
      TURN_FAILURE_CODES.refused,
    );
    expect(classifyTurnFailure("HTTP 502 Bad Gateway")).toBe(
      TURN_FAILURE_CODES.modelFailed,
    );
  });

  test("recognises the stall guard's own English prose", () => {
    expect(
      classifyTurnFailure(
        "지식 도우미 stopped responding. Nothing arrived from it for 2 minutes, so this turn was ended.",
      ),
    ).toBe(TURN_FAILURE_CODES.stalled);
  });

  test("falls back rather than guessing, and takes a null", () => {
    expect(classifyTurnFailure(null)).toBe(TURN_FAILURE_CODES.unknown);
    expect(classifyTurnFailure("   ")).toBe(TURN_FAILURE_CODES.unknown);
    expect(classifyTurnFailure("something new")).toBe(
      TURN_FAILURE_CODES.unknown,
    );
  });

  test("only ever answers with a code in the table", () => {
    const known = new Set<string>(Object.values(TURN_FAILURE_CODES));
    for (const input of [null, "", "404", "429", "boom", "timed out", "403"]) {
      expect(known.has(classifyTurnFailure(input))).toBe(true);
    }
  });
});

describe("turn failures for a thread", () => {
  test("names the message that got no answer, and says what kind of failure it was", async () => {
    const owner = await createUser();
    const { agentId, channel } = await createChannel(owner);
    const failed = await recordTurn(channel.threadId, agentId, owner.id, 1, {
      status: "error",
      error: "Unable to connect. Is the computer able to access the url?",
    });

    const failures = await readFailures(channel.threadId);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.messageId).toBe(failed.messageId);
    expect(failures[0]?.code).toBe(TURN_FAILURE_CODES.unreachable);
    expect(failures[0]?.at).toBeString();
  });

  test("sends a fact and never the stored English", async () => {
    const owner = await createUser();
    const { agentId, channel } = await createChannel(owner);
    const prose = "Unable to connect. Is the computer able to access the url?";
    await recordTurn(channel.threadId, agentId, owner.id, 1, {
      status: "error",
      error: prose,
    });

    const failures = await readFailures(channel.threadId);

    // The whole rule in one assertion: the server's words must not reach the surface.
    expect(JSON.stringify(failures)).not.toContain("Unable to connect");
    expect(JSON.stringify(failures)).not.toContain(prose);
  });

  test("says nothing about a turn that worked", async () => {
    const owner = await createUser();
    const { agentId, channel } = await createChannel(owner);
    await recordTurn(channel.threadId, agentId, owner.id, 1, {
      status: "done",
    });

    expect(await readFailures(channel.threadId)).toEqual([]);
  });

  test("never calls a turn somebody STOPPED a failure", async () => {
    const owner = await createUser();
    const { agentId, channel } = await createChannel(owner);
    await recordTurn(channel.threadId, agentId, owner.id, 1, {
      status: "stopped",
    });

    // Telling somebody their Bot broke when they pressed Stop is worse than saying nothing.
    expect(await readFailures(channel.threadId)).toEqual([]);
  });

  test("keeps two failures apart, each under its own question", async () => {
    const owner = await createUser();
    const { agentId, channel } = await createChannel(owner);
    const first = await recordTurn(channel.threadId, agentId, owner.id, 1, {
      status: "error",
      error: "Unable to connect. Is the computer able to access the url?",
    });
    const second = await recordTurn(channel.threadId, agentId, owner.id, 2, {
      status: "error",
      error: "HTTP 429 Too Many Requests",
    });

    const failures = await readFailures(channel.threadId);

    expect(failures.map((failure) => failure.messageId)).toEqual([
      first.messageId,
      second.messageId,
    ]);
    expect(failures.map((failure) => failure.code)).toEqual([
      TURN_FAILURE_CODES.unreachable,
      TURN_FAILURE_CODES.rateLimited,
    ]);
  });

  test("stays inside its own thread", async () => {
    const owner = await createUser();
    const mine = await createChannel(owner);
    const theirs = await createChannel(owner);
    await recordTurn(theirs.channel.threadId, theirs.agentId, owner.id, 1, {
      status: "error",
      error: "Unable to connect. Is the computer able to access the url?",
    });

    expect(await readFailures(mine.channel.threadId)).toEqual([]);
  });

  test("reads it through the store the routes actually use", async () => {
    const owner = await createUser();
    const { agentId, channel } = await createChannel(owner);
    const failed = await recordTurn(channel.threadId, agentId, owner.id, 1, {
      status: "error",
      error: "HTTP 503 Service Unavailable",
    });

    const failures = await store.failuresFor?.(channel.threadId);

    expect(failures).toHaveLength(1);
    expect(failures?.[0]?.messageId).toBe(failed.messageId);
    expect(failures?.[0]?.code).toBe(TURN_FAILURE_CODES.modelFailed);
  });

  test("has nothing to say about a thread nobody has used", async () => {
    const owner = await createUser();
    const { channel } = await createChannel(owner);
    expect(await readFailures(channel.threadId)).toEqual([]);
  });
});
