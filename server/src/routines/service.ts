import type { AbstractAgent } from "@ag-ui/client";
import { and, eq, isNull } from "drizzle-orm";
import { resolveTimeZone } from "../../../shared/prompt";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import type { DeploymentAdmission } from "../auth/admission";
import { DEV_ACTOR } from "../auth/dev-actor";
import type { ActionActor } from "../computer/gateway";
import type { Database } from "../db/client";
import { lafRoutines } from "../db/schema";
import { log } from "../log";
import type { BotLane } from "../runner/bot-lane";
import type { WorkInFlight } from "../runner/in-flight";
import type { RunLedger } from "../runner/run-ledger";
import type { UnattendedToolkit } from "../runner/unattended";
import type { DeliverRoutineAnswer, DeliverRoutineFailure } from "./deliver";
import { RoutineError } from "./errors";
import { clearNotepad, readNotepad } from "./notepad";
import { mine } from "./ownership";
import {
  createRoutineRun,
  ROUTINE_RUN_TIMEOUT_MS,
  type RoutineRun,
} from "./run";
import { nextRunAt, scheduleOf } from "./schedule";
import {
  createRoutine,
  hashToken,
  listRoutines,
  listRuns,
  type RoutineChange,
  type RoutineInput,
  type RoutineStore,
  removeRoutine,
  resumeUnreadPaused,
  setRoutineEnabled,
  setRoutineKeepRunning,
  updateRoutine,
} from "./store";
import { createRoutineTicker } from "./ticker";
import { pauseUnreadRoutines } from "./unread";

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
 *   notepad.ts     where a routine left off: read at the run, written by its settlement, cleared here
 *   store.ts       made, listed, edited, paused and deleted, with the cap and the Bot check
 *   unread.ts      routines whose results pile up unread, paused before their next run
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
  catchUpGraceMs,
  nextRunAt,
  type RoutineSchedule,
} from "./schedule";
export {
  MAX_ROUTINES,
  type RoutineChange,
  type RoutineInput,
} from "./store";

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
  /**
   * The zone a new daily routine is written in when it names none: `config.botTimeZone`, the clock
   * every Bot is told the time in, so the "7시 반" a Bot heard is half past seven on that clock.
   *
   * Resolved as that clock is (`resolveTimeZone`): absent or unusable is Seoul, the Bot's own
   * default — never UTC, which is what a zoneless schedule used to be stored as (see
   * `parseSchedule`). Routines already stored keep the zone they have.
   */
  timeZone?: string;
  now?: () => Date;
  runTimeoutMs?: number;
  /**
   * One thing at a time per Bot, shared with every other server-side run path.
   *
   * Absent runs without serialisation, which is what a test that drives one routine wants.
   */
  lane?: BotLane;
  /**
   * Who this deployment still lets act (`auth/admission.ts`): a routine runs as its author, and an
   * author the sign-in list no longer admits is not run by any door — see `run.ts`.
   *
   * Optional in the TYPE for the suites that drive a routine and nothing else; `main.ts` always
   * passes it. A service without it runs every author, which is what a deployment did before
   * 2026-09-16.
   */
  admission?: Pick<DeploymentAdmission, "admitsPerson">;
  /**
   * Where each run is listed while it is claimed or running, so `모두 멈추기` reaches it (`run.ts`).
   * Absent in the suites that never stop a routine.
   */
  work?: WorkInFlight;
};

/** What firing a routine outside the clock needs: the table, the time, and the run. */
type Firing = {
  database: Database;
  now: () => Date;
  routine: RoutineRun;
};

