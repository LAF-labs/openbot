import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { SQL } from "bun";
import { count, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import type { Database } from "../src/db/client";
import * as schema from "../src/db/schema";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
  lafThreadMessages,
  users,
} from "../src/db/schema";
import { appendMessages, THREAD_READ_WINDOW } from "../src/runner/thread-store";

/**
 * What one turn reads out of a long conversation, measured in rows Postgres hands back.
 *
 * Audit A5-2 (2026-09-10): the append read the WHOLE thread under its lock twice a turn, and a
 * room member read the whole of its private conversation to keep twelve lines — while a thread is
 * one person and one Bot for good, growing by an estimated 7,500 rows and 10–30 MB a month. Six
 * months in, every message a Bot answered re-read and re-parsed tens of thousands of rows.
 *
 * So this seeds a thread of 5,000 messages, has each per-turn reader do its work over it — the
 * append given the whole history back plus one new message, the way every run's input arrives —
 * and re-runs every statement it sent against `laf_thread_messages` to count what came back. Every
 * one of them is bounded by its window, not by the length of the conversation; the transcript
 * itself is still all there.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const client = new SQL(databaseUrl, { max: 2 });
const sent: Array<{ query: string; params: unknown[] }> = [];
const database = drizzle({
  client,
  schema,
  logger: {
    logQuery: (query, params) => {
      sent.push({ query, params });
    },
  },
}) as unknown as Database;

const LENGTH = 5_000;
const run = randomUUID().slice(0, 8);
const PERSON = `window-${run}`;
const BOT = `agent_window_${run}`;
const CHANNEL = `channel_window_${run}`;
const THREAD = `window-thread-${run}`;

afterAll(async () => {
  await database
    .delete(lafThreadMessages)
    .where(eq(lafThreadMessages.threadId, THREAD));
  await database.delete(channels).where(eq(channels.id, CHANNEL));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.delete(users).where(eq(users.id, PERSON));
  await client.close();
});

/** A long conversation between one person and one Bot, as the store holds it. */
async function longConversation(): Promise<Message[]> {
  await database
    .insert(users)
    .values({ id: PERSON, email: `${PERSON}@laf.test`, name: "Window" });
  await database
    .insert(agents)
    .values({ id: BOT, name: "Bot", type: "remote_ag_ui", configuration: {} });
  await database
    .insert(channels)
    .values({ id: CHANNEL, name: "Bot", description: "solo" });
  await database
    .insert(channelMemberships)
    .values({ channelId: CHANNEL, userId: PERSON });
  await database
    .insert(channelAgents)
    .values({ channelId: CHANNEL, agentId: BOT });
  await database
    .insert(channelThreads)
    .values({ channelId: CHANNEL, userId: PERSON, threadId: THREAD });

  const history: Message[] = [];
  for (let seq = 1; seq <= LENGTH; seq += 1) {
    history.push(
      seq % 2 === 1
        ? { id: `said-${seq}`, role: "user", content: `질문 ${seq}` }
        : ({
            id: `said-${seq}`,
            role: "assistant",
            content: `답 ${seq}: ${"재고 현황 ".repeat(20)}`,
            lafAgentId: BOT,
          } as Message),
    );
  }
  for (let start = 0; start < LENGTH; start += 1_000) {
    await database.insert(lafThreadMessages).values(
      history.slice(start, start + 1_000).map((message, offset) => ({
        threadId: THREAD,
        seq: start + offset + 1,
        message: message as unknown as Record<string, unknown>,
      })),
    );
  }
  return history;
}

/** The most rows any statement sent to `laf_thread_messages` since `mark` hands back, re-run. */
async function mostRowsReadSince(mark: number): Promise<number> {
  let most = 0;
  for (const { query, params } of sent.slice(mark)) {
    if (!/^\s*select/i.test(query) || !query.includes("laf_thread_messages")) {
      continue;
    }
    const rows = (await client.unsafe(query, params as never[])) as unknown[];
    most = Math.max(most, rows.length);
  }
  return most;
}

describe("a turn over a long conversation", () => {
  test("reads a window of it, and still stores the new message exactly once", async () => {
    const history = await longConversation();

    const mark = sent.length;
    const fresh: Message = {
      id: `said-${LENGTH + 1}`,
      role: "user",
      content: "오늘은?",
    };
    await appendMessages(database, THREAD, [...history, fresh]);

    const read = await mostRowsReadSince(mark);
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThanOrEqual(THREAD_READ_WINDOW);

    // Nothing of the 5,000 was written again, and the one new message took the next place.
    const [stored] = await database
      .select({ rows: count() })
      .from(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, THREAD));
    expect(Number(stored?.rows)).toBe(LENGTH + 1);
    const [last] = await database
      .select({ seq: lafThreadMessages.seq })
      .from(lafThreadMessages)
      .where(inArray(lafThreadMessages.threadId, [THREAD]))
      .orderBy(schema.lafThreadMessages.seq)
      .limit(1)
      .offset(LENGTH);
    expect(last?.seq).toBe(LENGTH + 1);
  }, 60_000);
});
