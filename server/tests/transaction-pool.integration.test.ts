import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { channels } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * A PLAIN WRITE IS NEVER INSIDE SOMEBODY ELSE'S TRANSACTION.
 *
 * Bun before 1.4.0 hands a transaction that had to wait for a connection one that the pool keeps
 * offering to plain queries (oven-sh/bun#32004; `db/client.ts` has the mechanism and the numbers).
 * A write issued while that transaction is open runs inside it, and its rollback takes the write
 * with it while the write's own promise has already said it succeeded. That is how
 * `chat-stop.integration.test.ts` lost the channel a test had just made.
 *
 * The shape here is the one that measured 38 to 40 in 40 on Bun 1.3.x with one pool of two: both
 * connections busy, a transaction queued behind them, a plain INSERT while it is open, then the
 * rollback. Three times, so the bug does not get to pass by luck. It holds on any Bun because
 * `createDatabase` gives transactions a pool of their own; on Bun 1.4 it would hold without that.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const made: string[] = [];

afterAll(async () => {
  if (made.length > 0) {
    await database.delete(channels).where(inArray(channels.id, made));
  }
  await database.$client.close();
});

async function writeBesideARollback() {
  const id = `channel_tx-pool-${randomUUID().slice(0, 8)}`;
  made.push(id);

  /*
   * Every connection busy, so the transaction below waits to be handed one as it frees up. A beat
   * apart: two queries started in the same tick are pipelined onto one connection, the transaction
   * takes the other at once, and nothing is shown.
   */
  const shorter = database
    .execute(sql`select pg_sleep(0.05)`)
    .then(() => undefined);
  await Bun.sleep(10);
  const longer = database
    .execute(sql`select pg_sleep(0.4)`)
    .then(() => undefined);
  await Bun.sleep(10);
  let transactionPid: number | null = null;
  const rolledBack = database
    .transaction(async (transaction) => {
      const rows = await transaction.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`,
      );
      transactionPid = Number([...rows][0]?.pid);
      await Bun.sleep(200);
      throw new Error("rolled back on purpose");
    })
    .then(
      () => false,
      () => true,
    );

  // While it is open: somebody else's ordinary write.
  await Bun.sleep(120);
  const written = await database.execute<{ pid: number }>(
    sql`insert into channels (id, name, description)
        values (${id}, ${"transaction pool"}, ${"A plain write beside a transaction."})
        returning pg_backend_pid() as pid`,
  );
  const writerPid = Number([...written][0]?.pid);

  await Promise.all([shorter, longer, rolledBack]);
  const kept = await database
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.id, id));

  return {
    rolledBack: await rolledBack,
    sameConnection: writerPid === transactionPid,
    kept: kept.length === 1,
  };
}

describe("a transaction and the pool beside it", () => {
  test("a write made while a transaction is open is not inside it, and survives its rollback", async () => {
    for (let trial = 0; trial < 3; trial += 1) {
      expect(await writeBesideARollback()).toEqual({
        rolledBack: true,
        sameConnection: false,
        kept: true,
      });
    }
  }, 20_000);
});