export function createRoutineService(options: RoutineServiceOptions) {
  const { database } = options;
  const now = options.now ?? (() => new Date());
  const routine = createRoutineRun({
    ...options,
    now,
    runTimeoutMs: options.runTimeoutMs ?? ROUTINE_RUN_TIMEOUT_MS,
  });
  const store: RoutineStore = {
    database,
    now,
    timeZone: resolveTimeZone(options.timeZone),
  };
  const firing: Firing = { database, now, routine };
  const ticker = createRoutineTicker({
    database,
    auditStore: options.auditStore,
    now,
    execute: (row) => routine.run(row, "clock"),
    pauseUnread: (botIds, at) =>
      pauseUnreadRoutines({
        database,
        now: at,
        botIds,
        auditStore: options.auditStore,
        log: (message) => log.warn("routine_unread_sweep", { message }),
      }),
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

    /** Its name, what it says, when it runs — in place. See `updateRoutine`. */
    update(actor: AgentActor, id: string, change: RoutineChange) {
      return updateRoutine(store, actor, id, change);
    },

    /** 계속 돌리기 on one routine. See `setRoutineKeepRunning`. */
    setKeepRunning(actor: AgentActor, id: string, keepRunning: boolean) {
      return setRoutineKeepRunning(store, actor, id, keepRunning);
    },

    /** 다시 켜기 and 계속 돌리기 on one Bot's routines the unread rule paused. See `resumeUnreadPaused`. */
    resumePaused(
      actor: AgentActor,
      agentId: string,
      resume: { keepRunning: boolean },
    ) {
      return resumeUnreadPaused(store, actor, agentId, resume);
    },

    remove(actor: AgentActor, id: string) {
      return removeRoutine(store, actor, id);
    },

    /** What the routine noted for its next run. Scoped like its runs: a note is the routine's work. */
    async notepad(actor: AgentActor, id: string) {
      await mine(database, actor, id);
      const { entries, updatedAt } = await readNotepad(database, id);
      return { entries, updatedAt };
    },

    /** Empty the notepad, as its person asks. See `forgetNotepad`. */
    clearNotepad(actor: AgentActor, id: string) {
      return forgetNotepad(
        { database, now, auditStore: options.auditStore },
        actor,
        id,
      );
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

/**
 * A person emptying a routine's notepad, and the row that says they did.
 *
 * AUDITED, because clearing is a decision about what a Bot does next: the routine's next run starts
 * with no idea where the last one left off and may look at the same reviews again. "Why did it
 * answer yesterday's inquiries a second time" has to be answerable from the trail, with who pressed
 * it — and a clear that removed nothing is not a decision anybody made, so it writes no row.
 *
 * The row is written after the clear commits and its loss does not undo the clear: the notepad is
 * empty either way, and a person pressing the button again to get a row would be pressing it for
 * the trail's sake.
 */
async function forgetNotepad(
  store: { database: Database; now: () => Date; auditStore?: AuditStore },
  actor: AgentActor,
  id: string,
): Promise<{ cleared: number }> {
  const row = await mine(store.database, actor, id);
  const cleared = await clearNotepad(store.database, id, store.now());
  if (cleared > 0) {
    await store.auditStore
      ?.insert({
        eventType: "routine.notepad_cleared",
        targetType: "routine",
        targetId: id,
        // A fixture is not a person: it is named in the payload and never becomes the actor.
        ...(actor.id === DEV_ACTOR.id ? {} : { actorUserId: actor.id }),
        payload: {
          agentId: row.agentId,
          name: row.name,
          actor: actor.id,
          entries: cleared,
        },
      })
      .catch(() => {});
  }
  return { cleared };
}

async function runAheadOfTheClock(
  firing: Firing,
  actor: AgentActor,
  id: string,
): Promise<void> {
  const at = firing.now();
  const row = await mine(firing.database, actor, id);
  /*
   * Asked BEFORE the claim, and answered as a refusal. The person pressing is here and admitted —
   * the routine is on their Bot — but its author is not, and a button that answered "ran" and did
   * nothing is the control this product does not draw. Nothing moves: the clock is not the
   * button's to push for a run that is not going to happen.
   */
  if (!(await firing.routine.authorAdmitted(row, "run_now"))) {
    throw new RoutineError(
      "This routine was made by an account this deployment no longer admits, so it does not run.",
      409,
      "laf:routine_author_not_admitted",
    );
  }
  const next = nextRunAt(scheduleOf(row), at);
  const [claimed] = await firing.database
    .update(lafRoutines)
    .set({ nextRunAt: next, lastRunAt: at, updatedAt: at })
    .where(eq(lafRoutines.id, id))
    .returning();
  if (claimed) await firing.routine.run(claimed, "run_now");
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

  /*
   * Asked AFTER the claim, unlike "run now": the caller is a machine holding a token, it may retry
   * in a burst, and a declined window has to debounce like a run does or every retry writes another
   * row. The claim is what makes the skip row one per window, as it is on the clock. The sender is
   * told it did not run — a 202 here would be a receipt for nothing.
   */
  if (!(await firing.routine.authorAdmitted(claimed, "trigger"))) {
    return { ran: false, reason: "not_admitted" as const };
  }

  const trimmed = payload?.slice(0, TRIGGER_PAYLOAD_LIMIT).trim();
  /*
   * Claimed, and answered — the run goes on without the caller. A webhook sender gives a
   * receiver ten to thirty seconds and then retries; a run with tools takes a minute or ten.
   * Awaiting it here meant every real sender timed out on a run that was going fine, retried
   * into the debounce, and logged the routine as failing. The claim above is the receipt:
   * exactly one run was bought, and `finished` is it, for whoever (a test) needs to wait.
   */
  const finished = firing.routine
    .run(
      trimmed
        ? {
            ...claimed,
            instruction: `${claimed.instruction}\n\n[Trigger payload]\n${trimmed}`,
          }
        : claimed,
      "trigger",
    )
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error("[routines] a triggered run failed:", error);
    });
  return { ran: true as const, finished };
}
