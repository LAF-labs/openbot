import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { ComputerClient } from "../src/computer/client";
import { releaseComputerFor } from "../src/computer/release";

/**
 * What happens to the computer when a Bot is deleted, as the audit trail records it.
 *
 * IT USED TO RESET THE PROFILE (audit A3, 2026-09-10), and this file used to pin that. It cannot any
 * more: since 2026-09-16 there is one browser profile per deployment and the logins on it are the
 * PERSON'S, shared by every Bot they have (`docs/laf/deployment-model.md`). Resetting here would sign
 * the other four out of 스마트스토어, 홈택스 and their bank because somebody tidied a roster — no
 * confirmation, no undo — and the row would have said it was that one Bot's profile that went.
 *
 * So the release stops the deleted Bot's tabs, leaves the logins, and writes `computer.released`
 * saying so — or `computer.reset_failed` when the computer could not be reached at all, so the trail
 * never shows a deleted Bot without saying what became of its browser. It never throws: the Bot is
 * already gone from the roster.
 */
function fakeAudit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { store, rows };
}

/**
 * A computer that answers `stopComputer` and NOT `resetComputer`.
 *
 * Deliberately missing the reset: a release that reaches for it again would be a call this fake
 * cannot answer, which is a failing test rather than five people quietly signed out.
 */
function clientStop(onStop: (botId: string) => void, fail = false) {
  const client = {
    forBot(botId: string) {
      return {
        async stopComputer() {
          onStop(botId);
          if (fail) throw new Error("the computer did not respond in time.");
          return { stopped: true, wasRunning: true };
        },
      };
    },
  } as unknown as ComputerClient;
  return client;
}

const ACTOR = { id: "owner-user", role: "user" as const };
const DEV = { id: "dev-local-user", role: "admin" as const };

describe("releasing a deleted Bot's computer", () => {
  test("stops the named Bot, keeps the account's logins, and records both", async () => {
    const stopped: string[] = [];
    const { store, rows } = fakeAudit();
    const release = releaseComputerFor(
      clientStop((id) => stopped.push(id)),
      store,
    );

    // And says it let go of the Bot, which is what a person being removed reports per Bot.
    expect(await release("agent_7", ACTOR)).toBe(true);

    // Addressed as the Bot being deleted, which is what the header and the trail key on.
    expect(stopped).toEqual(["agent_7"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.released");
    expect(rows[0]?.targetId).toBe("agent_7");
    expect(rows[0]?.actorUserId).toBe("owner-user");
    /*
     * THE ROW SAYS THE LOGINS STAYED, as a fact rather than as the absence of a `computer.reset`.
     * An investigator reading this a month later must not have to know which release this was, and a
     * trail spanning 2026-09-16 carries both kinds.
     */
    expect(rows[0]?.payload.loginsKept).toBe(true);
    expect(rows.map((row) => row.eventType)).not.toContain("computer.reset");
  });

  test("a computer that cannot be reached is recorded, not thrown", async () => {
    const { store, rows } = fakeAudit();
    const release = releaseComputerFor(
      clientStop(() => undefined, true),
      store,
    );

    // Resolved, never thrown — and not claimed as a release.
    await expect(release("agent_9", ACTOR)).resolves.toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.reset_failed");
    expect(rows[0]?.targetId).toBe("agent_9");
  });

  test("a row that cannot be written does not turn a release into a failure", async () => {
    // The tabs closed; losing the trail's line about it is a lost line, not a failed release.
    const stopped: string[] = [];
    const release = releaseComputerFor(
      clientStop((id) => stopped.push(id)),
      {
        insert: async () => {
          throw new Error("the audit store is down");
        },
      },
    );

    await expect(release("agent_5", ACTOR)).resolves.toBe(true);
    expect(stopped).toEqual(["agent_5"]);
  });

  test("no computer configured is a no-op, with no row", async () => {
    const { store, rows } = fakeAudit();
    const release = releaseComputerFor(undefined, store);

    await expect(release("agent_1", ACTOR)).resolves.toBe(false);
    expect(rows).toEqual([]);
  });

  test("the local development actor stays out of the audit foreign key", async () => {
    // Same rule the gateway follows: the fixture is not a person, so its id does not become the
    // actor of a row that has a foreign key to `users`.
    const { store, rows } = fakeAudit();
    const release = releaseComputerFor(
      clientStop(() => undefined),
      store,
    );

    await release("agent_3", DEV);
    expect(rows[0]?.actorUserId).toBeUndefined();
    expect(rows[0]?.payload.actor).toBe("dev-local-user");
  });
});
