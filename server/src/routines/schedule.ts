import type { lafRoutines } from "../db/schema";
import { RoutineError } from "./errors";
import {
  dayAfter,
  instantOf,
  isKnownTimeZone,
  wallClockAt,
} from "./zoned-clock";

/**
 * When a routine fires: the schedule a person writes, the window it names next, and how late a
 * window may be found and still be run.
 *
 * Pure, all of it — no clock of its own and no database — because every rule here is the kind of
 * fact a test should pin as a table. The clock that applies them is `ticker.ts`.
 */

export type RoutineSchedule =
  | { kind: "interval"; minutes: number }
  | {
      kind: "daily";
      /** HH:MM on the wall clock of `timeZone`, not UTC. */
      time: string;
      /**
       * IANA zone the time is written in.
       *
       * Absent (or blank) when a routine is made means the deployment's zone — see `parseSchedule`
       * — so every row written since 2026-09-16 names one. A row from before zones has none and is
       * read as UTC (`scheduleOf`), and so is a schedule handed to `nextRunAt` without one.
       */
      timeZone?: string;
      /**
       * Which weekdays it may run on, 0 = Sunday. Absent or empty means every day.
       *
       * Without this a "Monday morning open-up" routine also fires on Sunday, and a routine that
       * goes off on a day off is a routine somebody switches off.
       */
      days?: number[];
    };

/**
 * A schedule as a row keeps it: a daily one always names its zone and its days.
 *
 * What `parseSchedule` returns and `scheduleOf` reads back, so that nothing between the request and
 * the insert can supply a zone of its own. `store.ts` did — `timeZone ?? "UTC"` — and that was half
 * of what stored "매일 7시 반" as UTC.
 */
export type StoredSchedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string; timeZone: string; days: number[] };

/** Five minutes. Anything faster is polling, and polling is the watch service's job. */
export const MIN_INTERVAL_MINUTES = 5;

/**
 * How late a routine may be and still run: the catch-up grace.
 *
 * `nextRunAt` in the past fires at the first tick, however long ago it passed. That is right for a
 * server that was down for four minutes and wrong for one that was down overnight: the 07:30
 * open-up briefing arriving at 09:00 is not a briefing, it is a Bot answering a question about a
 * morning that is over, and an hourly monitor that missed six windows should not deliver six
 * verdicts at once when the machine comes back.
 *
 * IT WAS ONE HOUR FOR EVERY ROUTINE, and one hour is the wrong span for most of them. For a
 * five-minute monitor an hour late is twelve windows gone, and running it "late" is running it on
 * time for the thirteenth; for a daily briefing an hour is fine and two would be too. Hermes'
 * scheduler gets this right by making the grace a fraction of the period: half of it, clamped so
 * a fast interval still gets a couple of minutes of slack and a weekly routine does not get three
 * and a half days. Within the grace the routine runs ONCE, now — the misses in between are
 * collapsed, never queued, because the claim already moves the clock from the moment of the tick.
 * Past it the window is let go and the clock moves to the next one.
 *
 * Both outcomes leave a row: `routine.caught_up` when the run was later than a tick can explain
 * (the server was down, or the previous pass held the ticker), `routine.skipped_missed` when it
 * was let go — each carrying how late the window was and what the grace was, so "the VM was off
 * for nine hours" is readable from the trail.
 */
export const CATCH_UP_GRACE_MIN_MS = 2 * 60_000;
export const CATCH_UP_GRACE_MAX_MS = 2 * 60 * 60_000;

/**
 * How late a window may be before its run is recorded as a catch-up rather than as on time.
 *
 * One tick. The ticker fires every minute (`start(60_000)` in index.ts), so a window is normally
 * found up to a minute after it passed — that is the schedule working, not the schedule being
 * late, and writing a `routine.caught_up` row for it would put one on every run.
 */
export const CAUGHT_UP_AFTER_MS = 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** The grace for a schedule, in milliseconds. Pure, so the table can be pinned without a clock. */
export function catchUpGraceMs(schedule: RoutineSchedule): number {
  // A daily routine's period is a day whichever weekdays it keeps: a Monday-only routine that is
  // three days late is not "within half its period", it is a Thursday.
  const periodMs =
    schedule.kind === "interval" ? schedule.minutes * 60_000 : DAY_MS;
  return Math.min(
    CATCH_UP_GRACE_MAX_MS,
    Math.max(CATCH_UP_GRACE_MIN_MS, periodMs / 2),
  );
}

/**
 * When a schedule fires next, from `from`.
 *
 * Pure and exported, because "the routine I saved at 23:50 for 07:30 runs tomorrow morning, not
 * in four hundred days" is exactly the kind of fact a test should pin without a database.
 */
