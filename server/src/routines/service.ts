import type { AbstractAgent } from "@ag-ui/client";
import { and, eq, isNull } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import type { ActionActor } from "../computer/gateway";
import type { Database } from "../db/client";
import { lafRoutines } from "../db/schema";
import type { BotLane } from "../runner/bot-lane";
import type { RunLedger } from "../runner/run-ledger";
import type { UnattendedToolkit } from "../runner/unattended";
import type { DeliverRoutineAnswer, DeliverRoutineFailure } from "./deliver";
import { RoutineError } from "./errors";
import { mine } from "./ownership";
import { createRoutineRun, ROUTINE_RUN_TIMEOUT_MS } from "./run";
import { nextRunAt, scheduleOf } from "./schedule";
import {
  createRoutine,
  hashToken,
  listRoutines,
  listRuns,
  type RoutineInput,
  type RoutineStore,
  removeRoutine,
  setRoutineEnabled,
} from "./store";
import { createRoutineTicker } from "./ticker";

/**
 * Routines: an instruction, a Bot, and a clock.
 *
 * See the schema note in db/schema/laf.ts for what a routine is and why the claim is a conditional
 * UPDATE. This module is the door every caller uses — the routes, the suggestions, the process
 * that starts the clock — and the rest of the directory is what stands behind it:
 *
 *   schedule.ts    when a routine fires next, and the catch-up grace (pure)
 *   ticker.ts      the clock: claim what is due, run it, catch it up or let it go
 *   run.ts         one run: the ledger opened, the Bot asked, the answer carried forward
 *   settlement.ts  the run's record in one transaction — delivery, `[SILENT]`, receipt, ledger
 *   run-report.ts  the `routine.ran` trail row a failed run's notification is raised from
 *   receipts.ts    `laf_routine_runs`: what was reported, the newest few kept
 *   store.ts       made, listed, paused and deleted, with the cap and the Bot check
 *   ownership.ts   whose routine it is
 *   errors.ts      what a refusal carries
 *
 * Run now and the webhook live here: both fire a routine outside the clock.
 */

export { RoutineError } from "./errors";
export { ROUTINE_RUN_TIMEOUT_MS } from "./run";
export {
  CATCH_UP_GRACE_MAX_MS,
  CATCH_UP_GRACE_MIN_MS,
  CAUGHT_UP_AFTER_MS,
  catchUpGraceMs,
  MIN_INTERVAL_MINUTES,
  nextRunAt,
  type RoutineSchedule,
} from "./schedule";
export { MAX_ROUTINES, type RoutineInput } from "./store";

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
   * Where a run that did not finish is marked, so the person finds out where they would have read
   * the answer. Optional and caught, like `deliver`: the failure is already recorded, and a mark
   * that could not be written must not hide the record of it.
   */
  deliverFailure?: DeliverRoutineFailure;
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

/** What firing a routine outside the clock needs: the table, the time, and the run. */
type Firing = {
  database: Database;
  now: () => Date;
  execute: (row: typeof lafRoutines.$inferSelect) => Promise<void>;
};

export function createRoutineService(options: RoutineServiceOptions) {
  const { database } = options;
  const now = options.now ?? (() => new Date());
  const execute = createRoutineRun({
    ...options,
    now,
    runTimeoutMs: options.runTimeoutMs ?? ROUTINE_RUN_TIMEOUT_MS,
  });
  const store: RoutineStore = { database, now };
  const firing: Firing = { database, now, execute };
  const ticker = createRoutineTicker({
    database,
    auditStore: options.auditStore,
    now,
    execute,
  });

  return {
    create(actor: AgentActor, input: RoutineInput) {
      return createRoutine(store, actor, input);
    },

    list(actor: AgentActor) {
      return listRoutines(store, actor);
    },

    runs(actor: AgentActor, routineId: string) {
      return listRuns(store, actor, routineId);
    },

    setEnabled(actor: AgentActor, id: string, enabled: boolean) {
      return setRoutineEnabled(store, actor, id, enabled);
    },

    remove(actor: AgentActor, id: string) {
      return removeRoutine(store, actor, id);
    },

    /** Run one routine now, ahead of its clock. The claim still applies, so a due tick cannot double it. */
    runNow(actor: AgentActor, id: string) {
      return runAheadOfTheClock(firing, actor, id);
    },

    /** A webhook firing the routine, authenticated by its token alone. See `fireByWebhook`. */
    trigger(id: string, token: string, payload?: string) {
      return fireByWebhook(firing, id, token, payload);
    },

    tick: ticker.tick,

    start(tickMs: number) {
      ticker.start(tickMs);
    },

    stop() {
      ticker.stop();
    },
  };
}

export type RoutineService = ReturnType<typeof createRoutineService>;

async function runAheadOfTheClock(
  firing: Firing,
  actor: AgentActor,
  id: string,
): Promise<void> {
  const at = firing.now();
  const row = await mine(firing.database, actor, id);
  const next = nextRunAt(scheduleOf(row), at);
  const [claimed] = await firing.database
    .update(lafRoutines)
    .set({ nextRunAt: next, lastRunAt: at, updatedAt: at })
    .where(eq(lafRoutines.id, id))
    .returning();
  if (claimed) await firing.execute(claimed);
}

/**
 * A webhook firing the routine, authenticated by its token alone.
 *
 * No session, because the caller is a machine. The payload, if the sender attached one, rides
 * into the run appended to the instruction — "summarize what just happened" needs the what —
 * bounded so a firehose sender cannot buy a novel-length prompt with one POST.
 */
async function fireByWebhook(
  firing: Firing,
  id: string,
  token: string,
  payload?: string,
) {
  const { database } = firing;
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

  const at = firing.now();
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
  const finished = firing
    .execute(
      trimmed
        ? {
            ...claimed,
            instruction: `${claimed.instruction}\n\n[Trigger payload]\n${trimmed}`,
          }
        : claimed,
    )
    .catch((error: unknown) => {
      console.error("[routines] a triggered run failed:", error);
    });
  return { ran: true as const, finished };
}
