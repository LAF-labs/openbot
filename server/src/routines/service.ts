import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import { and, count, desc, eq, isNull, lte, notInArray } from "drizzle-orm";
import { runAgentOnce } from "../agents/coworker-call";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import type { ActionActor } from "../computer/gateway";
import type { Database } from "../db/client";
import { lafRoutineRuns, lafRoutines } from "../db/schema";
import type { RunLedger } from "../runner/run-ledger";
import {
  runUnattended,
  UnattendedRunError,
  type UnattendedRunResult,
  type UnattendedToolkit,
} from "../runner/unattended";
import type { DeliverRoutineAnswer } from "./deliver";
import {
  dayAfter,
  instantOf,
  isKnownTimeZone,
  wallClockAt,
} from "./zoned-clock";

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

/**
 * How long a routine's run may take, tools included.
 *
 * Longer than a coworker answer: nobody is waiting on screen. And long enough for a reasoning
 * model, whose turns were measured at 50–75 seconds each — three minutes was four turns, and an
 * "open two pages and compare" routine was reaching the deadline on its way to the answer. This
 * is not the guard against a hung Bot: the stall watchdog (AGENT_STALL_TIMEOUT_MS) is, and it ends
 * a silent stream in a minute. This bounds a Bot that keeps working.
 */
export const ROUTINE_RUN_TIMEOUT_MS = 600_000;

/** How many run records each routine keeps. The history of record is audit_events. */
const KEPT_RUNS = 20;

/**
 * The shortest gap between two triggered runs of one routine.
 *
 * Webhooks are delivered at least once, and a sender that retries or a source that fires in bursts
 * must not turn one event into five model runs. Thirty seconds is a debounce, not a schedule: the
 * second delivery inside it is acknowledged and dropped, which is what an at-least-once sender
 * expects a receiver to do.
 */
export const TRIGGER_DEBOUNCE_MS = 30_000;

/** How much of a trigger payload reaches the Bot. Enough for an event, too little for a novel. */
const TRIGGER_PAYLOAD_LIMIT = 4_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

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
  | {
      kind: "daily";
      /** HH:MM on the wall clock of `timeZone`, not UTC. */
      time: string;
      /** IANA zone the time is written in. Absent means UTC, which is how old rows read. */
      timeZone?: string;
      /**
       * Which weekdays it may run on, 0 = Sunday. Absent or empty means every day.
       *
       * Without this a "Monday morning open-up" routine also fires on Sunday, and a routine that
       * goes off on a day off is a routine somebody switches off.
       */
      days?: number[];
    };

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
  const match = /^(\d{2}):(\d{2})$/.exec(schedule.time);
  if (!match) throw new RoutineError("Time must be HH:MM.", 400);
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
  throw new RoutineError("That schedule never comes round.", 400);
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
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule.time);
    if (!match) {
      throw new RoutineError("The daily time must be HH:MM.", 400);
    }
    const timeZone = schedule.timeZone ?? "UTC";
    if (!isKnownTimeZone(timeZone)) {
      throw new RoutineError(
        `This machine does not know the zone "${timeZone}".`,
        400,
      );
    }
    const days = [...new Set(schedule.days ?? [])].sort((a, b) => a - b);
    if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new RoutineError("Days must be 0 (Sunday) to 6.", 400);
    }
    // Every day and no days would be the same stored value; refusing the empty selection keeps
    // "runs every day" from being something a person can arrive at by unticking everything.
    if (schedule.days !== undefined && days.length === 0) {
      throw new RoutineError("Pick at least one day.", 400);
    }
    return { kind: "daily", time: schedule.time, timeZone, days };
  }
  throw new RoutineError("The schedule must be interval or daily.", 400);
}

/**
 * A routine row as the API may publish it.
 *
 * `.returning()` hands back `integer[]` columns as `{ "0": 1, "1": 3 }` where a plain SELECT of the
 * same row gives `[1, 3]` — verified against the live server, and the reason the create response
 * and the list disagreed about the same routine's days. Normalised here, once, for every row that
 * leaves the service.
 */
function published<Row extends { dailyDays: unknown }>(row: Row): Row {
  const days = row.dailyDays;
  const dailyDays = Array.isArray(days)
    ? days
    : days && typeof days === "object"
      ? Object.values(days as Record<string, number>)
      : null;
  return { ...row, dailyDays };
}

