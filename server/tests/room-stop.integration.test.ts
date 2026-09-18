import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent, Message } from "@ag-ui/client";
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
import type { RoomFrame } from "../src/rooms/frames";
import { createRoomService } from "../src/rooms/service";
import { createBotLane } from "../src/runner/bot-lane";
import { createWorkInFlight } from "../src/runner/in-flight";
import { createRunLedger } from "../src/runner/run-ledger";
import { TEST_POOL } from "./support/database";

/**
 * A room's turn, stopped by `모두 멈추기`.
 *
 * The room's own Stop moves the epoch and lets the member who is already thinking finish — a
 * sentence already paid for is worth keeping. `모두 멈추기` is the button for when something looks
 * wrong, so it cuts the member mid-thought as well: a member in a room can be driving the browser.
 * And it is a stop, not a failure, all the way down: the member is not counted as unable to answer,
 * the room is not told "nobody had anything to add", and after a reload the person's question has
 * no red line under it.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const prefix = `room-stop-${randomUUID().slice(0, 8)}`;
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

/** A member still thinking until it is aborted, counting how often it was asked. */
function thinkingMember() {
  let asked = 0;
  let release: (() => void) | undefined;
  const agent = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent() {
      asked += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { result: undefined, newMessages: [] };
    },
    abortRun() {
      release?.();
    },
  };
  return { agent: agent as unknown as AbstractAgent, asked: () => asked };
}

async function makeRoom() {
  const userId = `${prefix}-user`;
  await database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "Room Stop Test User",
  });
  made.users.push(userId);

  const memberIds = [`${prefix}-a`, `${prefix}-b`];
  await database.insert(agents).values(
    memberIds.map((id, index) => ({
      id,
      name: index === 0 ? "재고 담당" : "주문 담당",
      type: "remote_ag_ui" as const,
      configuration: {},
    })),
  );
  made.agents.push(...memberIds);

  const channelId = `channel_${prefix}`;
  const threadId = randomUUID();
  await database.insert(channels).values({
    id: channelId,
    name: "재고 담당, 주문 담당",
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

async function until(ready: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

describe("a room turn stopped by a person", () => {
  test("cuts the member mid-thought, asks nobody else, and is a stop rather than a failure", async () => {
    const { userId, memberIds, channelId, threadId } = await makeRoom();
    const [first, second] = [thinkingMember(), thinkingMember()];
    const work = createWorkInFlight();
    const frames: RoomFrame[] = [];
    const rows: AuditEventInput[] = [];
    const service = createRoomService({
      database,
      lane: createBotLane(),
      ledger: createRunLedger(database),
      resolveAgents: async () => ({
        [memberIds[0] as string]: first.agent,
        [memberIds[1] as string]: second.agent,
      }),
      emit: (frame) => frames.push(frame),
      auditStore: { insert: async (row) => void rows.push(row) },
      work,
    });

    const started = await service.post({
      actor: { id: userId, role: "user" },
      actorLabel: `${userId}@example.test`,
      channelId,
      threadId,
      text: "재고랑 주문 둘 다 봐 줘",
      personName: "사장님",
    });
    await until(() => first.asked() + second.asked() === 1, "a member");

    const going = work.of(userId);
    expect(
      going.map(({ kind, agentId, threadId: thread }) => ({
        kind,
        agentId,
        thread,
      })),
    ).toEqual([{ kind: "room", agentId: null, thread: threadId }]);
    // Nobody else's.
    expect(work.of("somebody-else")).toEqual([]);

    expect(await going[0]?.stop()).toBe(true);
    await started.finished;
    expect(work.of(userId)).toEqual([]);

    // The member being asked was cut, and nobody was asked after it.
    expect(first.asked() + second.asked()).toBe(1);

    const done = frames.find((frame) => frame.kind === "room.done");
    expect(done).toMatchObject({ reason: "stopped", failures: 0, posted: 0 });

    const runs = await database
      .select({
        runId: lafThreadRuns.runId,
        status: lafThreadRuns.status,
        agentId: lafThreadRuns.agentId,
      })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.threadId, threadId));
    expect(runs.find((run) => run.runId === started.turnId)?.status).toBe(
      "stopped",
    );
    expect(
      runs.filter((run) => run.agentId !== null).map((run) => run.status),
    ).toEqual(["stopped"]);

    // After a reload, the question has no red line under it.
    expect(await createTurnFailureReader(database)(threadId)).toEqual([]);

    const turn = rows.find((row) => row.eventType === "room.member_turn");
    expect(turn?.payload).toMatchObject({ failed: false, stopped: true });
  });
});
