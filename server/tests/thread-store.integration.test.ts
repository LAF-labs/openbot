/**
 * The two properties the one conversation store exists for.
 *
 * FIRST: nothing is lost when two writers land on the same thread at once. That was the bug in the
 * shape this replaced — the runner rewrote the whole message array from its own in-memory mirror,
 * so a routine's delivery or a room message that arrived between the runner's read and its write
 * was simply overwritten. It could not be caught by a unit test because it needs two real
 * transactions racing over one row.
 *
 * SECOND: booting does not read anybody's conversation. Construction used to `select *` from every
 * thread in the deployment, so the cost of starting the server grew with the history of the product.
 * The counting wrapper below is the measurement rather than an inspection of the code.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channels,
  channelThreads,
  lafThreadMessages,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import { LafPostgresRunner } from "../src/runner/laf-runner";
import { createRunLedger } from "../src/runner/run-ledger";
import {
  appendMessages,
  messagesFor,
  type StoredMessage,
} from "../src/runner/thread-store";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

const threads: string[] = [];
/** The people and channels `ownedThread` made, so the cleanup takes back exactly those. */
const owners: { userId: string; channelId: string }[] = [];
const said = (id: string, by?: string) =>
  ({
    id,
    role: by ? "assistant" : "user",
    content: id,
    ...(by ? { lafAgentId: by } : {}),
  }) as unknown as StoredMessage;

afterEach(async () => {
  const mine = threads.splice(0);
  if (mine.length > 0) {
    await database
      .delete(lafThreadMessages)
      .where(inArray(lafThreadMessages.threadId, mine));
  }
  const made = owners.splice(0);
  if (made.length > 0) {
    // `channel_threads` cascades from both sides; the users and channels are what this file made.
    await database.delete(channels).where(
      inArray(
        channels.id,
        made.map((row) => row.channelId),
      ),
    );
    await database.delete(users).where(
      inArray(
        users.id,
        made.map((row) => row.userId),
      ),
    );
  }
});

afterAll(async () => {
  await database.$client.close();
});

function thread() {
  const id = `thread-store-${randomUUID()}`;
  threads.push(id);
  return id;
}

/**
 * Give a thread the person it belongs to, and hand back their id.
 *
 * A thread read is scoped to its owner (`runner/thread-store.ts`), and the row that records one is
 * written when the channel is made — so a test thread with no channel behind it is a thread the
 * reads correctly refuse.
 */
async function ownedThread(threadId: string): Promise<string> {
  const userId = `thread-store-user-${randomUUID()}`;
  const channelId = `thread-store-channel-${randomUUID()}`;
  owners.push({ userId, channelId });
  await database
    .insert(users)
    .values({ id: userId, email: `${userId}@laf.test`, name: "Store" });
  await database
    .insert(channels)
    .values({ id: channelId, name: "Store", description: "store" });
  await database.insert(channelThreads).values({ userId, channelId, threadId });
  return userId;
}

