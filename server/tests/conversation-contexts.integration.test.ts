import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  contextFactsFor,
  contextLayerText,
  systemPromptText,
} from "../../shared/prompt";
import {
  conversationPersistence,
  createConversationStore,
  type PrepareInput,
} from "../src/context/conversations";
import { createDatabase } from "../src/db/client";
import { agents, lafConversationContexts } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * A restart sends the same bytes.
 *
 * An epoch's frozen system message and the reminders a person's messages carried are part of what
 * the provider has cached. If a restart forgot them, the next request would rebuild the prompt
 * from today's facts and send the old messages without their reminders — a history rewritten under
 * the cache, and a Bot that no longer knows which day its person said what. So they are written
 * behind every change and read back whole at boot (`context/conversations.ts`).
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = `ctx-${randomUUID().slice(0, 8)}`;
const createdAgentIds: string[] = [];

// Only what this file made is removed, by id; the rows cascade with their Bot.
afterEach(async () => {
  const ids = createdAgentIds.splice(0);
  if (ids.length > 0) {
    await database.delete(agents).where(inArray(agents.id, ids));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function aBot(): Promise<string> {
  const id = `${suite}-bot-${randomUUID().slice(0, 8)}`;
  await database.insert(agents).values({
    id,
    name: "미소",
    type: "remote_ag_ui",
    configuration: {},
  });
  createdAgentIds.push(id);
  return id;
}

function input(
  botId: string,
  threadId: string,
  messages: PrepareInput["messages"],
  now: Date,
  place = "서울 성동구",
): PrepareInput {
  const facts = contextFactsFor({
    mode: "chat",
    now,
    timeZone: "Asia/Seoul",
    bot: { id: botId, name: "미소" },
    memories: ["택배는 우체국을 쓴다."],
    person: { timeZone: "Asia/Seoul", place },
  });
  return {
    threadId,
    botId,
    mode: "chat",
    messages,
    key: { harness: "h1", model: "m", effort: "balanced", tools: "t1" },
    facts,
    system: (told) => systemPromptText("chat", contextLayerText(told)),
    now,
  };
}

const user = (id: string, content: string) =>
  ({ id, role: "user", content }) as PrepareInput["messages"][number];

describe("a conversation's epoch and reminders outlive the process", () => {
  test("read back at boot, the next request is the same bytes as before the restart", async () => {
    const botId = await aBot();
    const threadId = `${suite}-thread-${randomUUID().slice(0, 8)}`;
    const thursday = new Date("2026-09-24T01:00:00Z");
    const friday = new Date("2026-09-25T01:00:00Z");

    const before = createConversationStore({
      persistence: conversationPersistence(database),
    });
    before.prepare(input(botId, threadId, [user("u1", "안녕")], thursday));
    const history = [
      user("u1", "안녕"),
      { id: "a1", role: "assistant", content: "네." } as never,
      user("u2", "오늘 날씨 어때?"),
    ];
    const told = before.prepare(
      input(botId, threadId, history, friday, "부산 해운대구"),
    );
    await before.settled();
    expect(told.messages.at(-1)?.content).toContain("날짜가 바뀌었다");
    expect(told.messages.at(-1)?.content).toContain("부산 해운대구");

    // The process restarts.
    const after = createConversationStore({
      persistence: conversationPersistence(database),
    });
    expect(await after.load()).toBeGreaterThanOrEqual(1);
    const again = after.prepare(
      input(botId, threadId, history, friday, "부산 해운대구"),
    );
    expect(again.system).toBe(told.system);
    expect(again.messages).toEqual(told.messages);
    expect(again.epoch.id).toBe(told.epoch.id);
    expect(again.epoch.fresh).toBe(false);
  });

  test("one row per conversation, and it goes with its Bot", async () => {
    const botId = await aBot();
    const threadId = `${suite}-thread-${randomUUID().slice(0, 8)}`;
    const store = createConversationStore({
      persistence: conversationPersistence(database),
    });
    const now = new Date("2026-09-24T01:00:00Z");
    store.prepare(input(botId, threadId, [user("u1", "안녕")], now));
    store.prepare(
      input(
        botId,
        threadId,
        [user("u1", "안녕"), user("u2", "그래")],
        now,
        "부산 해운대구",
      ),
    );
    await store.settled();
    const rows = await database
      .select()
      .from(lafConversationContexts)
      .where(eq(lafConversationContexts.threadId, threadId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastUserMessageId).toBe("u2");
    expect(Object.keys(rows[0]?.reminders ?? {})).toEqual(["u2"]);

    await database.delete(agents).where(eq(agents.id, botId));
    const gone = await database
      .select()
      .from(lafConversationContexts)
      .where(eq(lafConversationContexts.threadId, threadId));
    expect(gone).toHaveLength(0);
  });

  test("a routine run is not written — it lasts minutes and is a conversation of its own", async () => {
    const botId = await aBot();
    const threadId = `${suite}-routine-${randomUUID().slice(0, 8)}`;
    const store = createConversationStore({
      persistence: conversationPersistence(database),
    });
    store.prepare({
      ...input(botId, threadId, [user("i1", "주문 확인")], new Date()),
      mode: "routine",
      routine: { scheduledFor: null },
    });
    await store.settled();
    const rows = await database
      .select()
      .from(lafConversationContexts)
      .where(eq(lafConversationContexts.threadId, threadId));
    expect(rows).toHaveLength(0);
  });
});
