import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import {
  asc,
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
} from "drizzle-orm";
import { runAgentOnce } from "../agents/coworker-call";
import type { BotLane } from "../runner/bot-lane";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import type { ActionActor } from "../computer/gateway";
import type { Database } from "../db/client";
import { agentProfiles, lafRoutineRuns, lafRoutines } from "../db/schema";
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

/**
 * Twenty routines per account. A wall against runaway creation, not a pricing tier.
 *
 * Per account, counted by who made them. It counted the whole table, which on a VM a shop owner
 * shares with their staff means the first person to make twenty routines stops everybody else from
 * making one — a limit that reads as somebody else's mistake.
 */
export const MAX_ROUTINES = 20;

/**
 * How late a routine may be and still run.
 *
 * `nextRunAt` in the past fires at the first tick, however long ago it passed. That is right for a
 * server that was down for four minutes and wrong for one that was down overnight: the 07:30
 * open-up briefing arriving at 09:00 is not a briefing, it is a Bot answering a question about a
 * morning that is over, and an hourly monitor that missed six windows should not deliver six
 * verdicts at once when the machine comes back.
 *
 * An hour, because that is roughly the span in which "it is late" is still the same piece of work.
 * Past it the window is skipped, recorded as `routine.skipped` with how late it was, and the clock
 * moves to the next one — skipped, never queued.
 */
export const MISSED_WINDOW_MS = 60 * 60_000;

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

/**
 * What a routine call refused, as a status, a code and a sentence.
 *
 * The code is the part a surface may read. English prose from the server reaching a Korean screen
 * is the thing this deployment does not do — the server sends facts and the surface owns the words
 * (see `MODEL_FAILURES` in app/src/lib/copilot/stopped-turn.ts for the same shape) — so the two
 * refusals a person can actually provoke carry one. The sentence stays for operators and for logs.
 */
export class RoutineError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RoutineError";
  }
}

/**
 * A routine that is not this person's does not exist, as far as they can tell.
 *
 * 404 rather than 403, and the choice follows `agents/routes.ts`: a Bot somebody cannot see is an
 * `AgentNotFoundError` and answers 404, and 403 there is reserved for a resource they CAN see and
 * may not change — a public Bot they do not own, or one a package shipped. A routine has no public
 * visibility, so the second case has no routine equivalent and every refusal here is the first one.
 * This file already argued it for the webhook: one answer for a missing routine and a wrong token,
 * so a prober cannot tell which of the two it guessed.
 */
const noSuchRoutine = () =>
  new RoutineError("There is no such routine.", 404, "laf:routine_not_found");

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
/**
 * Every column of a routine except the one that is a capability.
 *
 * `triggerTokenHash` is the SHA-256 of the webhook token, and `SELECT *` was handing it to the
 * roster: a hash is not the token, but it is the material for guessing one offline and it is on a
 * screen that has no use for it. The list is the projection rather than a delete-after-select so a
 * column added to the table has to be named here before it can leave the deployment.
 */
const publishedColumns = {
  id: lafRoutines.id,
  agentId: lafRoutines.agentId,
  name: lafRoutines.name,
  instruction: lafRoutines.instruction,
  scheduleKind: lafRoutines.scheduleKind,
  intervalMinutes: lafRoutines.intervalMinutes,
  dailyUtc: lafRoutines.dailyUtc,
  dailyTimeZone: lafRoutines.dailyTimeZone,
  dailyDays: lafRoutines.dailyDays,
  enabled: lafRoutines.enabled,
  createdById: lafRoutines.createdById,
  createdByRole: lafRoutines.createdByRole,
  nextRunAt: lafRoutines.nextRunAt,
  lastRunAt: lafRoutines.lastRunAt,
  createdAt: lafRoutines.createdAt,
  updatedAt: lafRoutines.updatedAt,
};

/** The same, for a row that arrived whole: `.returning()` has no projection to apply. */
function withoutTokenHash<Row extends { triggerTokenHash?: unknown }>(
  row: Row,
): Omit<Row, "triggerTokenHash"> {
  const { triggerTokenHash: _hash, ...rest } = row;
  return rest;
}

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
  tools?: (botId: string, actor: ActionActor) => Promise<UnattendedToolkit>;
  now?: () => Date;
  runTimeoutMs?: number;
  /**
   * One thing at a time per Bot, shared with every other server-side run path.
   *
   * Absent runs without serialisation, which is what a test that drives one routine wants.
   */
  lane?: BotLane;
};

/**
 * How much of the last run's answer rides into the next one.
 *
 * Enough for a morning briefing or a monitor's last verdict; short enough that a routine whose
 * answer is a wall of text cannot spend the whole window on its own past. Cut with a mark, like
 * every other bound in this deployment, so the model reads it as an excerpt rather than as
 * everything that was said.
 */
const CARRIED_ANSWER_MAX_CHARS = 1_500;