export function nextRunAt(schedule: RoutineSchedule, from: Date): Date {
  if (schedule.kind === "interval") {
    return new Date(from.getTime() + schedule.minutes * 60_000);
  }
  const match = /^(\d{2}):(\d{2})$/.exec(schedule.time);
  if (!match) {
    throw new RoutineError(
      "Time must be HH:MM.",
      400,
      "laf:routine_time_invalid",
    );
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const timeZone = schedule.timeZone ?? "UTC";
  const days = schedule.days ?? [];

  /*
   * Walk the LOCAL calendar forward, not the instant.
   *
   * Eight days rather than seven: the first candidate is today, which has usually already passed
   * by the time this is asked, so a weekly routine restricted to one weekday needs one more step
   * to reach it. Stepping local dates also means a daylight-saving transition cannot make the loop
   * skip or repeat a day, which adding 86,400,000ms to an instant would.
   */
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = dayAfter(from, offset, timeZone);
    const candidate = instantOf(day, hour, minute, timeZone);
    if (candidate.getTime() <= from.getTime()) continue;
    if (
      days.length > 0 &&
      !days.includes(wallClockAt(candidate, timeZone).weekday)
    ) {
      continue;
    }
    return candidate;
  }
  // Only reachable if every weekday was excluded, which `parseSchedule` refuses.
  throw new RoutineError(
    "That schedule never comes round.",
    400,
    "laf:routine_schedule_unreachable",
  );
}

/**
 * The schedule a person or a Bot sent, checked and normalised — or the refusal that says what is
 * wrong.
 *
 * `deploymentZone` is the zone a daily time is read in when the schedule names none:
 * `config.botTimeZone`, the clock every Bot is told the time in. It was UTC. The routines form always
 * sends the browser's zone, but a Bot's `manage_routine` sends "07:30" and nothing else, so "매일 7시
 * 반" was stored as 07:30 UTC and ran at 16:30 in Seoul while the Bot told the person it was done
 * (audit 2026-09-16, R2 F1). The Bot heard "7시 반" on the deployment's clock; that is the clock the
 * row gets. Rows already stored are not touched here — this runs when a routine is made.
 */
export function parseSchedule(
  schedule: RoutineSchedule,
  deploymentZone: string,
): StoredSchedule {
  if (schedule.kind === "interval") {
    if (
      !Number.isInteger(schedule.minutes) ||
      schedule.minutes < MIN_INTERVAL_MINUTES
    ) {
      throw new RoutineError(
        `The interval must be at least ${MIN_INTERVAL_MINUTES} minutes.`,
        400,
        "laf:routine_interval_too_short",
      );
    }
    return schedule;
  }
  if (schedule.kind === "daily") {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule.time);
    if (!match) {
      throw new RoutineError(
        "The daily time must be HH:MM.",
        400,
        "laf:routine_time_invalid",
      );
    }
    const timeZone = zoneNamedBy(schedule) ?? deploymentZone;
    if (!isKnownTimeZone(timeZone)) {
      throw new RoutineError(
        `This machine does not know the zone "${timeZone}".`,
        400,
        "laf:routine_zone_unknown",
      );
    }
    const days = [...new Set(schedule.days ?? [])].sort((a, b) => a - b);
    if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new RoutineError(
        "Days must be 0 (Sunday) to 6.",
        400,
        "laf:routine_days_invalid",
      );
    }
    // Every day and no days would be the same stored value; refusing the empty selection keeps
    // "runs every day" from being something a person can arrive at by unticking everything.
    if (schedule.days !== undefined && days.length === 0) {
      throw new RoutineError(
        "Pick at least one day.",
        400,
        "laf:routine_days_empty",
      );
    }
    return { kind: "daily", time: schedule.time, timeZone, days };
  }
  throw new RoutineError(
    "The schedule must be interval or daily.",
    400,
    "laf:routine_schedule_invalid",
  );
}

/**
 * The zone a daily schedule names, or nothing when it names none.
 *
 * Blank is none: a model fills an optional string with "" as readily as it leaves the field out, and
 * "" was refused as a zone this machine does not know. Anything else is handed on as written to be
 * checked — a zone that is wrong is refused, never quietly swapped for the deployment's, because a
 * Bot told "New York time" and stored on Seoul's is the same lie the other way round.
 */
function zoneNamedBy(schedule: { timeZone?: unknown }): string | undefined {
  const zone = schedule.timeZone;
  if (zone === undefined || zone === null) return undefined;
  if (typeof zone === "string" && zone.trim() === "") return undefined;
  return String(zone);
}

/** The schedule a stored routine row describes. */
export function scheduleOf(
  row: typeof lafRoutines.$inferSelect,
): StoredSchedule {
  if (row.scheduleKind !== "daily") {
    return { kind: "interval", minutes: row.intervalMinutes ?? 60 };
  }
  return {
    kind: "daily",
    time: row.dailyLocal ?? "07:30",
    // A row written before zones existed meant UTC, because that is what it did.
    timeZone: row.dailyTimeZone ?? "UTC",
    days: row.dailyDays ?? [],
  };
}
