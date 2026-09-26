/**
 * A turn, from the ledger that writes it to the operator's section that reads it — and the proof
 * that neither ever carries what anybody said.
 *
 * Each case drives the real ledger (`begin`, `settle`) the way the chat runner and the routine loop
 * do, then moves its rows into 1997 so the section's window holds this file's turns and nothing
 * else. The trail is append-only; its rows here are 1997's too, and only `audit_purge_before` with
 * a 1998 cutoff removes them — nothing else in the suite writes that year.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, auditEvents, lafThreadRuns } from "../src/db/schema";
import type { TurnsInsight } from "../src/insights/report";
import { summariseTurns, turnsStatement } from "../src/insights/turns";
import { createRunLedger, type RunStart } from "../src/runner/run-ledger";
import {
  ENDING_CODES,
  STEP_NOT_RETURNED,
  WITH_PERSON,
  WITH_WINDOW,
} from "../src/telemetry/run-ending";
import type { RunMeasure } from "../src/telemetry/run-meter";
import { TEST_POOL } from "./support/database";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

/** What the owner typed, planted wherever the product keeps words beside these rows. */
const PLANTED = "사장님 통장 비밀번호 7731 김영희 010-4455-6677";
const ZONE = "Asia/Seoul";
/** 1997-06-02 00:00 UTC, 09:00 in Seoul. */
const ERA = Date.UTC(1997, 5, 2, 0, 0, 0);
const ERA_ENDS = new Date(Date.UTC(1998, 0, 1));
const at = (minutes: number) => new Date(ERA + minutes * 60_000);

const measure = (over: Partial<RunMeasure> = {}): RunMeasure => ({
  queuedMs: 40,
  firstTokenMs: null,
  streamMs: null,
  totalMs: 1_000,
  modelRequests: 1,
  toolCalls: 0,
  retries: 0,
  promptTokens: 1_000,
  cachedTokens: 0,
  costUsd: 0.001,
  personNeeded: false,
  emptyAnswer: false,
  ...over,
});