/**
 * What the Bot is told about the last time this routine ran.
 *
 * WHY THIS EXISTS. A routine is repeated work by definition, and a routine that cannot remember
 * repeating it is the failure the whole feature walks into: the 8am briefing reports Tuesday's
 * three orders again on Wednesday, the monitor announces the same outage every hour, and the
 * person learns to stop reading. The answers were already in `laf_routine_runs` — every run writes
 * one — and nothing was reading them back.
 *
 * The instruction stays the person's. This is appended after it, as context and not as an order,
 * because a standing instruction that quietly grew a paragraph nobody wrote is a routine that no
 * longer does what its author can see it doing.
 */
const carriedInstruction = (instruction: string, previous: string): string =>
  `${instruction}\n\nWhat you reported the last time this routine ran, so you can say what has changed and not repeat it:\n\n${previous}`;

export function createRoutineService(options: RoutineServiceOptions) {
  const { database } = options;
  const now = options.now ?? (() => new Date());
  const runTimeoutMs = options.runTimeoutMs ?? ROUTINE_RUN_TIMEOUT_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  /**
   * Which routines this person may see and act on, as a WHERE clause.
   *
   * The rule is `canManageAgent`'s (agents/profile-policy.ts) carried across: whoever can manage
   * the Bot can manage the routines that drive it. So a routine is yours if you wrote it, or if the
   * Bot it names is yours, and an administrator reaches all of them — the same three cases, in the
   * same order, that decide a Bot.
   *
   * The Bot's owner and not only the author, because a routine outlives the person who typed it:
   * staff leave, and a shop owner locked out of the routines running on their own Bot has no way in
   * that is not an administrator. `agent_id` is not a foreign key yet, so a routine naming a Bot
   * that no longer exists matches nobody by that half and stays with its author.
   */
  function scopeOf(actor: AgentActor) {
    if (actor.role === "admin") return undefined;
    return or(
      eq(lafRoutines.createdById, actor.id),
      inArray(
        lafRoutines.agentId,
        database
          .select({ agentId: agentProfiles.agentId })
          .from(agentProfiles)
          .where(
            and(
              eq(agentProfiles.ownerUserId, actor.id),
              isNull(agentProfiles.deletedAt),
            ),
          ),
      ),
    );
  }

  /** One routine, if it is this person's. Anything else did not exist; see `noSuchRoutine`. */
  async function mine(actor: AgentActor, id: string) {
    const [row] = await database
      .select()
      .from(lafRoutines)
      .where(and(eq(lafRoutines.id, id), scopeOf(actor)));
    if (!row) throw noSuchRoutine();
    return row;
  }

  /**
   * One unattended run per Bot at a time.
   *
   * The tick is sequential, but Run now is not the tick, and two routines can name the same Bot.
   * With one shared computer, two tool loops on one Bot drive one browser at once — each one's
   * snapshot goes stale under the other, and a click meant for one page lands on the other's.
   * A promise chain per Bot makes the second wait for the first; it costs nothing when there is
   * no second.
   */
  function execute(row: typeof lafRoutines.$inferSelect): Promise<void> {
    /*
     * One unattended run per Bot at a time, through the lane every server-side path shares.
     *
     * The tick is sequential, but Run now is not the tick, a room turn is not either, and any two
     * of those can name the same Bot. With one shared computer, two tool loops on one Bot drive one
     * browser at once — each one's snapshot goes stale under the other, and a click meant for one
     * page lands on the other's. A queue private to this service would not have seen the room.
     */
    return options.lane
      ? options.lane.run(row.agentId, () => executeNow(row))
      : executeNow(row);
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

      /*
       * The last thing this routine actually reported, read back out of its own receipts.
       *
       * Only a run that SUCCEEDED and said something: a failure is not what the person was told,
       * and carrying it forward would have the next run answer a question about an error message.
       * Read here rather than held in memory because a routine outlives any process that runs it.
       */
      const [last] = await database
        .select({ answer: lafRoutineRuns.answer })
        .from(lafRoutineRuns)
        .where(
          and(
            eq(lafRoutineRuns.routineId, row.id),
            eq(lafRoutineRuns.ok, true),
          ),
        )
        .orderBy(desc(lafRoutineRuns.startedAt))
        .limit(1);
      const previous = (last?.answer ?? "").trim();
      const instruction = previous
        ? carriedInstruction(
            row.instruction,
            previous.length > CARRIED_ANSWER_MAX_CHARS
              ? `${previous.slice(0, CARRIED_ANSWER_MAX_CHARS)}\n\n[truncated]`
              : previous,
          )
        : row.instruction;

      if (options.tools) {
        const actor: ActionActor = {
          id: row.createdById,
          // The local actor is not a row in `users`, and the audit table has a foreign key to it.
          ...(row.createdById === DEV_ACTOR.id
            ? {}
            : { userId: row.createdById }),
        };
        const toolkit = await options.tools(row.agentId, actor);
        const run = await runUnattended(target, instruction, {
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
        answer = await runAgentOnce(target, instruction, runTimeoutMs);
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
      return await tickOnce();
    } finally {
      ticking = false;
    }
  }

  async function tickOnce(): Promise<number> {
    const at = now();
    const due = await database
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

      /*
       * How late this window is, measured against the moment it was supposed to fire — `row`, not
       * `claimed`, because the claim above has already moved the clock to the next one.
       *
       * The claim is what makes the skip safe to record: exactly one pass takes the row, so exactly
       * one `routine.skipped` is written, and the routine leaves this loop armed for the next window
       * either way. `lastRunAt` moves too, which is the truthful reading — the scheduler did look at
       * this routine, and the tick's own debounce should treat it as attended to.
       */
      const lateBy = at.getTime() - row.nextRunAt.getTime();
      if (lateBy > MISSED_WINDOW_MS) {
        try {
          await options.auditStore?.insert({
            eventType: "routine.skipped",
            targetType: "routine",
            targetId: row.id,
            payload: {
              agentId: row.agentId,
              name: row.name,
              lateByMinutes: Math.round(lateBy / 60_000),
              missed: row.nextRunAt.toISOString(),
            },
          });
        } catch {
          // Losing the audit row must not turn a skip into a run.
        }
        continue;
      }

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
        // This person's routines, not the deployment's. See MAX_ROUTINES.
        const [held] = await transaction
          .select({ count: count() })
          .from(lafRoutines)
          .where(eq(lafRoutines.createdById, actor.id));
        if (Number(held?.count ?? 0) >= MAX_ROUTINES) {
          throw new RoutineError(
            `This account holds ${MAX_ROUTINES} routines already. Delete one to make room.`,
            409,
            "laf:routine_cap_reached",
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
        // The token, once. Never its hash, which is the one column this row does not publish.
        return { ...published(withoutTokenHash(row)), triggerToken };
      });
    },

    async list(actor: AgentActor) {
      return database
        .select(publishedColumns)
        .from(lafRoutines)
        .where(scopeOf(actor))
        .orderBy(desc(lafRoutines.createdAt));
    },

    async runs(actor: AgentActor, routineId: string) {
      // Ownership before history: a run record carries the Bot's answer, which is the routine's
      // whole content, so reading somebody else's runs is reading their work.
      await mine(actor, routineId);
      return database
        .select()
        .from(lafRoutineRuns)
        .where(eq(lafRoutineRuns.routineId, routineId))
        .orderBy(desc(lafRoutineRuns.startedAt))
        .limit(KEPT_RUNS);
    },

    async setEnabled(actor: AgentActor, id: string, enabled: boolean) {
      await mine(actor, id);
      const at = now();
      const [row] = await database
        .update(lafRoutines)
        .set({ enabled, updatedAt: at })
        .where(eq(lafRoutines.id, id))
        .returning();
      if (!row) throw noSuchRoutine();
      if (enabled) {
        // Re-enabling re-arms the clock from now; a routine disabled for a week must not fire
        // seven times to catch up.
        const next = nextRunAt(scheduleOf(row), at);
        const [rearmed] = await database
          .update(lafRoutines)
          .set({ nextRunAt: next })
          .where(eq(lafRoutines.id, id))
          .returning();
        return published(withoutTokenHash(rearmed ?? row));
      }
      return published(withoutTokenHash(row));
    },

    async remove(actor: AgentActor, id: string) {
      // Checked before the runs are deleted, so a stranger's DELETE cannot destroy the history of a
      // routine it is then refused permission to remove.
      await mine(actor, id);
      await database
        .delete(lafRoutineRuns)
        .where(eq(lafRoutineRuns.routineId, id));
      const removed = await database
        .delete(lafRoutines)
        .where(eq(lafRoutines.id, id))
        .returning();
      if (removed.length === 0) throw noSuchRoutine();
    },

    /** Run one routine now, ahead of its clock. The claim still applies, so a due tick cannot double it. */
    async runNow(actor: AgentActor, id: string) {
      const at = now();
      const row = await mine(actor, id);
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
        throw new RoutineError(
          "There is no such trigger.",
          404,
          "laf:routine_not_found",
        );
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
      /*
       * Claimed, and answered — the run goes on without the caller. A webhook sender gives a
       * receiver ten to thirty seconds and then retries; a run with tools takes a minute or ten.
       * Awaiting it here meant every real sender timed out on a run that was going fine, retried
       * into the debounce, and logged the routine as failing. The claim above is the receipt:
       * exactly one run was bought, and `finished` is it, for whoever (a test) needs to wait.
       */
      const finished = execute(
        trimmed
          ? {
              ...claimed,
              instruction: `${claimed.instruction}\n\n[Trigger payload]\n${trimmed}`,
            }
          : claimed,
      ).catch((error: unknown) => {
        console.error("[routines] a triggered run failed:", error);
      });
      return { ran: true as const, finished };
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
