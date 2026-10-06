import { describe, expect, test } from "bun:test";
import { startBackgroundWork } from "../src/boot/background";
import { recentLines } from "../src/log";

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
  /** Servers added by address under a name the deployment keeps, as the store would find them. */
  held: () => Promise<string[]> = async () => [],
) {
  const calls: string[] = [];
  const pluginStore = {
    refreshShippedDefinitions: async () => {
      calls.push("shipped-definitions");
    },
    reservedNamesHeld: held,
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

  /*
   * A SERVER ALREADY ADDED BY ADDRESS UNDER A NAME THE DEPLOYMENT NOW KEEPS (`workbench`, since a
   * script's run is recorded under `mcp__workbench__run_script`). It is not stopped and not
   * renamed; a boot says it is there, because the release that offers a tool of the deployment's
   * own under that name is the day a model would be handed two tools of one name.
   */
  test("a server held under a name the deployment keeps is said once, with what to do — and nothing is said where there is none", async () => {
    const said = async (held: () => Promise<string[]>) => {
      const before = recentLines.lines().length;
      started(false, Promise.resolve(), held);
      await settled();
      return recentLines
        .lines()
        .slice(before)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => String(line.event).includes("reserved"));
    };

    const [line, ...rest] = await said(async () => ["workbench"]);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      level: "warn",
      event: "custom_server_holds_reserved_name",
      servers: ["workbench"],
    });
    expect(String(line?.note)).toContain("remove it");

    expect(await said(async () => [])).toEqual([]);

    // A boot that could not look says that, and still boots.
    const [unread] = await said(async () => {
      throw new Error("the table is not there");
    });
    expect(unread).toMatchObject({
      level: "warn",
      event: "reserved_server_names_not_read",
    });
  });
});
