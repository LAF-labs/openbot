import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { SQL } from "bun";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import type { Database } from "../src/db/client";
import * as schema from "../src/db/schema";
import { lafThreadMessages } from "../src/db/schema";
import { appendMessages, THREAD_READ_WINDOW } from "../src/runner/thread-store";

/**
 * THE SERVER'S HALF OF "ENOUGH" (performance audit 2026-09-25, §8): a turn forwarded to the Bot in
 * under 300 ms with a 500-message conversation behind it.
 *
 * What grew with the conversation was the store. Every run hands the whole history back, and
 * `appendMessages` ran twice a turn — as the run began and as it finished — reading the newest 500
 * rows under the thread's lock, parsing them, and stamping, attributing and canonically comparing
 * every message it was handed: 0.9–1.8 s between the request arriving and the Bot being asked, on
 * the audit's measurement, and ~3 s of a one-core VM's CPU per turn. The append is now bounded by
 * its window, not by the conversation.
 *
 * Counted rather than timed, so this is the same answer on a loaded laptop and on CI: the rows each
 * statement hands back (re-run and counted, as `thread-read-window.integration.test.ts` does), the
 * statements a turn sends, and the rows it rewrites. The app's half is `app/tests/perf-budget.test.tsx`.
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

const LENGTH = 500;
const BOT = "agent_perf_budget";
const THREAD = `perf-budget-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database
    .delete(lafThreadMessages)
    .where(eq(lafThreadMessages.threadId, THREAD));
  await client.close();
});

/**
 * A long conversation as the client hands it back: questions, answers, and browsing steps whose
 * calls and results are most of the bytes — without the stamps, which only the store carries.
 */
function history(): Message[] {
  const messages: Message[] = [];
  for (let turn = 0; messages.length < LENGTH; turn += 1) {
    messages.push({ id: `u-${turn}`, role: "user", content: `질문 ${turn}` });
    if (turn % 3 === 0) {
      messages.push({
        id: `c-${turn}`,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: `call-${turn}`,
            type: "function",
            function: {
              name: "computer_read",
              arguments: JSON.stringify({ tab: 0 }),
            },
          },
        ],
      });
      messages.push({
        id: `t-${turn}`,
        role: "tool",
        toolCallId: `call-${turn}`,
        content: JSON.stringify({ ok: true, text: "주문 목록\n".repeat(60) }),
      });
    }
    messages.push({
      id: `a-${turn}`,
      role: "assistant",
      content: `### 정리 ${turn}\n\n- 매출이 늘었어요.\n- 단골손님께 안내를 보내 보세요.`,
    });
  }
  return messages.slice(0, LENGTH);
}

/** Every statement since `mark` that touches the thread table, with the rows each select returns. */
async function statementsSince(mark: number) {
  const touching = sent
    .slice(mark)
    .filter(({ query }) => query.includes("laf_thread_messages"));
  let mostRowsRead = 0;
  for (const { query, params } of touching) {
    if (!/^\s*select/i.test(query)) continue;
    const rows = (await client.unsafe(query, params as never[])) as unknown[];
    mostRowsRead = Math.max(mostRowsRead, rows.length);
  }
  return {
    statements: sent.length - mark,
    mostRowsRead,
    updates: touching.filter(({ query }) => /^\s*update/i.test(query)).length,
    inserts: touching.filter(({ query }) => /^\s*insert/i.test(query)).length,
  };
}

describe("one turn over a 500-message conversation", () => {
  test("reads a bounded tail and rewrites nothing, at the start of the run and at its end", async () => {
    const said = history();
    // Stored the way a conversation grows: the store stamps each message as it first sees it.
    for (let at = 0; at < said.length; at += 100) {
      await appendMessages(database, THREAD, said.slice(0, at + 100));
    }

    const question: Message = { id: "u-now", role: "user", content: "오늘은?" };
    const answer = {
      id: "a-now",
      role: "assistant",
      content: "오늘 매출은 어제보다 12% 많아요.",
      lafAgentId: BOT,
    } as Message;

    // `beginRun`: the whole history back, and the question.
    const begin = sent.length;
    await appendMessages(database, THREAD, [...said, question]);
    const started = await statementsSince(begin);

    // `finishRun`: the same history again, and the answer.
    const finish = sent.length;
    await appendMessages(database, THREAD, [...said, question, answer]);
    const finished = await statementsSince(finish);

    for (const turn of [started, finished]) {
      // Bounded by the window, not by the 500 behind it.
      expect(turn.mostRowsRead).toBeGreaterThan(0);
      expect(turn.mostRowsRead).toBeLessThanOrEqual(THREAD_READ_WINDOW);
      expect(THREAD_READ_WINDOW).toBeLessThanOrEqual(64);
      // The history arrived unchanged, so nothing of it is written again.
      expect(turn.updates).toBe(0);
      expect(turn.inserts).toBe(1);
      // begin, the lock, the tail, the unstored ids, the insert, commit.
      expect(turn.statements).toBeLessThanOrEqual(6);
    }

    const [stored] = await database
      .select({ rows: count() })
      .from(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, THREAD));
    expect(Number(stored?.rows)).toBe(LENGTH + 2);
  }, 60_000);
});
