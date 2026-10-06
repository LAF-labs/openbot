import { describe, expect, test } from "bun:test";
import { startBackgroundWork } from "../src/boot/background";

/**
 * What the process starts on its own once the port is open — the routine clock, the retention
 * sweep, the fleet's redelivery and the public-data reconciliation — as `main.ts` hands it the
 * services. It was the tail of `main.ts` until 2026-09-14.
 */

type Input = Parameters<typeof startBackgroundWork>[0];

/** A database nothing may touch: with retention off, the sweep must not so much as ask. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error("the database was touched");
    },
  },
) as Input["database"];

/** Everything already queued has run: what a boot left for after its own return has happened. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function started(
  fleet: boolean,
  reconciled: Promise<void> = Promise.resolve(),
) {
  const calls: string[] = [];
  const pluginStore = {
    refreshShippedDefinitions: async () => {
      calls.push("shipped-definitions");
    },
  } as Input["pluginStore"];
  startBackgroundWork({
    database: untouchable,
    routines: { start: (tickMs) => calls.push(`routines:${tickMs}`) },
    auditRetentionDays: 0,
    fleetOutbox: fleet
      ? {
          redeliver: async () => {
            calls.push("fleet:redeliver");
            return 0;
          },
        }
      : undefined,
    deploymentKeys: {
      reconcile: (store, by) => {
        calls.push(`public-data:${store === pluginStore}:${by}`);
        return reconciled;
      },
    },
    pluginStore,
  });
  return calls;
}

describe("the work a boot starts", () => {
  test("a minute's routine clock, and the public-data entry reconciled once, as the deployment", async () => {
    const calls = started(false);
    await settled();
    expect(calls).toEqual([
      "routines:60000",
      "public-data:true:deployment",
      "shipped-definitions",
    ]);
  });

  test("with a fleet, the notices it has not taken are offered again at once", async () => {
    // And on a five-minute clock after that, unref'd so it never holds the process open.
    const calls = started(true);
    await settled();
    expect(calls).toEqual([
      "routines:60000",
      "fleet:redeliver",
      "public-data:true:deployment",
      "shipped-definitions",
    ]);
  });

  test("the definitions that ship with the build are brought up to it after the keys are reconciled, never beside it", async () => {
    // Both write the same rows for the entries the keys hold: a refresh that ran while the
    // reconciliation was still writing would read the last build's rows and accept them.
    let finish: () => void = () => undefined;
    const reconciled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const calls = started(false, reconciled);
    await settled();
    expect(calls).toEqual(["routines:60000", "public-data:true:deployment"]);

    finish();
    await settled();
    expect(calls).toEqual([
      "routines:60000",
      "public-data:true:deployment",
      "shipped-definitions",
    ]);
  });
});
