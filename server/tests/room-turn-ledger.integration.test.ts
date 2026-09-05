import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { createTurnFailureReader } from "../src/channels/turn-failures";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
  lafThreadMessages,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import { createRoomService } from "../src/rooms/service";
import { createBotLane } from "../src/runner/bot-lane";
import { createRunLedger } from "../src/runner/run-ledger";
import { TEST_POOL } from "./support/database";

/**
 * A ROOM'S FAILED TURN CAN BE SHOWN. A survey found two holes: `member-turn.ts` opened its ledger
 * row with no thread, and the person's message was written with no run. `GET /api/channels/:id/
 * failures` joins exactly those two columns, so a room where every member died left the question
 * sitting alone after a reload with nothing to say why — the same gap the chat path had, closed
 * for chat on 2026-09-06 and still open for rooms.
 *
 * Run against the real service, the real ledger and the real reader, because the fix is three
 * ids agreeing across three modules and a unit test of any one of them cannot see whether they do.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const prefix = `room-ledger-${randomUUID()}`;
const made = {
  users: [] as string[],
  agents: [] as string[],
  channels: [] as string[],
  threads: [] as string[],
};

afterAll(async () => {
  for (const threadId of made.threads) {
    await database
      .delete(lafThreadRuns)
      .where(eq(lafThreadRuns.threadId, threadId));
    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
  }
  if (made.channels.length > 0) {
    await database.delete(channels).where(inArray(channels.id, made.channels));
  }
  if (made.agents.length > 0) {
    await database.delete(agents).where(inArray(agents.id, made.agents));
  }
  if (made.users.length > 0) {
    await database.delete(users).where(inArray(users.id, made.users));
  }
  await database.$client.close();
});

/** A Bot whose endpoint is dead: every run throws the sentence a dead port actually throws. */
function deadAgent(): AbstractAgent {
  return {
    messages: [],
    setMessages() {},
    addMessage() {},
    async runAgent() {
      throw new Error(
        "Unable to connect. Is the computer able to access the url?",
      );
    },
  } as unknown as AbstractAgent;
}

async function makeRoom() {
  const userId = `${prefix}-user`;
  await database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "Room Ledger Test User",
  });
  made.users.push(userId);

  const memberIds = [`${prefix}-a`, `${prefix}-b`];
  await database.insert(agents).values(
    memberIds.map((id, index) => ({
      id,
      name: index === 0 ? "리스크 분석가" : "일상 비서",
      type: "remote_ag_ui" as const,
      configuration: {},
    })),
  );
  made.agents.push(...memberIds);

  const channelId = `channel_${prefix}`;
  const threadId = randomUUID();
  await database.insert(channels).values({
    id: channelId,
    name: "리스크 분석가, 일상 비서",
    description: "Private agent channel.",
  });
  made.channels.push(channelId);
  made.threads.push(threadId);
  await database.insert(channelMemberships).values({ channelId, userId });
  await database
    .insert(channelAgents)
    .values(memberIds.map((agentId) => ({ channelId, agentId })));
  await database.insert(channelThreads).values({ userId, channelId, threadId });

  return { userId, memberIds, channelId, threadId };
}

describe("a room turn in the ledger", () => {
  test("a turn whose members all failed is a failure the conversation can show", async () => {
    const { userId, memberIds, channelId, threadId } = await makeRoom();
    const rows: AuditEventInput[] = [];
    const service = createRoomService({
      database,
      lane: createBotLane(),
      ledger: createRunLedger(database),
      resolveAgents: async () =>
        Object.fromEntries(memberIds.map((id) => [id, deadAgent()])),
      emit: () => {},
      auditStore: { insert: async (row) => void rows.push(row) },
    });

    const started = await service.post({
      actor: { id: userId, role: "user" },
      actorLabel: `${userId}@example.test`,
      channelId,
      threadId,
      text: "@리스크 분석가 이번 주 매출 정리해 줘",
      personName: "사장님",
    });
    await started.finished;

    /*
     * THE THREE IDS AGREE. The person's message names the turn's run; the turn's run belongs to
     * the thread and ended in error; the reader joins the two and lands on the message.
     */
    const [message] = await database
      .select({ runId: lafThreadMessages.runId })
      .from(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
    expect(message?.runId).toBe(started.turnId);

    const runs = await database
      .select({
        runId: lafThreadRuns.runId,
        agentId: lafThreadRuns.agentId,
        status: lafThreadRuns.status,
        origin: lafThreadRuns.origin,
        error: lafThreadRuns.error,
      })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.threadId, threadId));
    const turn = runs.find((run) => run.runId === started.turnId);
    expect(turn).toMatchObject({
      agentId: null,
      status: "error",
      origin: "room",
    });
    // The member's own row belongs to the thread too — the half the survey found missing.
    const memberRuns = runs.filter((run) => run.runId !== started.turnId);
    expect(memberRuns.map((run) => run.agentId)).toEqual([memberIds[0]]);
    expect(memberRuns[0]?.status).toBe("error");

    const failures = await createTurnFailureReader(database)(threadId);
    expect(failures).toEqual([
      {
        messageId: started.messageId,
        code: "laf:turn_unreachable",
        at: expect.any(String),
      },
    ]);

    /*
     * And the trail says who was asked and why: the person named one member with an @-mention,
     * so only that member spoke in round 0, for that reason, and it failed.
     */
    const turns = rows.filter((row) => row.eventType === "room.member_turn");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.targetId).toBe(channelId);
    expect(turns[0]?.payload).toMatchObject({
      bot: memberIds[0],
      thread: threadId,
      turn: started.turnId,
      run: memberRuns[0]?.runId,
      round: 0,
      reason: "addressed",
      spoke: 0,
      failed: true,
    });
  });
});
