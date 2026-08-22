/**
 * The one ledger, and what the roster reads out of it.
 *
 * There used to be two run stories that never met: a chat turn opened a row when it began, and a
 * routine wrote a receipt once it had already ended. So "is this Bot working?" was answerable for
 * the case a person could already see and unanswerable for the case they could not — scheduled
 * work, running while nobody watched. These tests pin the properties that make one ledger work.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { lafThreadRuns } from "../src/db/schema";
import { createRunLedger } from "../src/runner/run-ledger";
import { createWorkingReader } from "../src/runner/working";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("run ledger", () => {
  const database = createDatabase(databaseUrl ?? "");
  const ledger = createRunLedger(database);
  const working = createWorkingReader(database);
  const owner = `user-${randomUUID()}`;
  const other = `user-${randomUUID()}`;
  const started: string[] = [];

  const begin = async (over: Partial<Parameters<typeof ledger.begin>[0]>) => {
    const id = await ledger.begin({
      agentId: "night-shift",
      userId: owner,
      origin: "routine",
      ...over,
    });
    started.push(id);
    return id;
  };

  afterAll(async () => {
    for (const runId of started) {
      await database
        .delete(lafThreadRuns)
        .where(eq(lafThreadRuns.runId, runId));
    }
  });

  test("a routine with no conversation still opens a run", async () => {
    // The whole point: `thread_id` was NOT NULL while chat was the only writer, which is why
    // scheduled work — the case where "is it busy?" matters most — had no in-flight record at all.
    const runId = await begin({ label: "Nightly receipts" });

    const [row] = await database
      .select()
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, runId));

    expect(row?.threadId).toBeNull();
    expect(row?.status).toBe("running");
    expect(row?.origin).toBe("routine");
    expect(row?.label).toBe("Nightly receipts");
    expect(row?.finishedAt).toBeNull();
  });

  test("the roster sees it while it runs and not after", async () => {
    const runId = await begin({ agentId: "inbox-triage" });

    expect((await working(owner)).map((run) => run.agentId)).toContain(
      "inbox-triage",
    );

    await ledger.finish(runId);

    expect((await working(owner)).map((run) => run.agentId)).not.toContain(
      "inbox-triage",
    );
  });

  test("a failed run closes with its reason rather than staying open", async () => {
    const runId = await begin({ agentId: "meeting-prep" });
    await ledger.finish(runId, "The Bot did not answer in time.");

    const [row] = await database
      .select()
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, runId));

    expect(row?.status).toBe("error");
    expect(row?.error).toBe("The Bot did not answer in time.");
    expect(row?.finishedAt).not.toBeNull();
    expect((await working(owner)).map((r) => r.agentId)).not.toContain(
      "meeting-prep",
    );
  });

  test("one person's work is not another person's busy Bot", async () => {
    await begin({ agentId: "shared-bot", userId: other });
    expect((await working(owner)).map((r) => r.agentId)).not.toContain(
      "shared-bot",
    );
    expect((await working(other)).map((r) => r.agentId)).toContain(
      "shared-bot",
    );
  });

  test("a run left open by a dead process is not reported forever", async () => {
    /*
     * Boot reconciles crashed runs, but only at boot. Between a crash and a restart a `running`
     * row would otherwise show a Bot working for the rest of the afternoon — a bigger lie than
     * showing it idle while it is in fact still thinking.
     */
    const runId = `stale-${randomUUID()}`;
    started.push(runId);
    await database.insert(lafThreadRuns).values({
      runId,
      threadId: null,
      agentId: "abandoned",
      userId: owner,
      status: "running",
      origin: "routine",
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    expect((await working(owner)).map((r) => r.agentId)).not.toContain(
      "abandoned",
    );
  });

  test("a Bot busy twice is one row on the roster, reporting the older run", async () => {
    // A routine firing while somebody is mid-conversation with the same Bot is a real state, and
    // the roster has one line to say it in.
    const older = new Date(Date.now() - 30_000);
    const first = `two-a-${randomUUID()}`;
    const second = `two-b-${randomUUID()}`;
    started.push(first, second);
    await database.insert(lafThreadRuns).values([
      {
        runId: first,
        threadId: null,
        agentId: "double",
        userId: owner,
        status: "running",
        origin: "routine",
        label: "Nightly receipts",
        startedAt: older,
      },
      {
        runId: second,
        threadId: "thread-double",
        agentId: "double",
        userId: owner,
        status: "running",
        origin: "chat",
        startedAt: new Date(),
      },
    ]);

    const rows = (await working(owner)).filter((r) => r.agentId === "double");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe("routine");
    expect(rows[0]?.label).toBe("Nightly receipts");
  });
});
