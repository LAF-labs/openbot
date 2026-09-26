/**
 * How many connections one test file may hold.
 *
 * The suite runs in a single process, so every file that opens a pool holds it for the whole run and
 * the totals add up rather than take turns. Left at the driver's default the suite sat at 83 of
 * PostgreSQL's 100, which is not a limit anybody set and not one that shows up until a file is added
 * and something unrelated fails on a machine slower than the author's. Close the pool in `afterAll`.
 *
 * Two for plain queries, plus one for transactions, which `createDatabase` keeps on a pool of their
 * own because Bun before 1.4.0 runs a plain query inside another caller's transaction
 * (`db/client.ts`). Not one for plain queries: that stalls `authorization-matrix`. A test that wants
 * the deadlock that pinning exposes — a transaction waiting on another one — asks for `{ max: 1 }`.
 */
export const TEST_POOL = { max: 2 } as const;