describeDb("a turn on the ledger, and the section that reads it", () => {
  const database = createDatabase(databaseUrl ?? "", TEST_POOL);
  const ledger = createRunLedger(database);
  const suite = randomUUID().slice(0, 8);
  const owner = `turns-${suite}-owner`;
  const made: string[] = [];
  const bots: string[] = [];
  let section: TurnsInsight | null = null;

  /** A Bot of this file's own, so one case's questions are never another's. */
  const bot = async (name: string) => {
    const id = `agent_turns_${suite}_${name}`;
    await database
      .insert(agents)
      .values({ id, name: id, type: "remote_ag_ui", configuration: {} });
    bots.push(id);
    return id;
  };

  /** Opens a run through the ledger, then puts it at `minutes` into the era. */
  const open = async (
    start: Partial<RunStart> & { agentId: string },
    minutes: number,
  ) => {
    const runId = await ledger.begin({
      userId: owner,
      origin: "chat",
      label: PLANTED,
      ...start,
    });
    made.push(runId);
    await database
      .update(lafThreadRuns)
      .set({ startedAt: at(minutes) })
      .where(eq(lafThreadRuns.runId, runId));
    return runId;
  };

  const finish = (runId: string, minutes: number) =>
    database
      .update(lafThreadRuns)
      .set({ finishedAt: at(minutes) })
      .where(eq(lafThreadRuns.runId, runId));

  const ask = (agentId: string, approval: string, minutes: number) =>
    database.insert(auditEvents).values({
      eventType: "approval.requested",
      targetType: "computer",
      targetId: "computer-1",
      payload: {
        bot: agentId,
        approval,
        rule: "payment",
        subject: { kind: "click", label: PLANTED },
      },
      createdAt: at(minutes),
    });

  const answer = (
    agentId: string,
    approval: string,
    granted: boolean,
    minutes: number,
  ) =>
    database.insert(auditEvents).values({
      eventType: granted ? "approval.granted" : "approval.denied",
      targetType: "computer",
      targetId: "computer-1",
      payload: { bot: agentId, approval, subject: PLANTED },
      createdAt: at(minutes),
    });

  const row = async (runId: string) => {
    const [found] = await database
      .select()
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, runId));
    if (!found) throw new Error(`run ${runId} is gone`);
    return found;
  };

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    // An earlier run of this file that died before its `afterAll` left its era behind.
    await database.execute(sql`SELECT audit_purge_before(${ERA_ENDS})`);
    await database
      .delete(lafThreadRuns)
      .where(sql`${lafThreadRuns.startedAt} < ${ERA_ENDS}`);

    // 1. A conversation turn that answered: 끝남.
    const answered = await bot("answered");
    ids.answered = await open(
      { agentId: answered, threadId: `turns-${suite}-t1` },
      0,
    );
    await ledger.settle(ids.answered, {
      status: "done",
      eventCount: 12,
      measure: measure({
        queuedMs: 100,
        firstTokenMs: 2_000,
        streamMs: 900,
        totalMs: 3_000,
        modelRequests: 2,
        toolCalls: 1,
        retries: 1,
        promptTokens: 5_000,
        cachedTokens: 4_000,
        costUsd: 0.01,
      }),
    });
    await finish(ids.answered, 1);

    // 2. A browsing turn: a step handed to a window, a question granted, the step's result run.
    const browsed = await bot("browsed");
    const thread2 = `turns-${suite}-t2`;
    ids.handed = await open({ agentId: browsed, threadId: thread2 }, 10);
    await ledger.settle(ids.handed, {
      status: "waiting",
      measure: measure({ queuedMs: 60, firstTokenMs: 1_200, toolCalls: 1 }),
    });
    ids.handedWaiting = (await row(ids.handed)).endingCode ?? "";
    await ask(browsed, `a-${suite}-1`, 11);
    await answer(browsed, `a-${suite}-1`, true, 12);
    ids.carried = await open(
      { agentId: browsed, threadId: thread2, continues: true, label: null },
      13,
    );
    // The step came back: `endStepWait` settles the run that handed it over with a status alone.
    await ledger.settle(ids.handed, { status: "done", error: null });
    await ledger.settle(ids.carried, {
      status: "done",
      measure: measure({ modelRequests: 1, costUsd: 0.002 }),
    });
    await finish(ids.carried, 14);

    // 3. A step that never came back while a question waited on the owner: 사장님 차례.
    const asked = await bot("asked");
    ids.unanswered = await open(
      { agentId: asked, threadId: `turns-${suite}-t3` },
      20,
    );
    await ledger.settle(ids.unanswered, { status: "waiting" });
    await ask(asked, `a-${suite}-2`, 21);
    await ledger.settle(ids.unanswered, {
      status: "stopped",
      error: STEP_NOT_RETURNED,
    });

    // 4. A failure the Bot's service coded, inside a sentence that carries the owner's words.
    const failed = await bot("failed");
    ids.failed = await open(
      { agentId: failed, threadId: `turns-${suite}-t4` },
      30,
    );
    await ledger.settle(ids.failed, {
      status: "error",
      error: `The Bot's service refused: laf:turn_rate_limited — ${PLANTED}`,
      measure: measure({ modelRequests: 0, costUsd: 0 }),
    });
    await finish(ids.failed, 31);

    // 5. A Stop the owner pressed: 멈춤.
    const stoppedBot = await bot("stopped");
    ids.stopped = await open(
      { agentId: stoppedBot, threadId: `turns-${suite}-t5` },
      40,
    );
    await ledger.settle(ids.stopped, { status: "stopped", error: null });

    // 6. A routine that stopped because a person has to answer: 사장님 차례.
    const routine = await bot("routine");
    ids.routine = await open(
      { agentId: routine, origin: "routine", label: null },
      50,
    );
    await ledger.settle(ids.routine, {
      status: "done",
      awaiting: true,
      measure: measure({ modelRequests: 3, toolCalls: 2 }),
    });

    // 7. A run the boot reconciler found cut off: `unknown`, which the section calls 못 끝냄.
    const cut = await bot("cut");
    ids.cut = await open({ agentId: cut, threadId: `turns-${suite}-t7` }, 60);
    await database
      .update(lafThreadRuns)
      .set({ status: "unknown", finishedAt: at(61) })
      .where(eq(lafThreadRuns.runId, ids.cut));

    // 8. A failure with no code, whose code column another hand then filled with a sentence.
    const other = await bot("other");
    ids.uncoded = await open(
      { agentId: other, threadId: `turns-${suite}-t8` },
      70,
    );
    await ledger.settle(ids.uncoded, { status: "error", error: PLANTED });
    ids.uncodedCode = (await row(ids.uncoded)).endingCode ?? "";
    await database
      .update(lafThreadRuns)
      .set({ endingCode: PLANTED, finishedAt: at(72) })
      .where(eq(lafThreadRuns.runId, ids.uncoded));

    // 9. A step still with a window when read.
    const busy = await bot("busy");
    ids.busy = await open({ agentId: busy, threadId: `turns-${suite}-t9` }, 80);
    await ledger.settle(ids.busy, {
      status: "waiting",
      measure: measure({ personNeeded: true }),
    });

    const rows = await database.execute<{ value: string | null }>(
      turnsStatement({ since: at(-60), to: at(24 * 60), timeZone: ZONE }),
    );
    const value = [...rows][0]?.value;
    section = value ? (JSON.parse(value) as TurnsInsight) : null;
    // Put back what the ledger wrote, so the rows below are the ledger's own when they are searched.
    await database
      .update(lafThreadRuns)
      .set({ endingCode: ids.uncodedCode })
      .where(eq(lafThreadRuns.runId, ids.uncoded));
  }, 30_000);

  afterAll(async () => {
    if (made.length > 0) {
      await database
        .delete(lafThreadRuns)
        .where(inArray(lafThreadRuns.runId, made));
    }
    if (bots.length > 0) {
      await database.delete(agents).where(inArray(agents.id, bots));
    }
    await database.execute(sql`SELECT audit_purge_before(${ERA_ENDS})`);
    await database.$client.close();
  });

  test("a run that carries a step on joins the turn that handed it over", async () => {
    expect((await row(ids.handed)).turnId).toBe(ids.handed);
    expect((await row(ids.carried)).turnId).toBe(ids.handed);
    expect((await row(ids.answered)).turnId).toBe(ids.answered);
  });

  test("the measure lands on the row, and a later ending keeps it", async () => {
    expect(await row(ids.answered)).toMatchObject({
      ending: "finished",
      endingCode: null,
      queuedMs: 100,
      firstTokenMs: 2_000,
      streamMs: 900,
      totalMs: 3_000,
      modelRequests: 2,
      toolCalls: 1,
      retries: 1,
      promptTokens: 5_000,
      cachedTokens: 4_000,
    });
    // Settled `waiting` first with its measure, then `done` with a status alone.
    expect(await row(ids.handed)).toMatchObject({
      status: "done",
      ending: "finished",
      firstTokenMs: 1_200,
      toolCalls: 1,
    });
  });

  test("a step with a window says whose it is until it ends", async () => {
    expect(ids.handedWaiting).toBe(WITH_WINDOW);
    expect(await row(ids.busy)).toMatchObject({
      status: "waiting",
      ending: null,
      endingCode: WITH_PERSON,
    });
  });

  test("questions asked in the turn are counted, and an open one makes it the owner's", async () => {
    expect(await row(ids.carried)).toMatchObject({
      approvalsAsked: 1,
      approvalsGranted: 1,
    });
    expect(await row(ids.unanswered)).toMatchObject({
      ending: "owner",
      endingCode: ENDING_CODES.approvalUnanswered,
      approvalsAsked: 1,
      approvalsGranted: 0,
    });
  });

  test("each way a turn ends has its ending and its code", async () => {
    expect(await row(ids.failed)).toMatchObject({
      ending: "unfinished",
      endingCode: "laf:turn_rate_limited",
    });
    expect(await row(ids.stopped)).toMatchObject({
      ending: "stopped",
      endingCode: ENDING_CODES.stopped,
    });
    expect(await row(ids.routine)).toMatchObject({
      ending: "owner",
      endingCode: ENDING_CODES.approvalUnanswered,
    });
    // A failure's text with no code in it is a class, never the text.
    expect(ids.uncodedCode).toBe(ENDING_CODES.uncoded);
  });

  test("the section counts turns, not the runs a window split them into", () => {
    expect(section?.endings).toEqual({
      finished: 2,
      unfinished: 3,
      stopped: 1,
      owner: 2,
    });
    expect(section?.inFlight).toBe(1);
    expect(section?.byOrigin).toEqual({ chat: [7, 2], routine: [1, 0] });
    // The turn's opener only: 100 + 2,000 ms and 60 + 1,200 ms, in tenths of a second.
    expect(section?.firstAnswer).toEqual([
      [13, 1],
      [21, 1],
    ]);
    expect(section?.approvals).toEqual([2, 1]);
    expect(section?.reasons).toEqual([
      ["owner", "laf:approval_unanswered", "chat", 1],
      ["owner", "laf:approval_unanswered", "routine", 1],
      ["unfinished", "laf:turn_interrupted", "chat", 1],
      ["unfinished", "laf:turn_rate_limited", "chat", 1],
      ["unfinished", "laf:uncoded", "chat", 1],
    ]);
    expect(section?.cost.owners).toBe(1);
    expect(section?.cost.ownerDays).toBe(1);
    // 5,000 + 1,000 + 1,000 (the browsing turn's two runs) + 1,000 (the failure) + 1,000 (the routine).
    expect(section?.cache).toEqual([9_000, 4_000]);
    expect(section?.unfinished).toEqual([
      ["1997-06-02", "chat", "laf:uncoded", 0, 0, 0, 0, 120],
      ["1997-06-02", "chat", "laf:turn_interrupted", 0, 0, 0, 0, 60],
      ["1997-06-02", "chat", "laf:turn_rate_limited", 0, 0, 0, 0, 60],
    ]);
  });

  test("the section reads into the weekly numbers", () => {
    if (!section) throw new Error("the section did not read");
    const week = summariseTurns(section, 7);
    expect(week.ended).toBe(8);
    expect(week.successRate).toBe(0.25);
    expect(week.firstAnswerP50).toBe(1.3);
    expect(week.firstAnswerP90).toBe(2.1);
    expect(week.approvalsPerTask).toBe(0.25);
    expect(week.topReasons[0]).toEqual(["laf:approval_unanswered", 2]);
    expect(week.cacheShare).toBeCloseTo(4 / 9, 10);
  });

  test("no word anybody typed reaches a measured column or the section", async () => {
    const rows = await database
      .select()
      .from(lafThreadRuns)
      .where(inArray(lafThreadRuns.runId, made));
    // Not vacuous: the product's older columns beside these do hold the words.
    expect(rows.some((found) => found.label === PLANTED)).toBe(true);
    expect(rows.some((found) => found.error?.includes(PLANTED))).toBe(true);
    const measured = rows.map(({ label, error, ...rest }) => rest);
    const everything = JSON.stringify({ measured, section });
    for (const piece of ["비밀번호", "7731", "김영희", "010-4455"]) {
      expect([piece, everything.includes(piece)]).toEqual([piece, false]);
    }
  });
});

