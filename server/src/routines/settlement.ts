import { eq } from "drizzle-orm";
import { classifyTurnFailure } from "../channels/turn-failures";
import type { Database } from "../db/client";
import { lafRoutines } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import {
  type CountedFailure,
  closeFailureGroups,
  countRepeatedFailure,
  openFailureGroup,
  routineFailureSignature,
  routineScope,
} from "../notifications/failure-groups";
import type { RunLedger } from "../runner/run-ledger";
import type { Executor } from "../runner/thread-store";
import { RUN_STOPPED, type UnattendedRunResult } from "../runner/unattended";
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
 * ledger row, which boot leaves alone. The writes inside the transaction, the announcement after
 * it commits (`channels/events.ts` on why a socket frame
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
 *
 * AND WHETHER A FAILURE IS NEWS IS PART OF THE RECORD. A failure that repeats one still open —
 * same routine, same code, same tool — is counted into that failure's group and marks nothing:
 * the conversation keeps the one line it already has, and the count on it goes up. Decided in
 * this transaction because the mark and the count must agree; see `notifications/failure-groups.ts`.
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
  /**
   * A person stopped it (`모두 멈추기`). Not ok, and not a failure either: see `writeRecord`.
   *
   * Optional so a caller that cannot be stopped says nothing, which is "not stopped".
   */
  stopped?: boolean;
  /**
   * The routine was taken back before the Bot was asked: deleted (`gone`) or switched off (`off`)
   * while the run waited its turn (`run.ts`). A stop, with the reason the trail keeps.
   */
  withdrawn?: Withdrawn;
};

/** Why a run stopped without a person pressing stop: its routine went, or was switched off. */
export type Withdrawn = "gone" | "off";

/** What the record came to, and the announcements it earned — to be made by the caller. */
export type Settlement = {
  /** Whether the run is reported as having succeeded; false too when its record rolled back. */
  ok: boolean;
  failure: string;
  /** A person stopped the run, and its record says so. False when the record rolled back. */
  stopped: boolean;
  /** Its routine was deleted or switched off under it. Null for every other run. */
  withdrawn: Withdrawn | null;
  delivered: Delivered | null;
  failedIn: Delivered | null;
  /** What became of the notepad the run changed. Null when it changed nothing. */
  notepad: NotepadWrite | null;
  /**
   * The failure group this run's failure was counted into. Null for a success, for a failure with
   * nobody to tell, and for one the group could not be recorded for — which is then told the way
   * every failure used to be.
   */
  group: CountedFailure | null;
};

/** Write the run's record whole, or report the run as the failure a rollback made it. */
export async function settleRun(
  options: SettlementOptions,
  run: RunToSettle,
): Promise<Settlement> {
  try {
    const { delivered, failedIn, notepad, group, gone } =
      await options.database.transaction(async (transaction) =>
        writeRecord(options, transaction, run),
      );
    return {
      ok: run.ok && !gone,
      failure: gone ? RUN_STOPPED : run.failure,
      stopped: run.stopped === true || gone,
      withdrawn: gone ? "gone" : (run.withdrawn ?? null),
      delivered,
      failedIn,
      notepad,
      group,
    };
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
      const ledgerRunId = run.ledgerRunId;
      await options.ledger?.finish(ledgerRunId, failure).catch((error) => {
        // Then the roster shows the Bot busy until the boot sweep closes the row.
        log.warn("routine_ledger_unclosed", {
          run: ledgerRunId,
          reason: error,
        });
      });
    }
    /*
     * The notepad rolled back with the rest: the cursor is where the last recorded run left it. So
     * did whatever the record did to a failure group — a close, a count, an opening — and a failure
     * that carries no group is told the way every failure used to be (`notifications/from-audit.ts`).
     */
    return {
      ok: false,
      failure,
      stopped: false,
      withdrawn: null,
      delivered: null,
      failedIn: null,
      notepad: run.notepad?.changed ? "discarded" : null,
      group: null,
    };
  }
}

async function writeRecord(
  options: SettlementOptions,
  transaction: Executor,
  run: RunToSettle,
): Promise<
  Omit<Settlement, "ok" | "failure" | "stopped" | "withdrawn"> & {
    gone: boolean;
  }
