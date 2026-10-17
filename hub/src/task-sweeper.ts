import { sql } from "drizzle-orm";
import { HUB_TASK_SWEEP_MS } from "../../shared/hub/protocol";
import type { Logger } from "../../shared/log";
import { recordAudit } from "./audit";
import type { HubDatabase } from "./db/client";
import { emitEvent, type Listeners } from "./events";
import { audienceOf } from "./visibility";

/** How many claims one sweep frees at most; the next minute takes the rest. */
const SWEEP_BATCH = 500;

/**
 * Frees every claim whose time ran out: the run that held it stopped beating — its VM died, slept
 * or lost the network — so the task goes back to `todo` for a run that is alive. One transaction,
 * one event per task freed, and a trail row naming the run that lost it.
 *
 * `skip locked`: a row another transaction holds is a heartbeat, a checkout or an edit in flight.
 * Waiting on it would hold the sweep up behind a person; freeing it from under a beat that is about
 * to commit would take the task from a run that is alive. It is looked at again next minute.
 *
 * A claim that ran out is also taken over by the next checkout without waiting for this (the
 * checkout's own WHERE), so the sweep is what puts the task back on the board for the people
 * looking at it, not what makes it takeable.
 */
export async function sweepExpiredTasks(
  database: HubDatabase,
): Promise<number> {
  return database.transaction(async (tx) => {
    const swept = await tx.execute<{
      id: string;
      visibility: string;
      run_id: string;
      by: string;
    }>(sql`
      with expired as (
        select id, checkout_run_id, checkout_by
          from hub_tasks
         where checkout_run_id is not null
           and lock_expires_at < now()
         order by lock_expires_at
         limit ${SWEEP_BATCH}
           for update skip locked
      )
      update hub_tasks t
         set checkout_run_id = null,
             checkout_by = null,
             lock_expires_at = null,
             stage = case when t.stage = 'doing' then 'todo' else t.stage end,
             version = t.version + 1,
             updated_at = now()
        from expired e
       where t.id = e.id
      returning t.id, t.visibility, e.checkout_run_id as run_id, e.checkout_by as by
    `);
    for (const row of swept) {
      await emitEvent(tx, {
        type: "task.changed",
        refId: row.id,
        visibleTo: await audienceOf(tx, row.visibility),
      });
      await recordAudit(tx, {
        action: "task.lock_expired",
        member: row.by,
        target: row.id,
        runId: row.run_id,
        outcome: "swept",
      });
    }
    return swept.length;
  });
}

/**
 * The sweep, every minute, in this process (the hub is one process, as a person's VM is).
 *
 * NOTHING ESCAPES THE TIMER. An exception out of an interval is an uncaught one, which
 * `reportCrashes` turns into the whole hub exiting — the reason the socket's ping is wrapped
 * (`socket.ts`, `startPings`). A database that is down for a minute is a warning and the next tick.
 * A tick that finds the last one still running skips, so a slow database never stacks sweeps.
 */
export function startTaskSweeper(input: {
  database: HubDatabase;
  listeners: Listeners;
  log: Logger;
  everyMs?: number;
}): { stop(): void; sweep(): Promise<void> } {
  let running: Promise<void> | null = null;
  const sweep = (): Promise<void> => {
    if (running) return running;
    running = sweepExpiredTasks(input.database)
      .then((freed) => {
        if (freed > 0) {
          input.log.info("tasks_swept", { freed });
          input.listeners.pokeAll();
        }
      })
      .catch((error: unknown) => {
        input.log.warn("task_sweep_failed", { error });
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const tick = setInterval(() => {
    try {
      void sweep();
    } catch (error) {
      input.log.warn("task_sweep_failed", { error });
    }
  }, input.everyMs ?? HUB_TASK_SWEEP_MS);
  return {
    stop: () => clearInterval(tick),
    sweep,
  };
}
