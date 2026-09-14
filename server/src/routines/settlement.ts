import type { Database } from "../db/client";
import type { lafRoutines } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import type { RunLedger } from "../runner/run-ledger";
import type { Executor } from "../runner/thread-store";
import type { UnattendedRunResult } from "../runner/unattended";
import type {
  Delivered,
  DeliverRoutineAnswer,
  DeliverRoutineFailure,
} from "./deliver";
import { type NotepadDraft, type NotepadWrite, settleNotepad } from "./notepad";
import { writeReceipt } from "./receipts";

/**
 * ONE RECORD OF THIS RUN, IN ONE TRANSACTION.
 *
 * The writes here used to commit one at a time. `deliver` committed the answer, and a kill in
 * the moment before `ledger.finish` left the answer in the conversation beside a ledger row
 * still saying `running` — so boot reconciled it to `unknown`, marked it interrupted under the
 * finished answer and sent `run.failed` for a 07:30 briefing that had arrived (audit A1-1,
 * reproduced by SIGKILL; `laf upgrade` restarts the server every time).
 *
 * The answer or the failure mark, the ledger's ending and the receipt now commit together, so a
 * restart finds one of two states and both are true: nothing delivered and the ledger still
 * `running`, which boot reports as the interruption it is; or the answer beside a settled
 * ledger row, which boot leaves alone. `rooms/service.ts` is the model: the writes inside the
 * transaction, the announcement after it commits (`channels/events.ts` on why a socket frame
 * must never precede a commit), which is why a delivery returns its announcement instead of
 * making it.
 *
 * The notepad a successful run leaves behind is in the same commit (`notepad.ts`), so the cursor
 * moves exactly when the answer it describes is on record, and a restart never finds one without
 * the other.
 *
 * The `routine.ran` trail row stays after the commit (`run-report.ts`), because the outbox watch
 * that tells the person about a failed run fires off that insert (`notifications/from-audit.ts`)
 * and a notification must not go out for a record that could still roll back. A kill between the
 * two loses that row and its bell — never the truth of the conversation.
 */

export type SettlementOptions = {
  database: Database;
  /** See `RoutineServiceOptions` in `service.ts` for each of these. */
  ledger?: RunLedger;
  deliver?: DeliverRoutineAnswer;
  deliverFailure?: DeliverRoutineFailure;
  now: () => Date;
};

/** A run that has finished trying, as its record is written from. */
export type RunToSettle = {
  row: typeof lafRoutines.$inferSelect;
  /** The receipt's id. */
  runId: string;
  startedAt: Date;
  /** Who the run was made as. Null when that person's account is gone. */
  author: string | null;
  /** The ledger row the run opened, when the ledger could open one. */
  ledgerRunId: string | null | undefined;
  ok: boolean;
  answer: string;
  failure: string;
  steps: UnattendedRunResult["steps"] | null;
  /** Decided once, before this, so the conversation, the receipt and the trail cannot disagree. */
  silent: boolean;
  /** What the run staged for its notepad. Null for a run that was never offered one. */
  notepad: NotepadDraft | null;
};

/** What the record came to, and the announcements it earned — to be made by the caller. */
export type Settlement = {
  /** Whether the run is reported as having succeeded; false too when its record rolled back. */
  ok: boolean;
  failure: string;
  delivered: Delivered | null;
  failedIn: Delivered | null;
  /** What became of the notepad the run changed. Null when it changed nothing. */
  notepad: NotepadWrite | null;
};