function scheduleOf(row: typeof lafRoutines.$inferSelect): RoutineSchedule {
  if (row.scheduleKind !== "daily") {
    return { kind: "interval", minutes: row.intervalMinutes ?? 60 };
  }
  return {
    kind: "daily",
    time: row.dailyUtc ?? "07:30",
    // A row written before zones existed meant UTC, because that is what it did.
    timeZone: row.dailyTimeZone ?? "UTC",
    days: row.dailyDays ?? [],
  };
}

export type RoutineServiceOptions = {
  database: Database;
  /** The same loader the runtime and the coworker call use, scoped to the routine's creator. */
  resolveAgents: (actor: AgentActor) => Promise<Record<string, AbstractAgent>>;
  auditStore?: AuditStore;
  /**
   * The run ledger, so scheduled work is visible while it happens.
   *
   * Optional, and every call is `.catch`ed: a routine that ran and answered must not be reported as
   * failed because a bookkeeping row could not be written.
   */
  ledger?: RunLedger;
  /**
   * Where a routine's answer goes so a person finds it without going to look.
   *
   * Optional and caught, like the ledger: the run happened, and a delivery that fails must not turn
   * a successful morning routine into a reported failure.
   */
  deliver?: DeliverRoutineAnswer;
  /**
   * The Bot's tools, assembled per run — the same gateway and grants the browser goes through.
   *
   * Absent, a routine runs as it always did: toolless, able to think and not to look. Present, it
   * is an agent turn. See runner/unattended.ts for why the loop lives on the server.
   */
  tools?: (
    botId: string,
    actor: ActionActor,
    actorLabel: string,
  ) => Promise<UnattendedToolkit>;
  now?: () => Date;
  runTimeoutMs?: number;
};

