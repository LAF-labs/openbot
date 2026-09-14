import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafRoutineRuns } from "../db/schema";
import type { Executor } from "../runner/thread-store";
import { isSilentAnswer } from "./deliver";

/**
 * A routine's receipts: `laf_routine_runs`, one row per run, the newest few kept.
 *
 * A receipt and not a record — the history of record is `audit_events`. Each one is written at the
 * end of its run, inside the settlement (`settlement.ts`), and read back for two things: the recent
 * runs a person looks through (`store.ts`), and what the next run is told it reported last time.
 */

/** How many run records each routine keeps. The history of record is audit_events. */
export const KEPT_RUNS = 20;

/**
 * The last thing this routine actually reported, read back out of its own receipts.
 *
 * Only a run that SUCCEEDED and said something: a failure is not what the person was told,
 * and carrying it forward would have the next run answer a question about an error message.
 * A silent run is skipped too — "[SILENT]" is not a report to compare against, and the
 * question "what has changed" is asked of the last thing the person was actually told.
 * Read here rather than held in memory because a routine outlives any process that runs it.
 *
 * Empty when there is nothing to carry.
 */
export async function lastReport(
  database: Database,
  routineId: string,
): Promise<string> {
  const recent = await database
    .select({ answer: lafRoutineRuns.answer })
    .from(lafRoutineRuns)
    .where(
      and(eq(lafRoutineRuns.routineId, routineId), eq(lafRoutineRuns.ok, true)),
    )
    .orderBy(desc(lafRoutineRuns.startedAt))
    .limit(KEPT_RUNS);
  return (
    recent
      .map((run) => (run.answer ?? "").trim())
      .find((said) => said.length > 0 && !isSilentAnswer(said)) ?? ""
  );
}

/** One receipt, written on the settlement's transaction, and the routine's oldest let go. */
export async function writeReceipt(
  transaction: Executor,
  receipt: typeof lafRoutineRuns.$inferInsert,
): Promise<void> {
  await transaction.insert(lafRoutineRuns).values(receipt);
  // Keep the newest KEPT_RUNS; the `routine.ran` audit row is the durable record.
  const keep = transaction
    .select({ id: lafRoutineRuns.id })
    .from(lafRoutineRuns)
    .where(eq(lafRoutineRuns.routineId, receipt.routineId))
    .orderBy(desc(lafRoutineRuns.startedAt))
    .limit(KEPT_RUNS);
  await transaction
    .delete(lafRoutineRuns)
    .where(
      and(
        eq(lafRoutineRuns.routineId, receipt.routineId),
        notInArray(lafRoutineRuns.id, keep),
      ),
    );
}
