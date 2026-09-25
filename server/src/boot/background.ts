import { createRetentionJob } from "../account/retention";
import type { Database } from "../db/client";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import type { NotificationOutbox } from "../notifications/outbox";
import type { BuiltInSkillsRuntime } from "../plugins/built-in-skill-sync";
import type { PublicDataRuntime } from "../plugins/public-data-rest";
import type { PluginStore } from "../plugins/store";
import type { RoutineService } from "../routines/service";

/** A minute is the finest grain a routine is ever due at. */
const ROUTINE_TICK_MS = 60_000;

/**
 * SIX HOURS, NOT TWENTY-FOUR. A day-long interval on a machine that is restarted most days is a
 * sweep that never runs — the timer is reset by every boot and never reaches its deadline. Six
 * hours means the deployment prunes even if somebody redeploys twice a day, and the work is a
 * handful of deletes against an indexed timestamp.
 */
const RETENTION_SWEEP_MS = 6 * 60 * 60_000;

/** How often withdrawals the fleet has not taken yet are offered again. */
const FLEET_REDELIVERY_MS = 5 * 60_000;

/**
 * What this process does on its own once the port is open: on a clock, and once at boot.
 *
 * All of it on in-process timers, because there is one process on one VM
 * (docs/laf/deployment-model.md) and nothing to install. The timers die with the process; a run in
 * flight is reconciled to `unknown` by the next boot (runner/laf-runner.ts).
 */
export function startBackgroundWork(input: {
  database: Database;
  routines: Pick<RoutineService, "start">;
  /** Days of trail to keep. Zero switches the sweep off, tick included. */
  auditRetentionDays: number;
  /** Present only with a fleet webhook: on a laptop there is nothing to tell. */
  fleetOutbox: Pick<NotificationOutbox, "redeliver"> | undefined;
  publicData: Pick<PublicDataRuntime, "reconcile">;
  /** The package's skills. Optional so a boot without a package, a test's, starts without them. */
  builtInSkills?: Pick<BuiltInSkillsRuntime, "reconcile">;
  pluginStore: PluginStore;
}): void {
  /*
   * The routine clock. A minute is the finest grain a routine is ever due at — schedules are
   * wall-clock times, not intervals — so a shorter tick would only mean more queries finding
   * nothing. It was once shared with the watch poller's tick, which is gone.
   */
  input.routines.start(ROUTINE_TICK_MS);

  /*
   * The retention sweep, on the same shape of clock as the routine tick and for the same reason: one
   * process on one VM, and nothing to install. Once now, then every six hours.
   *
   * `AUDIT_RETENTION_DAYS=0` switches it off, tick included, and then nothing here is scheduled at all.
   */
  const retention = createRetentionJob({
    database: input.database,
    days: input.auditRetentionDays,
    log: (message) => log.info("retention", { message }),
  });
  void retention.runOnce().catch((error) => {
    log.warn("retention_first_sweep_failed", {
      reason: describeFailure(error),
    });
  });
  retention.start(RETENTION_SWEEP_MS);

  /*
   * Withdrawals the fleet has not taken yet, offered again.
   *
   * A withdrawal writes its notice into the outbox inside its own transaction and offers it at once
   * (account/deletion.ts); this is the rest of the retry. At boot, because a process that died between
   * a deletion's commit and its delivery left the row undelivered, and the point of the row is that a
   * restart picks it up. On a tick, because a fleet that was down should be caught up without waiting
   * for the next person to leave.
   */
  const fleetOutbox = input.fleetOutbox;
  if (fleetOutbox) {
    void fleetOutbox.redeliver();
    setInterval(
      () => void fleetOutbox.redeliver(),
      FLEET_REDELIVERY_MS,
    ).unref();
  }

  /*
   * The public-data entry, reconciled to the key this boot was given: the row, its two tools and a
   * grant on each for every Bot on the machine — or, with the key gone, every one of those taken
   * back. Once, at boot, because the key is fleet configuration and only changes with a restart.
   * Never fatal: a store that could not be written leaves the tools missing, which the log says.
   */
  void input.publicData.reconcile(input.pluginStore, "deployment");
  // The package's skills, the same way: once, at boot, never fatal (built-in-skill-sync.ts).
  void input.builtInSkills?.reconcile(input.pluginStore, "deployment");
}
