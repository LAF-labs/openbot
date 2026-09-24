import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent, AgentSubscriber, Message } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
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
import { createRunLedger } from "../src/runner/run-ledger";
import { createMessageMarkReader } from "../src/runner/thread-store";
import { TEST_POOL } from "./support/database";

/**
 * A ROOM TURN LEAVES A RECEIPT, AND A RELOAD FINDS IT.
 *
 * Each member's outcome goes out on the socket as it settles, the whole turn's on `room.done`, and
 * the same outcomes are kept on the person's question — where the transcript's marks route reads
 * them back. Asking one colleague again changes that colleague's outcome and nobody else's, and
 * the question is still one row.
 *
 * Against the real service and the real store, because the promise is three modules agreeing on
 * one id: the question the turn answered.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const prefix = `room-receipts-${randomUUID().slice(0, 8)}`;
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

/** A member that reads the room and ends its turn without a word. */
function quietMember(): AbstractAgent {
  const agent = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(_input: unknown, subscriber: AgentSubscriber) {
      await subscriber.onRunFinishedEvent?.({ event: {} } as never);
      return { result: undefined, newMessages: [] };
    },
  };
  return agent as unknown as AbstractAgent;
}

/** A member whose endpoint is gone. */
function deadMember(): AbstractAgent {
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

/** A member that says one thing, once. */
function speakingMember(text: string): AbstractAgent {
  let turn = 0;
  const agent = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(_input: unknown, subscriber: AgentSubscriber) {
      turn += 1;
      if (turn === 1) {
        agent.messages.push({
          id: `m_${randomUUID()}`,
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: `call_${randomUUID()}`,
              type: "function",
              function: {
                name: "send_message",
                arguments: JSON.stringify({ text }),
              },
            },
          ],
        } as Message);
      }
      await subscriber.onRunFinishedEvent?.({ event: {} } as never);
      return { result: undefined, newMessages: [] };
    },
  };
  return agent as unknown as AbstractAgent;
}

async function makeRoom() {
  const room = randomUUID().slice(0, 8);
  const userId = `${prefix}-${room}-user`;
  await database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "Room Receipts Test User",
  });
  made.users.push(userId);

  const memberIds = [`${prefix}-${room}-stock`, `${prefix}-${room}-review`];
  await database.insert(agents).values(
    memberIds.map((id, index) => ({
      id,
      name: index === 0 ? "재고봇" : "리뷰봇",
      type: "remote_ag_ui" as const,
      configuration: {},
    })),
  );
  made.agents.push(...memberIds);

  const channelId = `channel_${prefix}-${room}`;
  const threadId = randomUUID();
  await database.insert(channels).values({
    id: channelId,
    name: "재고봇, 리뷰봇",
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

describe("a room turn's receipt", () => {
  test("goes out as each member settles, closes the turn, is kept on the question, and survives asking one colleague again", async () => {
    const { userId, memberIds, channelId, threadId } = await makeRoom();
    const [stock, review] = memberIds as [string, string];
    const frames: RoomFrame[] = [];
    let cast: Record<string, AbstractAgent> = {
      [stock]: quietMember(),
      [review]: deadMember(),
    };
    const service = createRoomService({
      database,
      lane: createBotLane(),
      ledger: createRunLedger(database),
      resolveAgents: async () => cast,
      emit: (frame) => frames.push(frame),
    });
    const actor = { id: userId, role: "user" as const };

    const first = await service.post({
      actor,
      actorLabel: `${userId}@example.test`,
      channelId,
      threadId,
      text: "우유 발주 언제 하면 돼?",
      personName: "사장님",
    });
    await first.finished;

    // Each member, the moment its turn ended — which is what lets its face settle into the receipt.
    const settled = frames.filter((frame) => frame.kind === "room.settled");
    expect(
      Object.fromEntries(
        settled.map((frame) =>
          frame.kind === "room.settled" ? [frame.memberId, frame.outcome] : [],
        ),
      ),
    ).toEqual({ [stock]: "passed", [review]: "failed" });
    for (const frame of settled) {
      expect(frame).toMatchObject({ turnId: first.turnId, epoch: first.epoch });
    }

    // The whole turn, member by member, keyed to the question it answered.
    const done = frames.find((frame) => frame.kind === "room.done");
    expect(done).toMatchObject({
      questionId: first.messageId,
      posted: 0,
      failures: 1,
    });
    expect(
      done?.kind === "room.done"
        ? Object.fromEntries(
            (done.members ?? []).map((entry) => [entry.id, entry.outcome]),
          )
        : null,
    ).toEqual({ [stock]: "passed", [review]: "failed" });

    // After a reload: the marks route reads the same outcomes off the question's own row.
    const marks = createMessageMarkReader(database);
    expect((await marks(threadId)).receipts).toEqual({
      [first.messageId]: { [stock]: "passed", [review]: "failed" },
    });

    // 다시 묻기: the same question, under its own id, naming only the colleague that could not answer.
    cast = {
      [stock]: quietMember(),
      [review]: speakingMember("모레 오전이요."),
    };
    frames.length = 0;
    const again = await service.post({
      actor,
      actorLabel: `${userId}@example.test`,
      channelId,
      threadId,
      text: "우유 발주 언제 하면 돼?",
      messageId: first.messageId,
      addressedAgentIds: [review],
      personName: "사장님",
    });
    await again.finished;

    expect(
      frames
        .filter((frame) => frame.kind === "room.settled")
        .map((frame) => (frame.kind === "room.settled" ? frame.memberId : "")),
    ).toEqual([review]);
    // Only the one asked again changed; the colleague that had read it and stayed quiet still has.
    expect((await marks(threadId)).receipts).toEqual({
      [first.messageId]: { [stock]: "passed", [review]: "spoke" },
    });

    // And the question was asked again, not said twice — its words untouched by what was kept on it.
    const rows = await database
      .select({ message: lafThreadMessages.message })
      .from(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
    const asked = rows
      .map((row) => row.message as { role?: string; content?: unknown })
      .filter((message) => message.role === "user");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.content).toBe("우유 발주 언제 하면 돼?");
  });

  test("a turn stopped before anybody was asked keeps nothing", async () => {
    const { userId, memberIds, channelId, threadId } = await makeRoom();
    const frames: RoomFrame[] = [];
    let release: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createRoomService({
      database,
      lane: createBotLane(),
      // Held until the stop has landed, so no member can be reached before it.
      resolveAgents: async () => {
        await stopped;
        return Object.fromEntries(memberIds.map((id) => [id, quietMember()]));
      },
      emit: (frame) => frames.push(frame),
    });
    const started = await service.post({
      actor: { id: userId, role: "user" },
      actorLabel: `${userId}@example.test`,
      channelId,
      threadId,
      text: "아무것도 아니에요",
      personName: "사장님",
    });
    await service.stop({ id: userId }, channelId);
    release();
    await started.finished;

    const done = frames.find((frame) => frame.kind === "room.done");
    expect(done).toMatchObject({ reason: "superseded", members: [] });
    expect(
      (await createMessageMarkReader(database)(threadId)).receipts,
    ).toEqual({});
  });
});