describe("appending to a thread", () => {
  test("two writers landing at the same instant lose nothing", async () => {
    const threadId = thread();
    /*
     * A routine delivering its answer while the person is mid-turn with the same Bot. Both of these
     * open their own transaction and both read the thread before either commits; the per-thread
     * advisory lock is what makes one of them wait rather than claim the other's `seq`.
     */
    await Promise.all([
      appendMessages(database, threadId, [said("delivery", "bot-a")]),
      appendMessages(database, threadId, [said("live-turn")]),
    ]);

    const stored = await messagesFor(database, threadId);
    expect(stored.map((message) => message.id).sort()).toEqual([
      "delivery",
      "live-turn",
    ]);
    // And each has a place of its own: two rows claiming one `seq` is what the lock prevents.
    const rows = await database
      .select({ seq: lafThreadMessages.seq })
      .from(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
    expect(new Set(rows.map((row) => row.seq)).size).toBe(2);
  });

  test("many writers at once keep every message and every position", async () => {
    const threadId = thread();
    const many = 12;
    await Promise.all(
      Array.from({ length: many }, (_, at) =>
        appendMessages(database, threadId, [said(`m${at}`)]),
      ),
    );
    const rows = await database
      .select({ seq: lafThreadMessages.seq })
      .from(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
    expect(rows).toHaveLength(many);
    expect(new Set(rows.map((row) => row.seq)).size).toBe(many);
  });

  test("one batch naming a message twice writes it once", async () => {
    /*
     * The runner's own end-of-run write is exactly this: the caller's history, which already holds
     * the assistant's reply, followed by the copy the run just rebuilt from its text events. Two
     * rows for one id is a reply drawn twice, and the unique index would refuse the insert outright.
     */
    const threadId = thread();
    await appendMessages(database, threadId, [
      said("u1"),
      said("a1"),
      {
        ...said("a1"),
        content: "the rebuilt copy",
      } as unknown as StoredMessage,
    ]);
    const stored = await messagesFor(database, threadId);
    expect(stored.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect((stored[1] as unknown as { content: string }).content).toBe(
      "the rebuilt copy",
    );
  });

  test("the same message arriving again is not a second message", async () => {
    // Every run hands the whole history back as its input, so this is the common case, not an edge.
    const threadId = thread();
    await appendMessages(database, threadId, [said("u1"), said("a1", "bot-a")]);
    await appendMessages(database, threadId, [
      said("u1"),
      said("a1", "bot-a"),
      said("u2"),
    ]);
    expect((await messagesFor(database, threadId)).map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "u2",
    ]);
  });

  test("a richer copy of a message updates its row and keeps its place", async () => {
    /*
     * The case the runner depends on: an assistant turn is stored from its text events without the
     * tool calls it also made, and those only arrive with the NEXT run's input under the same id.
     * Appending it again as a new message would put the reply twice in the transcript; refusing it
     * outright would lose the tool calls, and the provider then rejects the following turn because
     * a `tool` message has no call to answer.
     */
    const threadId = thread();
    await appendMessages(database, threadId, [said("a1", "bot-a")]);
    await appendMessages(database, threadId, [
      {
        ...said("a1"),
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "computer_open", arguments: "{}" },
          },
        ],
      } as unknown as StoredMessage,
    ]);

    const stored = await messagesFor(database, threadId);
    expect(stored).toHaveLength(1);
    expect(
      (stored[0] as unknown as { toolCalls?: unknown[] }).toolCalls,
    ).toHaveLength(1);
    // The speaker recorded the first time survives an input that arrived stripped.
    expect(stored[0]?.lafAgentId).toBe("bot-a");
  });

  test("a message stored before stamping existed is not given an invented time", async () => {
    const threadId = thread();
    await database.insert(lafThreadMessages).values({
      threadId,
      seq: 1,
      message: { id: "old", role: "user", content: "no stamp" },
      at: new Date("2026-01-01T00:00:00Z"),
    });
    await appendMessages(database, threadId, [said("old"), said("new")]);

    const stored = await messagesFor(database, threadId);
    expect(stored[0]?.lafAt).toBeUndefined();
    expect(stored[1]?.lafAt).toBeDefined();
  });

  test("a row that arrived double-encoded is re-parsed, not read as nothing", async () => {
    // The trap `db/json.ts` documents, from the reading side: a jsonb STRING holding the JSON.
    const threadId = thread();
    await database.execute(
      sql`insert into laf_thread_messages (thread_id, seq, message, at)
          values (${threadId}, 1, to_jsonb(${JSON.stringify({ id: "d1", role: "user", content: "오래된 대화" })}::text), now())`,
    );
    const stored = await messagesFor(database, threadId);
    expect(stored.map((message) => message.id)).toEqual(["d1"]);
  });
});

describe("what booting reads", () => {
  test("construction does not read a single thread's messages", async () => {
    const threadId = thread();
    // The thread needs an owner now: `prime` refuses one that belongs to nobody, so a thread with
    // no `channel_threads` row would never reach the message read this test is measuring.
    const owner = await ownedThread(threadId);
    await appendMessages(database, threadId, [said("u1")]);

    /*
     * Counted rather than inspected. A wrapper over the one method the store reads through, so a
     * future boot that quietly starts loading conversations again fails here instead of being
     * noticed on the day somebody's deployment takes a minute to start.
     */
    const touched: string[] = [];
    const counting = new Proxy(database, {
      get(target, key, receiver) {
        if (key === "select") {
          return (...args: unknown[]) => {
            const builder = (
              target.select as (...rest: unknown[]) => {
                from: (table: unknown) => unknown;
              }
            )(...args);
            return new Proxy(builder, {
              get(inner, innerKey, innerReceiver) {
                if (innerKey === "from") {
                  return (table: unknown) => {
                    if (table === lafThreadMessages) {
                      touched.push("laf_thread_messages");
                    }
                    return inner.from(table);
                  };
                }
                return Reflect.get(inner, innerKey, innerReceiver);
              },
            });
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });

    const runner = await LafPostgresRunner.create(
      counting,
      createRunLedger(database),
    );
    expect(touched).toEqual([]);

    // And the read happens when a request asks for it, which is the other half of the same claim.
    await runner.prime(threadId, owner);
    expect(touched).toEqual(["laf_thread_messages"]);
    expect(runner.getThreadMessages(threadId).map((m) => m.id)).toEqual(["u1"]);
  });
});

describe("the run ledger's one writer", () => {
  test("a chat turn's run keeps the id the events carry", async () => {
    const ledger = createRunLedger(database);
    const runId = `run-${randomUUID()}`;
    await database
      .insert(agents)
      .values({
        id: "thread-store-bot",
        name: "Store",
        type: "remote_ag_ui",
        configuration: {},
      })
      .onConflictDoNothing();
    await ledger.begin({
      runId,
      agentId: "thread-store-bot",
      userId: null,
      threadId: thread(),
      origin: "chat",
    });
    await ledger.settle(runId, {
      status: "stopped",
      error: null,
      eventCount: 7,
    });

    const [row] = await database
      .select()
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, runId));
    // `stopped` and the event count both used to exist only on the path the runner wrote itself.
    expect(row?.status).toBe("stopped");
    expect(row?.eventCount).toBe(7);
    expect(row?.finishedAt).not.toBeNull();

    await database.delete(lafThreadRuns).where(eq(lafThreadRuns.runId, runId));
    await database.delete(agents).where(eq(agents.id, "thread-store-bot"));
  });
});
