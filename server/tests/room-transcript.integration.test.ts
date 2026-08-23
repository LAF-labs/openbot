import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, channels, lafThreadSnapshots } from "../src/db/schema";
import {
  appendRoomMessage,
  readRoomLines,
  type StoredMessage,
} from "../src/rooms/transcript";
import { TEST_POOL } from "./support/database";

/**
 * What a room's transcript promises: several Bots write into one thread without losing each
 * other's messages, and only what somebody actually SAID comes back out.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const made: { agents: string[]; channels: string[]; threads: string[] } = {
  agents: [],
  channels: [],
  threads: [],
};

/*
 * The two members whose messages this file appends. `channels.last_message_agent_id` is a real
 * foreign key onto `agents`, so an append under an id no `agents` row carries fails on the
 * reference instead of exercising what the test is about. On a development machine the rows exist
 * because the app seeded them; on a clean database — CI's, a fresh checkout's — nothing has, which
 * is how this suite came to pass only on the machine it was written on. Create what is missing,
 * remember only what this file created, and delete only that: the app's own rows are not this
 * suite's to remove.
 */
beforeAll(async () => {
  for (const [id, name] of names) {
    const created = await database
      .insert(agents)
      .values({ id, name, type: "remote_ag_ui", configuration: {} })
      .onConflictDoNothing()
      .returning({ id: agents.id });
    if (created.length > 0) made.agents.push(id);
  }
});

afterAll(async () => {
  if (made.agents.length > 0) {
    await database.delete(agents).where(inArray(agents.id, made.agents));
  }
});

// Only this file's rows: the suite runs against whatever DATABASE_URL names, which on a
// development machine is the database the app is using.
afterEach(async () => {
  if (made.threads.length > 0) {
    await database
      .delete(lafThreadSnapshots)
      .where(inArray(lafThreadSnapshots.threadId, made.threads));
  }
  if (made.channels.length > 0) {
    await database.delete(channels).where(inArray(channels.id, made.channels));
  }
  made.threads = [];
  made.channels = [];
});

async function makeRoom() {
  const channelId = `channel_room-test-${randomUUID()}`;
  const threadId = randomUUID();
  made.channels.push(channelId);
  made.threads.push(threadId);
  await database.insert(channels).values({
    id: channelId,
    name: "리스크 분석가, 일상 비서",
    description: "Private agent channel.",
  });
  return { channelId, threadId };
}

const names = new Map([
  ["risk-analyst", "리스크 분석가"],
  ["general-assistant", "일상 비서"],
]);

describe("writing into a room", () => {
  test("two Bots appending at once keep both messages", async () => {
    const { channelId, threadId } = await makeRoom();

    /*
     * The reason the append is `jsonb || jsonb` and not read-modify-write. Both of these read the
     * same row before either writes; with a read-modify-write the second would erase the first,
     * and in a room that is one colleague's sentence disappearing from the conversation.
     */
    await Promise.all([
      appendRoomMessage(database, {
        channelId,
        threadId,
        agentId: "risk-analyst",
        text: "규정상 문제 없습니다",
      }),
      appendRoomMessage(database, {
        channelId,
        threadId,
        agentId: "general-assistant",
        text: "일정도 맞출 수 있어요",
      }),
    ]);

    const lines = await readRoomLines(database, threadId, names, "김기범");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.agentId).sort()).toEqual([
      "general-assistant",
      "risk-analyst",
    ]);
  });

  test("a person's message carries no Bot, which is what keeps the room read", async () => {
    const { channelId, threadId } = await makeRoom();
    await appendRoomMessage(database, {
      channelId,
      threadId,
      agentId: null,
      text: "다음 주 출시 괜찮을까요?",
    });

    const [row] = await database
      .select({ agentId: channels.lastMessageAgentId })
      .from(channels)
      .where(eq(channels.id, channelId));
    expect(row?.agentId).toBeNull();

    const lines = await readRoomLines(database, threadId, names, "김기범");
    expect(lines[0]).toEqual({
      agentId: null,
      name: "김기범",
      text: "다음 주 출시 괜찮을까요?",
    });
  });

  test("the caller's own message id is what gets stored", async () => {
    const { channelId, threadId } = await makeRoom();
    const messageId = randomUUID();
    const written = await appendRoomMessage(database, {
      channelId,
      threadId,
      agentId: null,
      text: "안녕하세요",
      messageId,
    });
    expect(written?.messageId).toBe(messageId);

    const [row] = await database
      .select({ messages: lafThreadSnapshots.messages })
      .from(lafThreadSnapshots)
      .where(eq(lafThreadSnapshots.threadId, threadId));
    const stored = (row?.messages ?? []) as StoredMessage[];
    expect(stored[0]?.id).toBe(messageId);
  });
});

describe("reading a room back", () => {
  test("private working is not the room's conversation", async () => {
    const { threadId } = await makeRoom();
    /*
     * A member's tool calls, their results and its system turn are how it did the work, not what it
     * said — the room only ever shows what a `send_message` put in it.
     */
    await database.insert(lafThreadSnapshots).values({
      threadId,
      agentId: "risk-analyst",
      messages: [
        { id: "s", role: "system", content: "room conduct" },
        { id: "u", role: "user", content: "확인해주세요" },
        { id: "scratch", role: "assistant", content: "먼저 페이지를 열어보자" },
        { id: "t", role: "tool", toolCallId: "c1", content: "{}" },
        {
          id: "said",
          role: "assistant",
          content: "확인했습니다",
          lafAgentId: "risk-analyst",
        },
      ] as never,
    });

    const lines = await readRoomLines(database, threadId, names, "김기범");
    expect(lines.map((line) => line.text)).toEqual([
      "확인해주세요",
      "확인했습니다",
    ]);
    // The unattributed assistant message is scratch space, not somebody's words.
    expect(lines.some((line) => line.text === "먼저 페이지를 열어보자")).toBe(
      false,
    );
  });

  test("a thread nobody has written to is an empty room, not an error", async () => {
    const { threadId } = await makeRoom();
    expect(await readRoomLines(database, threadId, names, "김기범")).toEqual(
      [],
    );
  });
});
