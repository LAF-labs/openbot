import { and, asc, eq, lte } from "drizzle-orm";
import type { AuditStore } from "../audit";
import type { Database } from "../db/client";
import { lafRoutines } from "../db/schema";
import {
  CAUGHT_UP_AFTER_MS,
  catchUpGraceMs,
  nextRunAt,
  type RoutineSchedule,
  scheduleOf,
} from "./schedule";

/**
 * The clock: on every tick the routines that are due are claimed, and each one is run, caught up
 * or let go by the grace in `schedule.ts`.
 *
 * See the schema note in db/schema/laf.ts for why the claim is a conditional UPDATE.
 */

type RoutineRow = typeof lafRoutines.$inferSelect;

export type RoutineTickerOptions = {
  database: Database;
  auditStore?: AuditStore;
  now: () => Date;
  /**
   * Runs a routine this ticker has claimed (`run.ts`), answering whether it ran — a routine whose
   * author the deployment no longer admits is claimed for its window and not run.
   *
   * `scheduledFor` is the window that was claimed — the time the routine was due, which the claim
   * has already moved on from — so the run can tell its Bot what time it was meant for.
   */
  execute: (row: RoutineRow, scheduledFor?: Date) => Promise<boolean>;
  /**
   * Pauses what has gone unread on these Bots (`unread.ts`) — the Bots with a routine due in this
   * pass, asked before anything is claimed. Absent, nothing is paused, which is what a test that
   * drives the clock alone wants.
   */
  pauseUnread?: (botIds: string[], at: Date) => Promise<unknown>;
};

export function createRoutineTicker(options: RoutineTickerOptions) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  /**
   * One pass: claim everything due, run what was claimed and is not stale.
   *
   * The claim advances nextRunAt in the same UPDATE that selects, so a second process ticking over
   * the same table finds nothing due — the rule the pull request template asks about, answered the
   * way it suggests: a conditional update, not a check-then-write.
   *
   * A pass never overlaps a pass. `start` fires this on an interval while one run may take up to
   * ROUTINE_RUN_TIMEOUT_MS, so on a ten-minute run the ticker used to enter this function nine more
   * times underneath itself; each of those re-read the table, and a routine coming due meanwhile was
   * started by whichever pass reached it first while the others queued behind the Bot's lane. The
   * second pass is skipped, not queued: whatever it would have found is still due at the next tick,
   * and a queue of passes is how one slow morning turns into a burst at lunchtime.
   */
  async function tick(): Promise<number> {
    if (ticking) return 0;
    ticking = true;
    try {
      return await pass(options);
    } finally {
      ticking = false;
    }
  }

  return {
    tick,

    start(tickMs: number) {
      if (tickMs <= 0 || timer) return;
      timer = setInterval(() => void tick(), tickMs);
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** Everything due at this instant, attended to in order. How many of them ran. */
async function pass(options: RoutineTickerOptions): Promise<number> {
  const at = options.now();
  const due = await options.database
    .select()
    .from(lafRoutines)
    .where(and(eq(lafRoutines.enabled, true), lte(lafRoutines.nextRunAt, at)))
    // Oldest due first, then creation order: a pass is one sequential lane, and which routine
    // goes first must not depend on the order Postgres happened to return the rows.
    .orderBy(
      asc(lafRoutines.nextRunAt),
      asc(lafRoutines.createdAt),
      asc(lafRoutines.id),
    );

  /*
   * UNREAD FIRST, THEN THE CLAIMS. A routine whose results have been piling up unread is paused
   * before its window is claimed, so the run it would have spent is the one saved — and the claim
   * below asks for `enabled`, so a routine paused here is simply not taken. Only the Bots with
   * something due are looked at: a tick with nothing due costs nothing, and the pause lands at the
   * moment it saves something. A sweep that fails leaves every routine running, as before it existed.
   */
  if (due.length > 0 && options.pauseUnread) {
    const botIds = [...new Set(due.map((row) => row.agentId))];
    await options.pauseUnread(botIds, at).catch(() => undefined);
  }

  let ran = 0;
  for (const row of due) {
    if (await attend(options, row, at)) ran += 1;
  }
  return ran;
}

/** One due routine: claimed for this pass, then run, caught up or let go. Whether it ran. */
async function attend(
  options: RoutineTickerOptions,
  row: RoutineRow,
  at: Date,
): Promise<boolean> {
  const schedule = scheduleOf(row);
  const next = nextRunAt(schedule, at);
  const [claimed] = await options.database
    .update(lafRoutines)
    .set({ nextRunAt: next, lastRunAt: at, updatedAt: at })
    .where(
      and(
        eq(lafRoutines.id, row.id),
        eq(lafRoutines.enabled, true),
        lte(lafRoutines.nextRunAt, at),
      ),
    )
    .returning();
  // Somebody else already took this window: an overlapping tick, or a `runNow` that arrived
  // over HTTP while this pass was walking the list. One process, but not one caller.
  if (!claimed) return false;

  if (!(await withinGrace(options, row, schedule, at, next))) return false;

  return options.execute(claimed, row.nextRunAt);
}

/**
 * Whether a claimed window is still worth running, with the row that says so when it was late.
 *
 * How late this window is, measured against the moment it was supposed to fire — `row`, not
 * `claimed`, because the claim has already moved the clock to the next one.
 *
 * The claim is what makes either row safe to write: exactly one pass takes the routine, so
 * exactly one `routine.skipped_missed` or `routine.caught_up` is written, and the routine
 * leaves the pass armed for the next window either way. `lastRunAt` moves too, which is the
 * truthful reading — the scheduler did look at this routine, and the tick's own debounce
 * should treat it as attended to. See `catchUpGraceMs` for the policy.
 */
async function withinGrace(
  options: RoutineTickerOptions,
  row: RoutineRow,
  schedule: RoutineSchedule,
  at: Date,
  next: Date,
): Promise<boolean> {
  const lateBy = at.getTime() - row.nextRunAt.getTime();
  const graceMs = catchUpGraceMs(schedule);
  const lateness = {
    agentId: row.agentId,
    name: row.name,
    lateByMinutes: Math.round(lateBy / 60_000),
    graceMinutes: Math.round(graceMs / 60_000),
    missed: row.nextRunAt.toISOString(),
  };
  if (lateBy > graceMs) {
    try {
      await options.auditStore?.insert({
        eventType: "routine.skipped_missed",
        targetType: "routine",
        targetId: row.id,
        payload: { ...lateness, next: next.toISOString() },
      });
    } catch {
      // Losing the audit row must not turn a skip into a run.
    }
    return false;
  }
  if (lateBy > CAUGHT_UP_AFTER_MS) {
    try {
      await options.auditStore?.insert({
        eventType: "routine.caught_up",
        targetType: "routine",
        targetId: row.id,
        payload: lateness,
      });
    } catch {
      // Losing the audit row must not turn a catch-up into a skip.
    }
  }
  return true;
}