> {
  /*
   * THE ROUTINE FIRST, HELD FOR THE LENGTH OF THE RECORD. Every write below that names it — the
   * notepad, the receipt — takes this same key-share lock through its foreign key, so taking it
   * first changes no lock order; what it adds is the answer to "is the routine still there", held
   * true until commit, since a delete has to wait for it.
   *
   * A ROUTINE DELETED WHILE ITS RUN WAS OUT is recorded as the stop it is. Its receipt could not be
   * written — the foreign key refused it — so the whole record rolled back and the run was told to
   * the person as `run.failed`, the model's fault, for a routine they had just deleted (review
   * 2026-09-26). Now its ledger row closes as `stopped`, nothing is delivered for a routine nobody
   * has any more, and the trail says why.
   */
  const [still] = await transaction
    .select({ id: lafRoutines.id })
    .from(lafRoutines)
    .where(eq(lafRoutines.id, run.row.id))
    .for("key share");
  if (!still) {
    if (run.ledgerRunId) {
      await options.ledger?.settle(
        run.ledgerRunId,
        { status: "stopped", error: null },
        transaction,
      );
    }
    log.info("routine_run_withdrawn", {
      routine: run.row.id,
      why: "gone",
      ...(run.ledgerRunId ? { run: run.ledgerRunId } : {}),
    });
    return {
      delivered: null,
      failedIn: null,
      notepad: run.notepad?.changed ? "discarded" : null,
      group: null,
      gone: true,
    };
  }

  /*
   * WHERE THE NEXT RUN STARTS FROM IS ONE DECISION, taken here for both of its halves. A success
   * lands the notepad and closes the routine's open failure groups; a failure discards the notepad
   * and is counted into its group, or opens one. Both commit with the record or not at all, so a
   * restart never finds the cursor moved past a run the routine is still counting as failing.
   *
   * THE ORDER IS THE LOCK ORDER, the same on both paths. The cursor first, so every other write in
   * the record is one that can still take it back; it holds the notepad's row. Then the failure
   * groups, before the conversation: the routine's groups take their lock here, the thread takes
   * its own in `appendMessages`, and two settlements of one routine holding any two of those in
   * opposite orders would be a deadlock Postgres settles by throwing one record away. A person's
   * clear (`clearNotepad`) holds the notepad's row and nothing else, so it can make a settlement
   * wait but never cross one.
   */
  const notepad = await landNotepad(options, transaction, run);
  if (run.ok) {
    // The routine works again: whatever was failing is over, and its next failure is news.
    await closeFailureGroups(transaction, {
      userId: run.author,
      scope: routineScope(run.row.id),
      at: options.now(),
    });
  }
  const { failedIn, group } = await markOrCount(options, transaction, run);
  const delivered = await deliverAnswer(options, transaction, run);

  if (run.ledgerRunId) {
    await options.ledger?.settle(
      run.ledgerRunId,
      run.ok
        ? { status: "done", error: null }
        : run.stopped
          ? // The status the conversation's failure reader passes over, as it does a chat's Stop.
            { status: "stopped", error: null }
          : { status: "error", error: run.failure },
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
  return { delivered, failedIn, notepad, group, gone: false };
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
 * A failure: counted into the open group of its signature, or marked and made a group of its own.
 *
 * The count comes first, because it decides whether there is a mark at all. A repeat marks
 * nothing — no heading, no roster movement, no unread dot — since everything it would say is
 * already on the line the group's first failure left. A failure the group could not be looked up
 * for is marked the old way and left ungrouped, rather than taken for the first of its kind.
 */
async function markOrCount(
  options: SettlementOptions,
  transaction: Executor,
  run: RunToSettle,
): Promise<Pick<Settlement, "failedIn" | "group">> {
  const { row, author } = run;
  // Nobody to tell is nobody to group for; the mark needs a person too.
  if (run.ok || !author) return { failedIn: null, group: null };
  /*
   * A STOP IS NEITHER NEWS NOR A FAILURE TO COUNT. The person pressed it, so a red line in the
   * Bot's conversation would be telling them something they did as though it had happened to them,
   * and counting it into a failure group would make the routine's next real failure read as a
   * repeat of a stop. The receipt still says it was stopped; see `writeReceipt` below.
   */
  if (run.stopped) return { failedIn: null, group: null };

  const at = options.now();
  const signature = routineFailureSignature({
    routineId: row.id,
    code: classifyTurnFailure(run.failure),
    steps: run.steps,
  });
  const counted = await countRepeatedFailure(transaction, {
    userId: author,
    signature,
    at,
  });
  if (counted.kind === "repeat") {
    return {
      failedIn: null,
      group: { id: counted.id, count: counted.count, opened: false },
    };
  }

  const failedIn = await markFailure(options, transaction, run);
  if (counted.kind === "unavailable") return { failedIn, group: null };

  const id = await openFailureGroup(transaction, {
    userId: author,
    botId: row.agentId,
    channelId: failedIn?.channelId,
    run: { origin: "routine", label: row.name, code: signature.code },
    signature,
    // The run the mark carries, which is what the transcript's line is keyed to. No mark, no key.
    runId: failedIn ? run.ledgerRunId : null,
    at,
  });
  return {
    failedIn,
    group: id ? { id, count: 1, opened: true } : null,
  };
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