export function createRoutineService(options: RoutineServiceOptions) {
  const { database } = options;
  const now = options.now ?? (() => new Date());
  const runTimeoutMs = options.runTimeoutMs ?? ROUTINE_RUN_TIMEOUT_MS;
  let timer: ReturnType<typeof setInterval> | undefined;

  /**
   * One unattended run per Bot at a time.
   *
   * The tick is sequential, but Run now is not the tick, and two routines can name the same Bot.
   * With one shared computer, two tool loops on one Bot drive one browser at once — each one's
   * snapshot goes stale under the other, and a click meant for one page lands on the other's.
   * A promise chain per Bot makes the second wait for the first; it costs nothing when there is
   * no second.
   */
  const inFlight = new Map<string, Promise<void>>();
  function execute(row: typeof lafRoutines.$inferSelect): Promise<void> {
    const previous = inFlight.get(row.agentId) ?? Promise.resolve();
    const run = previous.then(() => executeNow(row));
    inFlight.set(
      row.agentId,
      run.catch(() => {}),
    );
    return run.finally(() => {
      if (inFlight.get(row.agentId) === run) inFlight.delete(row.agentId);
    });
  }

  async function executeNow(row: typeof lafRoutines.$inferSelect) {
    const startedAt = now();
    const runId = randomUUID();
    let ok = false;
    let answer = "";
    let failure = "";
    let steps: UnattendedRunResult["steps"] | null = null;
    /*
     * OPEN THE LEDGER FIRST, so the Bot reads as busy for the whole time it is busy.
     *
     * `laf_routine_runs` below is written once, at the end, with both timestamps — a receipt, not a
     * record. While a routine ran there was nothing anywhere saying so, which is why the roster
     * could not show scheduled work in progress. This row exists from here to the `finally`.
     */
    const ledgerRunId = await options.ledger
      ?.begin({
        agentId: row.agentId,
        userId: row.createdById,
        origin: "routine",
        label: row.name,
      })
      .catch(() => null);
    try {
      const agents = await options.resolveAgents({
        id: row.createdById,
        role: row.createdByRole === "admin" ? "admin" : "user",
      });
      const target = agents[row.agentId];
      if (!target) {
        throw new Error(`The Bot "${row.agentId}" is no longer in the roster.`);
      }
      if (options.tools) {
        const actor: ActionActor = {
          id: row.createdById,
          // The local actor is not a row in `users`, and the audit table has a foreign key to it.
          ...(row.createdById === DEV_ACTOR.id
            ? {}
            : { userId: row.createdById }),
        };
        const toolkit = await options.tools(
          row.agentId,
          actor,
          row.createdById,
        );
        const run = await runUnattended(target, row.instruction, {
          toolkit,
          timeoutMs: runTimeoutMs,
        });
        answer = run.answer;
        steps = run.steps;
        /*
         * A run that stopped because a person is needed is not a failure — the Bot did its job,
         * which was to find out — but the person has to be told, and a routine's answer is the one
         * place they will read it.
         */
        if (run.awaiting) {
          answer = `${answer}\n\n⏸ ${run.awaiting}`.trim();
        }
      } else {
        answer = await runAgentOnce(target, row.instruction, runTimeoutMs);
      }
      ok = true;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      // A failed loop still took its turns; they are the record of how far it got.
      if (error instanceof UnattendedRunError) steps = error.steps;
    }

    if (ok && answer.trim().length > 0) {
      try {
        await options.deliver?.({
          agentId: row.agentId,
          userId: row.createdById,
          routineName: row.name,
          answer,
          at: now(),
        });
      } catch (error) {
        console.error("[routines] delivering the answer failed:", error);
      }
    }

    if (ledgerRunId) {
      // Closed before anything else, so a failure writing the routine's own history cannot leave
      // the Bot looking busy forever.
      await options.ledger
        ?.finish(ledgerRunId, ok ? null : failure)
        .catch(() => {});
    }

    await database.insert(lafRoutineRuns).values({
      id: runId,
      routineId: row.id,
      startedAt,
      finishedAt: now(),
      ok,
      answer: ok ? answer : null,
      error: ok ? null : failure,
      steps,
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
        // Shown once, in the create response, and kept only as a hash. See the schema note.
        const triggerToken = randomBytes(24).toString("base64url");
        const [row] = await transaction
          .insert(lafRoutines)
          .values({
            id: `routine_${randomUUID()}`,
            triggerTokenHash: hashToken(triggerToken),
            agentId: input.agentId,
            name,
            instruction,
            scheduleKind: schedule.kind,
            intervalMinutes:
              schedule.kind === "interval" ? schedule.minutes : null,
            dailyUtc: schedule.kind === "daily" ? schedule.time : null,
            dailyTimeZone:
              schedule.kind === "daily" ? (schedule.timeZone ?? "UTC") : null,
            dailyDays: schedule.kind === "daily" ? (schedule.days ?? []) : null,
            enabled: true,
            createdById: actor.id,
            createdByRole: actor.role,
            nextRunAt: nextRunAt(schedule, at),
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        if (!row)
          throw new RoutineError("The routine could not be created.", 409);
        return { ...published(row), triggerToken };
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
        return published(rearmed ?? row);
      }
      return published(row);
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

    /**
     * A webhook firing the routine, authenticated by its token alone.
     *
     * No session, because the caller is a machine. The payload, if the sender attached one, rides
     * into the run appended to the instruction — "summarize what just happened" needs the what —
     * bounded so a firehose sender cannot buy a novel-length prompt with one POST.
     */
    async trigger(id: string, token: string, payload?: string) {
      const [row] = await database
        .select()
        .from(lafRoutines)
        .where(eq(lafRoutines.id, id));
      // One answer for a missing routine and a wrong token: a prober must not be able to tell
      // which of the two it guessed.
      if (!row?.triggerTokenHash || hashToken(token) !== row.triggerTokenHash) {
        throw new RoutineError("There is no such trigger.", 404);
      }
      if (!row.enabled) return { ran: false, reason: "disabled" as const };

      const at = now();
      if (
        row.lastRunAt &&
        at.getTime() - row.lastRunAt.getTime() < TRIGGER_DEBOUNCE_MS
      ) {
        return { ran: false, reason: "debounced" as const };
      }

      const next = nextRunAt(scheduleOf(row), at);
      const [claimed] = await database
        .update(lafRoutines)
        .set({ nextRunAt: next, lastRunAt: at, updatedAt: at })
        .where(
          and(
            eq(lafRoutines.id, row.id),
            eq(lafRoutines.enabled, true),
            // The same fence the tick uses: whoever moves lastRunAt first wins, so a webhook burst
            // racing itself, or racing the clock, still buys one run.
            row.lastRunAt
              ? eq(lafRoutines.lastRunAt, row.lastRunAt)
              : isNull(lafRoutines.lastRunAt),
          ),
        )
        .returning();
      if (!claimed) return { ran: false, reason: "debounced" as const };

      const trimmed = payload?.slice(0, TRIGGER_PAYLOAD_LIMIT).trim();
      await execute(
        trimmed
          ? {
              ...claimed,
              instruction: `${claimed.instruction}\n\n[Trigger payload]\n${trimmed}`,
            }
          : claimed,
      );
      return { ran: true as const };
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