/*
 * A routine writes its ending inside the transaction that delivers its answer. The turn's facts
 * were first read on the pool from there — a second connection from inside a transaction, which
 * on a pool of one never comes. Pinned to one, so that shape hangs here instead of in production.
 */
describeDb("a routine's ending, written inside its own transaction", () => {
  const database = createDatabase(databaseUrl ?? "", { max: 1 });
  const ledger = createRunLedger(database);
  const botId = `agent_turns_${randomUUID().slice(0, 8)}_one`;
  let runId = "";

  afterAll(async () => {
    if (runId) {
      await database
        .delete(lafThreadRuns)
        .where(eq(lafThreadRuns.runId, runId));
    }
    await database.delete(agents).where(eq(agents.id, botId));
    await database.$client.close();
  });

  test("is written on a pool of one, with the turn's facts read beside it", async () => {
    await database.insert(agents).values({
      id: botId,
      name: botId,
      type: "remote_ag_ui",
      configuration: {},
    });
    runId = await ledger.begin({
      agentId: botId,
      userId: "turns-one",
      origin: "routine",
    });
    await database.transaction((transaction) =>
      ledger.settle(
        runId,
        { status: "done", awaiting: true, measure: measure() },
        transaction,
      ),
    );
    const [found] = await database
      .select()
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, runId));
    expect(found).toMatchObject({
      status: "done",
      ending: "owner",
      endingCode: ENDING_CODES.approvalUnanswered,
      approvalsAsked: 0,
      modelRequests: 1,
    });
  }, 5_000);
});
