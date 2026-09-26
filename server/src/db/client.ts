import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

/**
 * TWO POOLS: ONE FOR PLAIN QUERIES, AND ONE THAT ONLY EVER OPENS TRANSACTIONS.
 *
 * Bun's SQL pool before 1.4.0 runs a plain query inside somebody else's transaction
 * (oven-sh/bun#32004, diagnosed in the unmerged #32006, fixed by ff512eaa5f in #36165, first
 * released in Bun 1.4.0). A `begin()` that has to wait for a connection is handed one by the pool's
 * `release()`, which marks it reserved but leaves it in the ready set, and the distributor skips
 * only connections that are about to be reserved — so the next plain queries go down that
 * connection, inside the transaction. They see its uncommitted rows, nobody else sees theirs, and
 * its rollback takes them with it while every promise resolves normally. With queries from two
 * callers pipelined on one connection, the driver can also write one ahead of the transaction's
 * COMMIT and leave the connection inside a transaction that never ends.
 *
 * MEASURED 2026-09-27, a pool of two, a transaction that had to wait for its connection and then
 * rolled back, one plain INSERT issued while it was open: the INSERT was gone in 38 of 40 trials on
 * Bun 1.3.11, 40 of 40 on 1.3.14 (the images' runtime) and 0 of 40 on 1.4.2. In this repository it
 * was `chat-stop.integration.test.ts` failing 14 runs in 200 under a little CPU load, and once in
 * one run of the server suite: the channel and membership rows a test wrote went into a runner
 * transaction running in the background, its next row went down the other connection and could not
 * see them (23503), and the next test met that transaction aborted (25P02). Three of the 14 were the
 * other half — a connection left `idle in transaction` after the runner's plain owner lookup, and
 * three tests timing out behind it.
 *
 * A pool that serves nothing but `begin()` has nothing for the distributor to hand out: a statement
 * inside a transaction is written straight to that transaction's connection and never queues on the
 * pool. So transactions, and `reserve()`, which takes the same path, get a pool of their own, and a
 * plain query can never land on a connection a transaction holds. Redundant from Bun 1.4.0; go back
 * to one pool when the images move there.
 *
 * `max` still bounds the plain pool, and transactions get half as many again, at least one. Not the
 * plain pool shrunk to pay for them: a plain pool of one stalls `authorization-matrix` on Bun
 * 1.3.11 with both connections idle and nothing open, one pool or two. Left out, each pool takes the
 * driver's default, and a process that never opens a transaction never opens the second. The
 * suite's total went from 84 to 67 connections at its peak, against CI's 100, because the three
 * test files that held ten each for the whole run now close them.
 *
 * With the split, a transaction that reads on the database rather than on itself no longer waits
 * for a connection another transaction holds; it only fails to see its own uncommitted rows. What
 * still starves is a transaction that opens ANOTHER transaction on the database and waits for it:
 * once every transaction connection is inside one, none comes back. `{ max: 1 }` leaves one
 * transaction connection, which turns that from a load-dependent production hang into an immediate
 * one.
 */
export function createDatabase(
  databaseUrl: string,
  options: { max?: number } = {},
) {
  const { queries, transactions } = poolsOf(databaseUrl, options.max);
  const closeQueries = queries.close;
  const close = async (closing?: { timeout?: number }) => {
    await Promise.all([closeQueries(closing), transactions.close(closing)]);
  };
  // Assigned onto the driver's own object rather than wrapped: its `Symbol.asyncDispose` calls
  // `sql.close` by name, so it closes both pools too.
  const client = Object.assign(queries, {
    begin: transactions.begin,
    transaction: transactions.begin,
    beginDistributed: transactions.beginDistributed,
    distributed: transactions.beginDistributed,
    reserve: transactions.reserve,
    close,
    end: close,
  });

  return drizzle({ client, schema });
}

function poolsOf(
  databaseUrl: string,
  max: number | undefined,
): { queries: SQL; transactions: SQL } {
  if (max === undefined) {
    return {
      queries: new SQL(databaseUrl),
      transactions: new SQL(databaseUrl),
    };
  }
  return {
    queries: new SQL(databaseUrl, { max }),
    transactions: new SQL(databaseUrl, { max: Math.ceil(max / 2) }),
  };
}

export type Database = ReturnType<typeof createDatabase>;