/** Write the run's record whole, or report the run as the failure a rollback made it. */
export async function settleRun(
  options: SettlementOptions,
  run: RunToSettle,
): Promise<Settlement> {
  try {
    const { delivered, failedIn, notepad } = await options.database.transaction(
      async (transaction) => writeRecord(options, transaction, run),
    );
    return { ok: run.ok, failure: run.failure, delivered, failedIn, notepad };
  } catch (error) {
    /*
     * The record rolled back whole: nothing was delivered, no receipt was written, and the ledger
     * row is still `running`. What happened to the RUN is no longer what the person will read —
     * whatever the Bot said, it did not reach them — so it is reported as the failure it now is,
     * and the ledger is closed on the pool so the roster does not show the Bot busy until boot.
     */
    const failure = `The run's record could not be written: ${describeFailure(error)}`;
    log.error("routine_run_not_recorded", {
      routine: run.row.id,
      ...(run.ledgerRunId ? { run: run.ledgerRunId } : {}),
      reason: describeFailure(error),
    });
    if (run.ledgerRunId) {
      await options.ledger?.finish(run.ledgerRunId, failure).catch(() => {});
    }
    // The notepad rolled back with the rest: the cursor is where the last recorded run left it.
    return {
      ok: false,
      failure,
      delivered: null,
      failedIn: null,
      notepad: run.notepad?.changed ? "discarded" : null,
    };
  }
}

async function writeRecord(
  options: SettlementOptions,
  transaction: Executor,
  run: RunToSettle,
): Promise<Omit<Settlement, "ok" | "failure">> {
  // The cursor first, so every other write in the record is one that can still take it back.
  const notepad = await landNotepad(options, transaction, run);
  const delivered = await deliverAnswer(options, transaction, run);
  const failedIn = await markFailure(options, transaction, run);

  if (run.ledgerRunId) {
    await options.ledger?.settle(
      run.ledgerRunId,
      { status: run.ok ? "done" : "error", error: run.ok ? null : run.failure },
      transaction,
    );
  }

  await writeReceipt(transaction, {
    id: run.runId,
    routineId: run.row.id,
    startedAt: run.startedAt,
    finishedAt: options.now(),
    ok: run.ok,
    answer: run.ok ? run.answer : null,
    error: run.ok ? null : run.failure,
    steps: run.steps,
  });
  return { delivered, failedIn, notepad };
}

/**
 * The notepad the run changed, written over the version it read (`notepad.ts`, `settleNotepad`).
 *
 * Only for a run that succeeded. A failed run's answer reached nobody, and a cursor advanced past
 * what nobody received is a review skipped — so its writes are discarded, and the next run covers
 * the same window again.
 */
async function landNotepad(
  options: SettlementOptions,
  transaction: Executor,
  run: RunToSettle,
): Promise<NotepadWrite | null> {
  if (!run.notepad?.changed) return null;
  if (!run.ok) return "discarded";
  return settleNotepad(transaction, run.notepad, run.runId, options.now());
}

/**
 * The answer, into the Bot's conversation with its author.
 *
 * Not for a run that failed, has no author to deliver to, said nothing, or said `[SILENT]` — a
 * report of nothing is delivered nowhere (`deliver.ts`, `isSilentAnswer`), while its receipt and
 * trail row are still written.
 */
async function deliverAnswer(
  options: SettlementOptions,
  transaction: Executor,
  run: RunToSettle,
): Promise<Delivered | null> {
  const { row, author, ledgerRunId } = run;
  return run.ok && author && !run.silent && run.answer.trim().length > 0
    ? ((await options.deliver?.(
        {
          agentId: row.agentId,
          userId: author,
          routineName: row.name,
          answer: run.answer,
          at: options.now(),
          // Which run said it, so the transcript and the ledger agree — true only because
          // the ledger row is settled in this same transaction.
          ...(ledgerRunId ? { runId: ledgerRunId } : {}),
        },
        { within: transaction },
      )) ?? null)
    : null;
}

/**
 * A run that did not finish is marked where its answer would have gone, keyed to the ledger
 * run so the transcript can say what kind of failure it was — the same line a failed chat
 * turn gets. Only with a ledger run to key it to: a heading with no line under it would
 * read as a routine that spoke and said nothing, which is a different fact.
 */
async function markFailure(
  options: SettlementOptions,
  transaction: Executor,
  run: RunToSettle,
): Promise<Delivered | null> {
  const { row, author, ledgerRunId } = run;
  return !run.ok && author && ledgerRunId
    ? ((await options.deliverFailure?.(
        {
          agentId: row.agentId,
          userId: author,
          routineName: row.name,
          runId: ledgerRunId,
          at: options.now(),
        },
        { within: transaction },
      )) ?? null)
    : null;
}
