import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import { and, count, desc, eq, lte, notInArray } from "drizzle-orm";
import { runAgentOnce } from "../agents/coworker-call";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import type { Database } from "../db/client";
import { lafRoutineRuns, lafRoutines } from "../db/schema";

/**
 * Routines: an instruction, a Bot, and a clock.
 *
 * See the schema note in db/schema/laf.ts for what a routine is and why the claim is a conditional
 * UPDATE. This module owns the arithmetic, the ticker, and the execution; the shape of a run is the
 * same server-side, toolless run a coworker being asked gets (runAgentOnce), because they are the
 * same act on a different trigger.
 */

/** Twenty routines per account. A wall against runaway creation, not a pricing tier. */
export const MAX_ROUTINES = 20;

/** Five minutes. Anything faster is polling, and polling is the watch service's job. */
export const MIN_INTERVAL_MINUTES = 5;

/** How long a routine's run may take. Longer than a coworker answer: nobody is waiting on screen. */
export const ROUTINE_RUN_TIMEOUT_MS = 180_000;

/** How many run records each routine keeps. The history of record is audit_events. */
const KEPT_RUNS = 20;

export class RoutineError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "RoutineError";
  }
}

export type RoutineSchedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; timeUtc: string };

export type RoutineInput = {
  agentId: string;
  name: string;
  instruction: string;
  schedule: RoutineSchedule;
};

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
  const match = /^(\d{2}):(\d{2})$/.exec(schedule.timeUtc);
  if (!match) throw new RoutineError("Time must be HH:MM.", 400);
  const next = new Date(from);
  next.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function parseSchedule(input: RoutineInput): RoutineSchedule {
  const { schedule } = input;
  if (schedule.kind === "interval") {
    if (
      !Number.isInteger(schedule.minutes) ||
      schedule.minutes < MIN_INTERVAL_MINUTES
    ) {
      throw new RoutineError(
        `The interval must be at least ${MIN_INTERVAL_MINUTES} minutes.`,
        400,
      );
    }
    return schedule;
  }
  if (schedule.kind === "daily") {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule.timeUtc);
    if (!match) {
      throw new RoutineError("The daily time must be HH:MM, UTC.", 400);
    }
    return schedule;
  }
  throw new RoutineError("The schedule must be interval or daily.", 400);
}

function scheduleOf(row: typeof lafRoutines.$inferSelect): RoutineSchedule {
  return row.scheduleKind === "daily"
    ? { kind: "daily", timeUtc: row.dailyUtc ?? "07:30" }
    : { kind: "interval", minutes: row.intervalMinutes ?? 60 };
}

export type RoutineServiceOptions = {
  database: Database;
  /** The same loader the runtime and the coworker call use, scoped to the routine's creator. */
  resolveAgents: (actor: AgentActor) => Promise<Record<string, AbstractAgent>>;
  auditStore?: AuditStore;
  now?: () => Date;
  runTimeoutMs?: number;
};

