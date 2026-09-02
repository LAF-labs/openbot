/**
 * The nightly sweep: rows that have aged past what this deployment said it would keep.
 *
 * THE DECISION IT IMPLEMENTS is §7-7 of `docs/laf/redesign-2026-09.md` — audit one year,
 * conversations until the person deletes them, backups thirty days. Only the first of those is
 * code: a conversation has no expiry by decision, and a backup lives outside this process (the
 * fleet tool; see `docs/laf/deploying.md`).
 *
 * WHAT AGES OUT WITH THE TRAIL. `laf_thread_runs` and `laf_routine_runs` are the operational
 * skeleton of what the machine did — when a run started, how it ended, how many turns it took —
 * and they answer the same kind of question the trail does, one year back. Left alone they are the
 * two tables that grow forever on a VM nobody prunes; §3.5 already names the range query on
 * `laf_thread_runs.started_at` as the one that gets slower every day.
 *
 * AND THE NOTIFICATION OUTBOX, on a cutoff of its own — thirty days, not a year, because a message
 * about something is not the something. See NOTIFICATION_RETENTION_DAYS below.
 *
 * THE TRAIL IS DELETED THROUGH THE FUNCTION, NOT WITH A DELETE. `audit_events_append_only` refuses
 * an ordinary DELETE and goes on refusing one — migration 0028 opened exactly two named exits and
 * this is the second of them. The run tables have no such trigger and are deleted normally; saying
 * so here rather than making them look symmetrical, because they are not.
 *
 * A TICK, LIKE THE ROUTINES TICK (`routines/service.ts` `start()`), for the same reason: one
 * process, one VM, no scheduler to install. The interval is coarse — this is a job whose deadline
 * is "some time today" — and the first sweep runs shortly after boot so a deployment that is only
 * ever up for an hour a day still prunes.
 */
import { lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafRoutineRuns, lafThreadRuns } from "../db/schema";
import { purgeNotificationsBefore } from "../notifications/outbox";

/** A year, in days. The number §7-7 settled on; the variable is what a deployment can move. */
export const DEFAULT_RETENTION_DAYS = 365;

/**
 * Thirty days for the notification outbox, and it is not the trail's number.
 *
 * A notification is a message about something, not the something: the approval's own `approval.*`
 * rows are what a year of retention is for, and they are what the KPI is computed from. A row here
 * is worth keeping only long enough that a person who was away for a few weeks still sees what was
 * waiting, so it is a fixed number rather than a knob — a deployment that wants a longer memory of
 * what happened already has one, in the trail.
 *
 * It rides the same tick, which means `AUDIT_RETENTION_DAYS=0` — a deployment under an obligation
 * to keep everything — keeps these too. Said out loud rather than worked around: the switch is
 * "prune nothing", and a queue that kept pruning under it would be the sweep having an opinion the
 * operator did not ask for.
 */
export const NOTIFICATION_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1_000;

export type RetentionOutcome = {
  cutoff: string;
  auditEvents: number;
  threadRuns: number;
  routineRuns: number;
  /** Outbox rows, on their own thirty-day cutoff. See NOTIFICATION_RETENTION_DAYS. */
  notifications: number;
};

export type RetentionJob = {
  /** One sweep, awaited. The tick calls it; a test calls it directly. */
  runOnce: () => Promise<RetentionOutcome | null>;
  start: (everyMs: number) => void;
  stop: () => void;
};

/**
 * How long this deployment keeps its trail, read from the environment.
 *
 * `0` DISABLES IT, and that is a real setting rather than an accident: a deployment under an
 * obligation to keep everything must be able to say so, and the way to say it must not be "delete
 * the tick and remember why". Anything that is not a whole number of days at least zero refuses to
 * start, the same stance `AGENT_STALL_TIMEOUT_MS` takes and for the same reason — an operator who
 * typed `1y` should not get a running deployment quietly pruning on the default.
 */
export function retentionDays(
  environment: Record<string, string | undefined> = process.env,
): number {
  const raw = environment.AUDIT_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(
      "AUDIT_RETENTION_DAYS must be a whole number of days, or 0 to keep everything",
    );
  }
  return days;
}

export function createRetentionJob(input: {
  database: Database;
  /** Days to keep. Zero switches the job off entirely — no tick, no sweep, no log line. */
  days: number;
  /** Where the one line per run goes. Injected so a test can read it. */
  log?: (message: string) => void;
  now?: () => Date;
}): RetentionJob {
  const { database, days } = input;
  const log = input.log ?? ((message: string) => console.info(message));
  const now = input.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  /** One sweep at a time. A slow purge must not have a second one running over the top of it. */
  let sweeping = false;

  const runOnce = async (): Promise<RetentionOutcome | null> => {
    if (days <= 0) return null;
    if (sweeping) return null;
    sweeping = true;
    try {
      const cutoff = new Date(now().getTime() - days * DAY_MS);

      const [purged] = [
        ...(await database.execute<{ removed: string | number }>(
          sql`select audit_purge_before(${cutoff}) as removed`,
        )),
      ];
      const auditEventCount = Number(purged?.removed ?? 0);

      const threadRuns = await database
        .delete(lafThreadRuns)
        .where(lt(lafThreadRuns.startedAt, cutoff))
        .returning({ runId: lafThreadRuns.runId });
      const routineRuns = await database
        .delete(lafRoutineRuns)
        .where(lt(lafRoutineRuns.startedAt, cutoff))
        .returning({ id: lafRoutineRuns.id });

      /*
       * A cutoff of its own, thirty days rather than the trail's year, and a plain DELETE.
       *
       * The outbox has no append-only trigger and needs none: it is a delivery queue whose rows are
       * marked as they are delivered and seen. Saying so here rather than routing it through
       * `audit_purge_before` for symmetry, because the symmetry would be a lie about what this
       * table is.
       */
      const notifications = await purgeNotificationsBefore(
        database,
        new Date(now().getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS),
      );

      const outcome: RetentionOutcome = {
        cutoff: cutoff.toISOString(),
        auditEvents: auditEventCount,
        threadRuns: threadRuns.length,
        routineRuns: routineRuns.length,
        notifications,
      };
      /*
       * ONE LINE, ALWAYS, INCLUDING THE RUN THAT REMOVED NOTHING. A job that logs only when it did
       * something is a job nobody can tell apart from a job that stopped running, which on a
       * retention sweep is the difference between "nothing was old enough" and "we have been
       * keeping everything for a year without noticing".
       */
      log(
        `retention: kept ${days} days (before ${outcome.cutoff}) — ` +
          `${outcome.auditEvents} audit, ${outcome.threadRuns} runs, ` +
          `${outcome.routineRuns} routine runs removed; ` +
          `${outcome.notifications} notifications removed (kept ${NOTIFICATION_RETENTION_DAYS} days)`,
      );
      return outcome;
    } finally {
      sweeping = false;
    }
  };

  return {
    runOnce,
    start(everyMs) {
      if (days <= 0 || everyMs <= 0 || timer) return;
      timer = setInterval(() => {
        void runOnce().catch((error) => {
          // Swallowed, because a failed sweep is not a reason to take the deployment down. It is a
          // reason to say so and try again tonight.
          log(
            `retention: sweep failed — ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }, everyMs);
      // Never hold the process open for a job whose deadline is "some time today".
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
