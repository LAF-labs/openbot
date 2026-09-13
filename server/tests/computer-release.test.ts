import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { ComputerClient } from "../src/computer/client";
import { releaseComputerFor } from "../src/computer/release";

/**
 * What happens to a deleted Bot's computer, as the audit trail records it (audit A3, 2026-09-10).
 *
 * The release resets the deleted Bot's computer — closing its browser and deleting its profile —
 * and writes the same `computer.reset` row the reset button writes, or a `computer.reset_failed`
 * row when the computer could not be reached, so the trail never shows a deleted Bot without saying
 * what became of its logins. It never throws: the Bot is already gone from the roster.
 */
function fakeAudit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { store, rows };
}

function clientReset(onReset: (botId: string) => void, fail = false) {
  const client = {
    forBot(botId: string) {
      return {
        async resetComputer() {
          onReset(botId);
          if (fail) throw new Error("the computer did not respond in time.");
          return { reset: true, botId };
        },
      };
    },
  } as unknown as ComputerClient;
  return client;
}

const ACTOR = { id: "owner-user", role: "user" as const };
const DEV = { id: "dev-local-user", role: "admin" as const };

describe("releasing a deleted Bot's computer", () => {
  test("resets the named Bot and records it", async () => {
    const reset: string[] = [];
    const { store, rows } = fakeAudit();
    const release = releaseComputerFor(
      clientReset((id) => reset.push(id)),
      store,
    );

    await release("agent_7", ACTOR);

    // The reset was addressed as the Bot being deleted, which is what the profile keys on.
    expect(reset).toEqual(["agent_7"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.reset");
    expect(rows[0]?.targetId).toBe("agent_7");
    expect(rows[0]?.actorUserId).toBe("owner-user");
  });

  test("a computer that cannot be reached is recorded, not thrown", async () => {
    const { store, rows } = fakeAudit();
    const release = releaseComputerFor(
      clientReset(() => undefined, true),
      store,
    );

    await expect(release("agent_9", ACTOR)).resolves.toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.reset_failed");
    expect(rows[0]?.targetId).toBe("agent_9");
  });

  test("no computer configured is a no-op, with no row", async () => {
    const { store, rows } = fakeAudit();
    const release = releaseComputerFor(undefined, store);

    await expect(release("agent_1", ACTOR)).resolves.toBeUndefined();
    expect(rows).toEqual([]);
  });

  test("the local development actor stays out of the audit foreign key", async () => {
    // Same rule the gateway follows: the fixture is not a person, so its id does not become the
    // actor of a row that has a foreign key to `users`.
    const { store, rows } = fakeAudit();
    const release = releaseComputerFor(
      clientReset(() => undefined),
      store,
    );

    await release("agent_3", DEV);
    expect(rows[0]?.actorUserId).toBeUndefined();
    expect(rows[0]?.payload.actor).toBe("dev-local-user");
  });
});
