/**
 * The one ledger, and what the roster reads out of it.
 *
 * There used to be two run stories that never met: a chat turn opened a row when it began, and a
 * routine wrote a receipt once it had already ended. So "is this Bot working?" was answerable for
 * the case a person could already see and unanswerable for the case they could not — scheduled
 * work, running while nobody watched. These tests pin the properties that make one ledger work.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, auditEvents, lafThreadRuns } from "../src/db/schema";
import { createRunLedger } from "../src/runner/run-ledger";
import { createWorkingReader } from "../src/runner/working";
import { ENDING_CODES, STEP_NOT_RETURNED } from "../src/telemetry/run-ending";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("run ledger", () => {
  const database = createDatabase(databaseUrl ?? "");
  const ledger = createRunLedger(database);
  const working = createWorkingReader(database);
  const owner = `user-${randomUUID()}`;
  const other = `user-${randomUUID()}`;
  const started: string[] = [];
  /*
   * The Bots these runs name. `laf_thread_runs.agent_id` references `agents` since 0026, so a run
   * opened for an id nothing carries fails on the reference rather than on what it is testing.
   */
  const bots = [
    "night-shift",
    "inbox-triage",
    "meeting-prep",
    "shared-bot",
    "abandoned",
    "double",
    "two-at-once",
    "several-runs-one-turn",
    "before-runs-were-named",
    "somebody-elses",
  ];
  const seeded: string[] = [];

  beforeAll(async () => {
    for (const id of bots) {
      const made = await database
        .insert(agents)
        .values({ id, name: id, type: "remote_ag_ui", configuration: {} })
        .onConflictDoNothing()
        .returning({ id: agents.id });
      if (made.length > 0) seeded.push(id);
    }
  });

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
    if (seeded.length > 0) {
      await database.delete(agents).where(inArray(agents.id, seeded));
    }
    await database.$client.close();
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

  /*
   * WHOSE QUESTION IT WAS (2026-10-10, `docs/laf/redesign-2026-10.md` §5, piece 5-1).
   *
   * A run that ends counts the questions asked about its Bot's actions, and files an ending that
   * never came back as waiting on the owner while one of them is unanswered. It counted every
   * question about the Bot since the turn began, which was the turn's own only because the Bot's
   * lane let one thing run at a time. The rows are planted here as the gateway writes them
   * (`gateway/trail.ts`): the trail is append-only, so every id is this run of the suite's own.
   */
  const question = (payload: Record<string, unknown>, createdAt?: Date) => ({
    eventType: "approval.requested",
    targetType: "computer",
    targetId: "computer-ledger-test",
    payload,
    ...(createdAt ? { createdAt } : {}),
  });
  const answer = (approval: string, bot: string) => ({
    eventType: "approval.granted",
    targetType: "computer",
    targetId: "computer-ledger-test",
    payload: { bot, approval },
  });
  const settled = async (runId: string) => {
    const [row] = await database
      .select({
        asked: lafThreadRuns.approvalsAsked,
        granted: lafThreadRuns.approvalsGranted,
        ending: lafThreadRuns.ending,
        code: lafThreadRuns.endingCode,
      })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, runId));
    return row;
  };

  test("two runs of one Bot at once each count the questions they raised, and one's unanswered question is not the other's wait", async () => {
    const bot = "two-at-once";
    const turn = await begin({
      agentId: bot,
      origin: "chat",
      threadId: `thread-${randomUUID()}`,
    });
    const routine = await begin({ agentId: bot, origin: "routine" });
    const yes = `asked-and-answered-${randomUUID()}`;
    const silence = `asked-and-left-${randomUUID()}`;
    await database.insert(auditEvents).values([
      // The conversation's turn asked once, and was told yes.
      question({ bot, approval: yes, run: turn }),
      answer(yes, bot),
      // The routine asked once, and nobody has answered.
      question({ bot, approval: silence, run: routine }),
    ]);

    // Both end the same way: a step that never came back.
    const cut = { status: "stopped", error: STEP_NOT_RETURNED } as const;
    await ledger.settle(routine, cut);
    await ledger.settle(turn, cut);

    // The routine is waiting on its owner: its own question is the open one.
    expect(await settled(routine)).toEqual({
      asked: 1,
      granted: 0,
      ending: "owner",
      code: ENDING_CODES.approvalUnanswered,
    });
    // The turn is not. By Bot and time it was two asked, one open, and waiting on the owner —
    // for a question a different run had raised.
    expect(await settled(turn)).toEqual({
      asked: 1,
      granted: 1,
      ending: "unfinished",
      code: STEP_NOT_RETURNED,
    });
  });

  test("a turn counts what every run of it raised", async () => {
    const bot = "several-runs-one-turn";
    const threadId = `thread-${randomUUID()}`;
    const first = await begin({ agentId: bot, origin: "chat", threadId });
    // A run that carries the turn on: its own row, the same turn.
    const second = `carried-on-${randomUUID()}`;
    started.push(second);
    await database.insert(lafThreadRuns).values({
      runId: second,
      threadId,
      agentId: bot,
      userId: owner,
      status: "running",
      origin: "chat",
      turnId: first,
    });
    await database
      .insert(auditEvents)
      .values([
        question({ bot, approval: `first-${randomUUID()}`, run: first }),
        question({ bot, approval: `second-${randomUUID()}`, run: second }),
      ]);

    await ledger.settle(second, { status: "done" });
    expect((await settled(second))?.asked).toBe(2);
  });

  test("a question whose row names no run is counted as it was, by Bot and since the turn began", async () => {
    const bot = "before-runs-were-named";
    const runId = await begin({ agentId: bot });
    await database.insert(auditEvents).values([
      // Written before rows named a run, or by a call with no run behind it.
      question({ bot, approval: `unnamed-${randomUUID()}` }),
      // Another Bot's, and this Bot's from before the turn began: neither is this turn's.
      question({ bot: "somebody-elses", approval: `other-${randomUUID()}` }),
      question(
        { bot, approval: `earlier-${randomUUID()}` },
        new Date(Date.now() - 60 * 60 * 1000),
      ),
      // And one that names a different run of the same Bot is that run's, however recent.
      question({ bot, approval: `named-${randomUUID()}`, run: "another-run" }),
    ]);

    await ledger.settle(runId, { status: "done" });
    expect((await settled(runId))?.asked).toBe(1);
  });
});
