/**
 * Boot reconciliation: a run still `running` when a new process starts cannot
 * still be running — this build is one process — so construction adjudicates
 * it to `unknown` with an ending time. The digest then names it a crash
 * instead of a run that never ends.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { lafThreadRuns } from "../src/db/schema";
import { LafPostgresRunner } from "../src/runner/laf-runner";
import { createRunLedger } from "../src/runner/run-ledger";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("laf runner boot reconciliation", () => {
  const database = createDatabase(databaseUrl ?? "");
  const runId = `test-crash-${randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    await database.delete(lafThreadRuns).where(eq(lafThreadRuns.runId, runId));
  });

  test("a run with no ending is adjudicated to unknown at boot", async () => {
    await database.insert(lafThreadRuns).values({
      runId,
      threadId: `thread-${runId}`,
      status: "running",
      origin: "chat",
    });

    await LafPostgresRunner.create(database, createRunLedger(database));

    const [row] = await database
      .select()
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, runId));
    expect(row?.status).toBe("unknown");
    expect(row?.finishedAt).not.toBeNull();
  });
});
