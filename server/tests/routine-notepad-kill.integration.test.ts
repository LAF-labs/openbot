import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  lafRoutineNotepads,
  lafRoutineRuns,
  lafRoutines,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import { createRoutineService } from "../src/routines/service";
import { TEST_POOL } from "./support/database";

/**
 * A crashed run never advances the cursor.
 *
 * A routine whose Bot has told the notepad it got to R-2000 is killed — a real process, SIGKILL
 * (`support/routine-notepad-child.ts`) — between its answer and the commit of its record, and the
 * database is read the way the next run will read it: the cursor is still at R-1000, because the
 * write that moved it was one statement of a transaction that never committed. Killed after the
 * commit instead, the same run's cursor stands at R-2000, which is what makes the first result a
 * measurement and not a harness that cannot write at all.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);

const prefix = `notepad-kill-${randomUUID().slice(0, 8)}`;
const made = { users: [] as string[], agents: [] as string[] };

afterEach(async () => {
  if (made.users.length > 0) {
    const theirs = database
      .select({ id: lafRoutines.id })
      .from(lafRoutines)
      .where(inArray(lafRoutines.createdById, made.users));
    await database
      .delete(lafRoutineNotepads)
      .where(inArray(lafRoutineNotepads.routineId, theirs));
    await database
      .delete(lafRoutineRuns)
      .where(inArray(lafRoutineRuns.routineId, theirs));
    await database
      .delete(lafRoutines)
      .where(inArray(lafRoutines.createdById, made.users));
  }
  if (made.agents.length > 0) {
    await database
      .delete(lafThreadRuns)
      .where(inArray(lafThreadRuns.agentId, made.agents));
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, made.agents));
    await database.delete(agents).where(inArray(agents.id, made.agents));
  }
  if (made.users.length > 0) {
    await database.delete(users).where(inArray(users.id, made.users));
  }
  for (const list of Object.values(made)) list.splice(0);
});

afterAll(async () => {
  await database.$client.close();
});

/** A person, their Bot, a routine on it, and a notepad a previous run left at R-1000. */
async function routineAtR1000() {
  const id = `${prefix}-user-${randomUUID().slice(0, 8)}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Kill Tester" });
  made.users.push(id);
  const owner: AgentActor = { id, role: "user" };
  const profile = await profileStore.create(owner, {
    name: "리뷰봇",
    roleDescription: "스토어 리뷰에 답글 초안을 쓴다.",
  });
  made.agents.push(profile.id);
  const routine = await createRoutineService({
    database,
    resolveAgents: async () => ({}),
  }).create(owner, {
    agentId: profile.id,
    name: "새 리뷰 답글 초안",
    instruction: "지난번 이후 들어온 새 리뷰에 답글 초안을 써 줘",
    schedule: { kind: "interval", minutes: 60 },
  });
  await database.insert(lafRoutineNotepads).values({
    routineId: routine.id,
    entries: [
      {
        key: "new_reviews",
        kind: "watermark",
        lastId: "R-1000",
        at: "2026-09-13T22:00:00.000Z",
      },
    ],
    version: 1,
    writtenByRun: "the-run-before",
  });
  return { owner, botId: profile.id, routineId: routine.id };
}

async function runAndKill(
  fixture: Awaited<ReturnType<typeof routineAtR1000>>,
  at: "delivered" | "committed",
) {
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "support/routine-notepad-child.ts")],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        ROUTINE_ID: fixture.routineId,
        OWNER_ID: fixture.owner.id,
        BOT_ID: fixture.botId,
        LAST_ID: "R-2000",
        KILL_AT: at,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const exit = await child.exited;
  const stderr = await new Response(child.stderr).text();
  // Killed, not finished: exit 3 would mean the seam was never reached and nothing was measured.
  expect({ exit, signal: child.signalCode, stderr: stderr.trim() }).toEqual({
    exit: 137,
    signal: "SIGKILL",
    stderr: "",
  });
}

/** What the next run of this routine would start from, and the record beside it. */
async function readBack(fixture: Awaited<ReturnType<typeof routineAtR1000>>) {
  const [notepad] = await database
    .select()
    .from(lafRoutineNotepads)
    .where(eq(lafRoutineNotepads.routineId, fixture.routineId));
  const receipts = await database
    .select({ id: lafRoutineRuns.id, ok: lafRoutineRuns.ok })
    .from(lafRoutineRuns)
    .where(eq(lafRoutineRuns.routineId, fixture.routineId));
  const ledger = await database
    .select({ status: lafThreadRuns.status })
    .from(lafThreadRuns)
    .where(
      and(
        eq(lafThreadRuns.agentId, fixture.botId),
        eq(lafThreadRuns.origin, "routine"),
      ),
    );
  return {
    cursor: notepad?.entries.map((entry) =>
      entry.kind === "watermark" ? entry.lastId : entry.value,
    ),
    version: notepad?.version,
    writtenByRun: notepad?.writtenByRun,
    receipts: receipts.map((receipt) => receipt.ok),
    receiptIds: receipts.map((receipt) => receipt.id),
    ledger: ledger.map((run) => run.status),
  };
}

describe("a routine that moved its cursor, killed while it settles", () => {
  test("killed between the answer and the commit: the cursor is where the last recorded run left it", async () => {
    const fixture = await routineAtR1000();
    await runAndKill(fixture, "delivered");

    expect(await readBack(fixture)).toEqual({
      cursor: ["R-1000"],
      version: 1,
      writtenByRun: "the-run-before",
      receipts: [],
      receiptIds: [],
      ledger: ["running"],
    });
  }, 30_000);

  test("killed after the commit: the cursor moved with the record that says why", async () => {
    const fixture = await routineAtR1000();
    await runAndKill(fixture, "committed");

    const after = await readBack(fixture);
    expect(after).toMatchObject({
      cursor: ["R-2000"],
      version: 2,
      receipts: [true],
      ledger: ["done"],
    });
    // The cursor names the receipt of the run that moved it.
    expect(after.writtenByRun).toBe(after.receiptIds[0]);
  }, 30_000);
});
