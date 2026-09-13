/**
 * A server process that runs one routine and is killed at a chosen instant — the audit's SIGKILL.
 *
 * Audit A1-1 (2026-09-10) ran the real routine service with a stub Bot and killed the process the
 * moment the answer had been delivered, then booted a real server over the same database: the
 * answer was in the conversation, the ledger said `running`, and boot told the person their
 * finished briefing had been interrupted. `routine-settlement-kill.integration.test.ts` does the
 * same thing with this file, so what it asserts is what a restart really leaves behind rather than
 * what an in-process imitation of one would.
 *
 * Everything here is the production wiring: the real service, the real ledger, the real delivery
 * into the Bot's own conversation. Only the Bot is a stub, and the kill is a wrapper around the
 * seam it names:
 *
 *   KILL_AT=delivered  after `deliver` has written the answer — where the audit killed it;
 *   KILL_AT=committed  as the `routine.ran` trail row is written, which is after the settlement.
 */
import type { AbstractAgent } from "@ag-ui/client";
import type { AuditStore } from "../../src/audit";
import { createDatabase } from "../../src/db/client";
import { createRoutineDelivery } from "../../src/routines/deliver";
import { createRoutineService } from "../../src/routines/service";
import { createRunLedger } from "../../src/runner/run-ledger";

const { DATABASE_URL, ROUTINE_ID, OWNER_ID, BOT_ID, ANSWER, KILL_AT } =
  process.env;
if (!DATABASE_URL || !ROUTINE_ID || !OWNER_ID || !BOT_ID || !ANSWER) {
  throw new Error("routine-run-child needs its five variables");
}

const database = createDatabase(DATABASE_URL, { max: 2 });

const die = (): never => {
  process.kill(process.pid, "SIGKILL");
  // Not reached; SIGKILL is not delivered to a handler. Kept so the type says so.
  throw new Error("still alive");
};

const bot = {
  setMessages() {},
  async runAgent() {
    return {
      result: undefined,
      newMessages: [
        { id: crypto.randomUUID(), role: "assistant", content: ANSWER },
      ],
    };
  },
} as unknown as AbstractAgent;

const deliver = createRoutineDelivery(database);
const trail: AuditStore = {
  insert: async () => {
    if (KILL_AT === "committed") die();
  },
};

const service = createRoutineService({
  database,
  resolveAgents: async () => ({ [BOT_ID]: bot }),
  ledger: createRunLedger(database),
  auditStore: trail,
  deliver: async (...args: Parameters<typeof deliver>) => {
    const delivered = await deliver(...args);
    if (KILL_AT === "delivered") die();
    return delivered;
  },
});

await service.runNow({ id: OWNER_ID, role: "user" }, ROUTINE_ID);
// A kill point that was never reached is a test that measured nothing; say so with the exit code.
process.exit(3);