export function createRoutineService(options: RoutineServiceOptions) {
  const { database } = options;
  const now = options.now ?? (() => new Date());
  const runTimeoutMs = options.runTimeoutMs ?? ROUTINE_RUN_TIMEOUT_MS;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function execute(row: typeof lafRoutines.$inferSelect) {
    const startedAt = now();
    const runId = randomUUID();
    let ok = false;
    let answer = "";
    let failure = "";
    try {
      const agents = await options.resolveAgents({
        id: row.createdById,
        role: row.createdByRole === "admin" ? "admin" : "user",
      });
      const target = agents[row.agentId];
      if (!target) {
        throw new Error(`The Bot "${row.agentId}" is no longer in the roster.`);
      }
      answer = await runAgentOnce(target, row.instruction, runTimeoutMs);
      ok = true;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    await database.insert(lafRoutineRuns).values({
      id: runId,
      routineId: row.id,
      startedAt,
      finishedAt: now(),
      ok,
      answer: ok ? answer : null,
      error: ok ? null : failure,
    });
    // Keep the newest KEPT_RUNS; the audit row below is the durable record.
    const keep = database
      .select({ id: lafRoutineRuns.id })
      .from(lafRoutineRuns)
      .where(eq(lafRoutineRuns.routineId, row.id))
      .orderBy(desc(lafRoutineRuns.startedAt))
      .limit(KEPT_RUNS);
    await database
      .delete(lafRoutineRuns)
      .where(
        and(
          eq(lafRoutineRuns.routineId, row.id),
          notInArray(lafRoutineRuns.id, keep),
        ),
      );
    try {
      await options.auditStore?.insert({
        eventType: "routine.ran",
        targetType: "routine",
        targetId: row.id,
        payload: { agentId: row.agentId, name: row.name, ok },
      });
    } catch {
      // Losing the audit row must not fail the run that already happened.
    }
  }

  /**
   * One pass: claim everything due, run what was claimed.
   *
   * The claim advances nextRunAt in the same UPDATE that selects, so a second process ticking over
   * the same table finds nothing due — the rule the pull request template asks about, answered the
   * way it suggests: a conditional update, not a check-then-write.
   */
  async function tick(): Promise<number> {
    const at = now();
    const due = await database
      .select()
      .from(lafRoutines)
      .where(
        and(eq(lafRoutines.enabled, true), lte(lafRoutines.nextRunAt, at)),
      );

    let ran = 0;
    for (const row of due) {
      const next = nextRunAt(scheduleOf(row), at);
      const [claimed] = await database
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
      if (!claimed) continue; // Another process moved the clock first.
      await execute(claimed);
      ran += 1;
    }
    return ran;
  }

  return {
    async create(actor: AgentActor, input: RoutineInput) {
      const schedule = parseSchedule(input);
      const name = input.name.trim();
      const instruction = input.instruction.trim();
      if (!name) throw new RoutineError("Name the routine.", 400);
      if (!instruction) {
        throw new RoutineError("Say what the routine should do.", 400);
      }

      return database.transaction(async (transaction) => {
        const [held] = await transaction
          .select({ count: count() })
          .from(lafRoutines);
        if (Number(held?.count ?? 0) >= MAX_ROUTINES) {
          throw new RoutineError(
            `This account holds ${MAX_ROUTINES} routines already. Delete one to make room.`,
            409,
          );
        }
        const at = now();
        const [row] = await transaction
          .insert(lafRoutines)
          .values({
            id: `routine_${randomUUID()}`,
            agentId: input.agentId,
            name,
            instruction,
            scheduleKind: schedule.kind,
            intervalMinutes:
              schedule.kind === "interval" ? schedule.minutes : null,
            dailyUtc: schedule.kind === "daily" ? schedule.timeUtc : null,
            enabled: true,
            createdById: actor.id,
            createdByRole: actor.role,
            nextRunAt: nextRunAt(schedule, at),
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        return row;
      });
    },

    async list() {
      return database
        .select()
        .from(lafRoutines)
        .orderBy(desc(lafRoutines.createdAt));
    },

    async runs(routineId: string) {
      return database
        .select()
        .from(lafRoutineRuns)
        .where(eq(lafRoutineRuns.routineId, routineId))
        .orderBy(desc(lafRoutineRuns.startedAt))
        .limit(KEPT_RUNS);
    },

    async setEnabled(id: string, enabled: boolean) {
      const at = now();
      const [row] = await database
        .update(lafRoutines)
        .set({
          enabled,
          updatedAt: at,
          // Re-enabling re-arms the clock from now; a routine disabled for a week must not fire
          // seven times to catch up.
          ...(enabled ? {} : {}),
        })
        .where(eq(lafRoutines.id, id))
        .returning();
      if (!row) throw new RoutineError("There is no such routine.", 404);
      if (enabled) {
        const next = nextRunAt(scheduleOf(row), at);
        const [rearmed] = await database
          .update(lafRoutines)
          .set({ nextRunAt: next })
          .where(eq(lafRoutines.id, id))
          .returning();
        return rearmed ?? row;
      }
      return row;
    },

    async remove(id: string) {
      await database
        .delete(lafRoutineRuns)
        .where(eq(lafRoutineRuns.routineId, id));
      const removed = await database
        .delete(lafRoutines)
        .where(eq(lafRoutines.id, id))
        .returning();
      if (removed.length === 0) {
        throw new RoutineError("There is no such routine.", 404);
      }
    },

    /** Run one routine now, ahead of its clock. The claim still applies, so a due tick cannot double it. */
    async runNow(id: string) {
      const at = now();
      const [row] = await database
        .select()
        .from(lafRoutines)
        .where(eq(lafRoutines.id, id));
      if (!row) throw new RoutineError("There is no such routine.", 404);
      const next = nextRunAt(scheduleOf(row), at);
      const [claimed] = await database
        .update(lafRoutines)
        .set({ nextRunAt: next, lastRunAt: at, updatedAt: at })
        .where(eq(lafRoutines.id, id))
        .returning();
      if (claimed) await execute(claimed);
    },

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

export type RoutineService = ReturnType<typeof createRoutineService>;
