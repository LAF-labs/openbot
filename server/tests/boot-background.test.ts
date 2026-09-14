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

const pluginStore = {} as Input["pluginStore"];

function started(fleet: boolean) {
  const calls: string[] = [];
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
    publicData: {
      reconcile: async (store, by) => {
        calls.push(`public-data:${store === pluginStore}:${by}`);
      },
    },
    pluginStore,
  });
  return calls;
}

describe("the work a boot starts", () => {
  test("a minute's routine clock, and the public-data entry reconciled once, as the deployment", () => {
    expect(started(false)).toEqual([
      "routines:60000",
      "public-data:true:deployment",
    ]);
  });

  test("with a fleet, the notices it has not taken are offered again at once", () => {
    // And on a five-minute clock after that, unref'd so it never holds the process open.
    expect(started(true)).toEqual([
      "routines:60000",
      "fleet:redeliver",
      "public-data:true:deployment",
    ]);
  });
});
