import { and, eq, lt, sql } from "drizzle-orm";
import type { HubDatabase, HubTransaction } from "./db/client";
import { hubIdempotency } from "./db/schema";

/** How long an answer is kept for a retry: a day, past any VM's backoff and outbox sweep. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** What a key may look like: a UUID in practice, bounded so a key cannot be a payload. */
export const IDEMPOTENCY_KEY_SHAPE = /^[A-Za-z0-9_.:-]{8,128}$/;

export type Answer = { status: number; body: unknown };

/**
 * Does `work` once per (member, key) and answers every repeat with what the first time answered.
 *
 * The key's row is inserted FIRST, in the same transaction as the work. A second request with the
 * same key blocks on that insert until the first commits, then finds the row and replays it; if
 * the first rolled back, the second's insert goes through and it does the work itself. So two
 * copies of one write racing each other still make one write — the case a VM retrying after a
 * timeout produces, since the first copy may still be running when the second arrives.
 */
export async function onceFor(
  database: HubDatabase,
  member: string,
  key: string,
  work: (tx: HubTransaction) => Promise<Answer>,
): Promise<Answer & { replayed: boolean }> {
  return database.transaction(async (tx) => {
    const claimed = await tx
      .insert(hubIdempotency)
      .values({ member, key, status: 0, body: null })
      .onConflictDoNothing()
      .returning({ key: hubIdempotency.key });
    if (claimed.length === 0) {
      const [stored] = await tx
        .select({ status: hubIdempotency.status, body: hubIdempotency.body })
        .from(hubIdempotency)
        .where(
          and(eq(hubIdempotency.member, member), eq(hubIdempotency.key, key)),
        );
      if (!stored) throw new Error("idempotency row vanished under its lock");
      return { status: stored.status, body: stored.body, replayed: true };
    }
    const answer = await work(tx);
    await tx
      .update(hubIdempotency)
      .set({ status: answer.status, body: answer.body ?? null })
      .where(
        and(eq(hubIdempotency.member, member), eq(hubIdempotency.key, key)),
      );
    return { ...answer, replayed: false };
  });
}

/** Drops answers older than a day. Run at boot and hourly. */
export async function sweepIdempotency(
  database: HubDatabase,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS);
  const removed = await database
    .delete(hubIdempotency)
    .where(lt(hubIdempotency.at, cutoff))
    .returning({ key: hubIdempotency.key });
  return removed.length;
}

/** For `/metrics`: how many answers are being kept. */
export async function countIdempotency(database: HubDatabase): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(hubIdempotency);
  return Number(row?.count ?? 0);
}
