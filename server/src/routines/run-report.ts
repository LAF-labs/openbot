import type { AuditStore } from "../audit";
import { classifyTurnFailure } from "../channels/turn-failures";
import type { lafRoutines } from "../db/schema";
import type { Settlement } from "./settlement";

/**
 * The `routine.ran` trail row: the durable record of one run, and how a failed one reaches a person.
 *
 * The outbox watch (`notifications/from-audit.ts`) reads this row to raise `run.failed`, so it is
 * written only after the settlement has committed — see `settlement.ts` for why a notification must
 * not go out for a record that could still roll back.
 */
export type RunReport = {
  row: typeof lafRoutines.$inferSelect;
  /** Who the run was made as. Null when that person's account is gone. */
  author: string | null;
  ledgerRunId: string | null | undefined;
  silent: boolean;
  /** What the settlement came to, which is what the person was — or was not — told. */
  settled: Settlement;
};

export async function reportRun(
  auditStore: AuditStore | undefined,
  { row, author, ledgerRunId, silent, settled }: RunReport,
): Promise<void> {
  const { ok, failure } = settled;
  try {
    await auditStore?.insert({
      eventType: "routine.ran",
      targetType: "routine",
      targetId: row.id,
      payload: {
        agentId: row.agentId,
        name: row.name,
        ok,
        /*
         * Who the run was made as, in the payload rather than the actor column — the column is
         * for a person who did something, and nobody did this; the local fixture in particular
         * must never become the actor of a row (auth/dev-actor.ts). It is what the outbox watch
         * reads to know who to tell (notifications/from-audit.ts).
         */
        ...(author ? { actor: author } : {}),
        ...(ledgerRunId ? { runId: ledgerRunId } : {}),
        // Only when true: a row that ran and reported reads exactly as it always did.
        ...(silent && ok ? { silent: true } : {}),
        /*
         * The failure as a fact code, never the sentence that threw — the same table the
         * transcript reads, so the notification and the red line agree — and the conversation
         * it was marked in, so the notification can point there.
         */
        ...(ok ? {} : { failure: classifyTurnFailure(failure) }),
        ...(settled.failedIn ? { channelId: settled.failedIn.channelId } : {}),
        /*
         * What became of the notepad the run changed, as a word and never its contents: whether the
         * cursor moved with this run is the question somebody reading a skipped review asks.
         */
        ...(settled.notepad ? { notepad: settled.notepad } : {}),
      },
    });
  } catch {
    // Losing the audit row must not fail the run that already happened.
  }
}
