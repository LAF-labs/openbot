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

  test("a day's cut and its summary are written with the epoch and read back whole", async () => {
    const botId = await aBot();
    const threadId = `${suite}-thread-${randomUUID().slice(0, 8)}`;
    const thursday = new Date("2026-09-24T01:00:00Z");
    const friday = new Date("2026-09-25T01:00:00Z");
    const stamped = (
      id: string,
      role: "user" | "assistant",
      content: string,
      at: Date,
    ) => ({ id, role, content, lafAt: at.toISOString() }) as never;
    const thread = [
      stamped("u1", "user", "한빛농산 유자 40박스 온대", thursday),
      stamped("a1", "assistant", "알겠습니다. ".repeat(2_000), thursday),
    ];
    let clock = thursday.getTime();
    const before = createConversationStore({
      persistence: conversationPersistence(database),
      now: () => clock,
      days: {
        summarize: async () => "- 9/24: 한빛농산 유자 40박스",
        history: async () => thread,
      },
    });
    const bare = (message: Record<string, unknown>) => {
      const { lafAt: _stamp, ...rest } = message;
      return rest as never;
    };
    before.prepare(input(botId, threadId, thread.map(bare), thursday));
    clock = friday.getTime() - 3 * 60 * 60_000;
    expect(await before.tick()).toBe(1);
    const morningThread = [...thread.map(bare), user("u2", "좋은 아침")];
    clock = friday.getTime();
    const morning = before.prepare(
      input(botId, threadId, morningThread, friday),
    );
    await before.settled();
    expect(morning.epoch.reason).toBe("day_boundary");
    expect(morning.messages.map((message) => message.id)).toEqual(["u2"]);

    const [row] = await database
      .select({ epoch: lafConversationContexts.epoch })
      .from(lafConversationContexts)
      .where(eq(lafConversationContexts.threadId, threadId));
    const stored = row?.epoch as { cut?: { through?: string } } | undefined;
    expect(stored?.cut?.through).toBe("a1");

    // The process restarts.
    const after = createConversationStore({
      persistence: conversationPersistence(database),
    });
    await after.load();
    const again = after.prepare(input(botId, threadId, morningThread, friday));
    expect(again.system).toBe(morning.system);
    expect(again.system).toContain("한빛농산 유자 40박스");
    expect(again.messages).toEqual(morning.messages);
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
