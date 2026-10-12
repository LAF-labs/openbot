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
  lafThreadMessages,
  lafThreadRuns,
} from "../src/db/schema";
import { REMOVED_PROJECT_RESULT } from "../../shared/tools/projects";
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
});

afterAll(async () => {
  await database.$client.close();
});

function thread() {
  const id = `thread-store-${randomUUID()}`;
  threads.push(id);
  return id;
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

  test("a first move's mark survives a copy that arrived without it", async () => {
    /*
     * The window's run hands the whole history back through CopilotKit's message schemas, which
     * strip every key they do not know: written as it arrived, the move would read as a call the
     * Bot made, and a move put right as two places asked about (`keepFirstMoves`).
     */
    const threadId = thread();
    await appendMessages(database, threadId, [
      { ...said("a1", "bot-a"), lafFirstMove: true } as StoredMessage,
    ]);
    await appendMessages(database, threadId, [
      {
        id: "a1",
        role: "assistant",
        content: "the window's copy",
      } as unknown as StoredMessage,
      said("a2", "bot-a"),
    ]);

    const stored = await messagesFor(database, threadId);
    expect(
      stored.map((message) => [
        message.id,
        (message as { content?: unknown }).content,
        message.lafFirstMove,
      ]),
    ).toEqual([
      ["a1", "the window's copy", true],
      ["a2", "a2", undefined],
    ]);
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

describe("a tool result that read a project", () => {
  const made: string[] = [];
  const project = async (deleting = false) => {
    const id = `thread-store-project-${randomUUID()}`;
    made.push(id);
    await database.insert(channels).values({
      id,
      name: "여행 계획",
      description: "",
      kind: "project",
      ...(deleting ? { deletingAt: new Date() } : {}),
    });
    return id;
  };
  const result = (id: string, read: string[] | undefined, content: string) =>
    ({
      id,
      role: "tool",
      toolCallId: `call-${id}`,
      content,
      ...(read ? { lafProjects: read } : {}),
    }) as unknown as StoredMessage;
  const stored = async (threadId: string, id: string) =>
    (await messagesFor(database, threadId)).find(
      (message) => message.id === id,
    );

  afterEach(async () => {
    const mine = made.splice(0);
    if (mine.length > 0) {
      await database.delete(channels).where(inArray(channels.id, mine));
    }
  });

  test("is kept as it arrived while every project it read is there", async () => {
    const threadId = thread();
    const live = await project();
    await appendMessages(database, threadId, [
      result("read-live", [live], "제주 3박 4일, 숙소는 애월"),
    ]);
    expect(await stored(threadId, "read-live")).toMatchObject({
      content: "제주 3박 4일, 숙소는 애월",
      lafProjects: [live],
    });
  });

  test("is stored as the fixed sentence when a project it read is gone, being deleted, or one of several is", async () => {
    const threadId = thread();
    const live = await project();
    const leaving = await project(true);
    const gone = `thread-store-project-${randomUUID()}`;
    await appendMessages(database, threadId, [
      result("read-gone", [gone], "지운 프로젝트의 말"),
      result("read-leaving", [leaving], "지우는 중인 프로젝트의 말"),
      result("read-both", [live, gone], "둘을 읽은 검색 결과"),
      result("read-live", [live], "남아 있는 프로젝트의 말"),
    ]);
    for (const id of ["read-gone", "read-leaving", "read-both"]) {
      const kept = await stored(threadId, id);
      expect(kept?.content).toBe(REMOVED_PROJECT_RESULT);
      // The call and its answer stay a pair, and the row still says what it had read.
      expect(kept).toMatchObject({ role: "tool", toolCallId: `call-${id}` });
    }
    expect((await stored(threadId, "read-both"))?.lafProjects).toEqual([
      live,
      gone,
    ]);
    expect((await stored(threadId, "read-live"))?.content).toBe(
      "남아 있는 프로젝트의 말",
    );
    // Nothing of the project is in the thread's rows, in any column.
    const rows = await database
      .select()
      .from(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
    expect(JSON.stringify(rows)).not.toContain("지운 프로젝트의 말");
    expect(JSON.stringify(rows)).not.toContain("지우는 중인");
    expect(JSON.stringify(rows)).not.toContain("둘을 읽은");
  });

  test("a covered row is not uncovered by the turn's own copy arriving again, with the mark or without it", async () => {
    const threadId = thread();
    const one = await project();
    await appendMessages(database, threadId, [
      result("read-one", [one], "프로젝트에서 읽은 말"),
    ]);
    // The deletion's work, as its transaction leaves it: the project gone, the row covered.
    await database.delete(channels).where(eq(channels.id, one));
    await database
      .update(lafThreadMessages)
      .set({
        message: sql`jsonb_set(${lafThreadMessages.message}, '{content}', to_jsonb(${REMOVED_PROJECT_RESULT}::text))`,
      })
      .where(eq(lafThreadMessages.threadId, threadId));

    // The turn that made the call is still running and writes its messages again.
    await appendMessages(database, threadId, [
      result("read-one", [one], "프로젝트에서 읽은 말"),
    ]);
    expect((await stored(threadId, "read-one"))?.content).toBe(
      REMOVED_PROJECT_RESULT,
    );
    // And a copy that lost the mark on its way: the stored mark stands, so the cover does.
    await appendMessages(database, threadId, [
      result("read-one", undefined, "프로젝트에서 읽은 말"),
    ]);
    expect(await stored(threadId, "read-one")).toMatchObject({
      content: REMOVED_PROJECT_RESULT,
      lafProjects: [one],
    });
  });

  test("a message that is not a tool's result is never rewritten, whatever it carries", async () => {
    const threadId = thread();
    const gone = `thread-store-project-${randomUUID()}`;
    await appendMessages(database, threadId, [
      {
        id: "said",
        role: "assistant",
        content: "제가 본 바로는 숙소는 애월이에요.",
        lafProjects: [gone],
      } as unknown as StoredMessage,
    ]);
    expect((await stored(threadId, "said"))?.content).toBe(
      "제가 본 바로는 숙소는 애월이에요.",
    );
  });

  test("an append waits for a deletion holding the project's row, and then stores the result covered", async () => {
    const threadId = thread();
    const one = await project();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    /*
     * The deletion's transaction: the row lock, then the project goes. On a pool of its own — a
     * test's pool has one connection for transactions (`support/database.ts`), and these two have
     * to be open at once.
     */
    const elsewhere = createDatabase(databaseUrl, { max: 1 });
    const deleting = elsewhere.transaction(async (transaction) => {
      await transaction
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.id, one))
        .for("update");
      locked();
      await held;
      await transaction.delete(channels).where(eq(channels.id, one));
    });
    await isLocked;
    let appended = false;
    const appending = appendMessages(database, threadId, [
      result("late", [one], "늦게 도착한 사본"),
    ]).then(() => {
      appended = true;
    });
    /*
     * Until the database itself says a session here is waiting on a lock at a `for share` read:
     * the append, at the project's row. Asked, not slept for — a wait that is over is an answer.
     */
    const isWaiting = async () => {
      const rows = await database.execute<{ waiting: number }>(sql`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query like '%for share%'`);
      return ([...rows][0]?.waiting ?? 0) > 0;
    };
    let asked = 0;
    while (!(await isWaiting()) && asked < 500) asked += 1;
    expect(await isWaiting()).toBe(true);
    expect(appended).toBe(false);
    release();
    await Promise.all([deleting, appending]);
    await elsewhere.$client.close();
    expect((await stored(threadId, "late"))?.content).toBe(
      REMOVED_PROJECT_RESULT,
    );
  });
});

describe("what booting reads", () => {
  test("construction does not read a single thread's messages", async () => {
    const threadId = thread();
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

    await LafPostgresRunner.create(counting);
    expect(touched).toEqual([]);

    // And the wrapper does count a read of them, so the empty list above is a measurement.
    await messagesFor(counting, threadId);
    expect(touched).toEqual(["laf_thread_messages"]);
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
