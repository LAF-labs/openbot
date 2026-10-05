/**
 * The wait a turn measured, from the ledger's columns to the counts an operator reads — and the
 * proof that neither holds a word.
 *
 * Two products were timed by the window with a stopwatch on 2026-10-05, because nothing on a
 * turn's own record ran from the person's message to the first word of the answer, and a first
 * move's time and outcome were on no turn at all. `telemetry/run-meter.ts` reads them now; this is
 * the other half — that what the meter read lands in the row as it was read, that the report's
 * `turns` section counts it, and that a median and a ninetieth percentile come out of those counts
 * by one rule.
 *
 * The rows are the ledger's own (`begin`, then `settle` with a measure), moved into 2003 so the
 * section's window holds this file's turns and nothing else. No other file writes that year; the
 * two that keep an era of their own purge what is before 1998 and before 2000.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { FIRST_MOVE_KINDS } from "../../shared/first-move";
import { createDatabase } from "../src/db/client";
import { agents, lafThreadRuns } from "../src/db/schema";
import type { TurnsInsight } from "../src/insights/report";
import { summariseTurns, turnsStatement } from "../src/insights/turns";
import { createRunLedger, type RunStart } from "../src/runner/run-ledger";
import {
  FIRST_MOVE_ENDINGS,
  type FirstMoveMeasure,
  type RunMeasure,
} from "../src/telemetry/run-meter";
import { TEST_POOL } from "./support/database";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

/** What the person typed, planted wherever these rows could be made to carry words. */
const PLANTED = "사장님 통장 비밀번호 7731 김영희 010-4455-6677";
const ZONE = "Asia/Seoul";
/** 2003-03-03 00:00 UTC, 09:00 in Seoul. */
const ERA = Date.UTC(2003, 2, 3, 0, 0, 0);
const at = (minutes: number) => new Date(ERA + minutes * 60_000);

const measure = (over: Partial<RunMeasure> = {}): RunMeasure => ({
  queuedMs: 40,
  firstTokenMs: 900,
  firstSignMs: null,
  firstWordMs: null,
  streamMs: 600,
  totalMs: 2_000,
  modelRequests: 1,
  toolCalls: 0,
  retries: 0,
  promptTokens: 1_000,
  cachedTokens: 0,
  costUsd: 0.001,
  personNeeded: false,
  emptyAnswer: false,
  firstMove: null,
  ...over,
});

const move = (over: Partial<FirstMoveMeasure> = {}): FirstMoveMeasure => ({
  asked: ["weather"],
  verdict: "moved",
  kind: "weather",
  decisionMs: 240,
  callMs: 1_100,
  ...over,
});

/**
 * Ten conversation turns that said a word, by how long the person waited for it. Chosen so the
 * rule shows: two that round to the same tenth, one exactly on a half (2,050 ms is 2.1 s), a
 * median that is the fifth of ten and a ninetieth percentile that is the ninth.
 */
const WAITS = [
  1_240, 1_260, 2_000, 2_049, 2_050, 3_400, 3_400, 5_000, 8_300, 11_000,
];

/** What the decisions model was asked and what came of it, for eight of those ten. */
const MOVES: Array<FirstMoveMeasure | null> = [
  move(),
  move(),
  move({ decisionMs: 310, callMs: 2_400 }),
  move({ verdict: "below_bar", kind: null, callMs: null }),
  move({ verdict: "below_bar", kind: null, callMs: null }),
  move({ asked: ["calendar", "mail"], kind: "mail" }),
  move({
    asked: ["calendar", "mail"],
    verdict: "ambiguous",
    kind: null,
    callMs: null,
  }),
  move({ asked: ["mail"], verdict: "no_answer", kind: null, callMs: null }),
  null,
  null,
];

describeDb("the wait a turn measured, on its row and in the section", () => {
  const database = createDatabase(databaseUrl ?? "", TEST_POOL);
  const ledger = createRunLedger(database);
  const suite = randomUUID().slice(0, 8);
  const owner = `turn-wait-${suite}-owner`;
  const botId = `agent_turn_wait_${suite}`;
  const made: string[] = [];
  const ids: Record<string, string> = {};
  let section: TurnsInsight | null = null;

  /** Opens a run through the ledger, then puts it at `minutes` into the era. */
  const open = async (minutes: number, start: Partial<RunStart> = {}) => {
    const runId = await ledger.begin({
      agentId: botId,
      userId: owner,
      origin: "chat",
      threadId: `turn-wait-${suite}-${made.length}`,
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

  const row = async (runId: string) => {
    const [found] = await database
      .select()
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, runId));
    if (!found) throw new Error(`run ${runId} is gone`);
    return found;
  };

  beforeAll(async () => {
    await database.insert(agents).values({
      id: botId,
      name: botId,
      type: "remote_ag_ui",
      configuration: {},
    });

    // The ten that said a word, a minute apart.
    for (const [index, firstWordMs] of WAITS.entries()) {
      const runId = await open(index);
      ids[`said${index}`] = runId;
      const firstMove = MOVES[index] ?? null;
      await ledger.settle(runId, {
        status: "done",
        measure: measure({
          // A move's step is out before the model is asked; without one the word is the sign.
          firstSignMs: firstMove?.verdict === "moved" ? 300 : firstWordMs,
          firstWordMs,
          firstMove,
        }),
      });
    }

    // A conversation turn that acted and said nothing: a first sign, and no first word.
    ids.wordless = await open(20);
    await ledger.settle(ids.wordless, {
      status: "error",
      error: "laf:turn_rate_limited",
      measure: measure({ firstSignMs: 700, toolCalls: 1 }),
    });

    // One whose ending was written with no measure at all, as a row from before this is.
    ids.unmeasured = await open(21);
    await ledger.settle(ids.unmeasured, { status: "done" });

    // One still at work when read.
    ids.busy = await open(22);

    // A measure and then an ending written after the fact, with a status alone.
    ids.kept = await open(23);
    await ledger.settle(ids.kept, {
      status: "waiting",
      measure: measure({ firstSignMs: 450, firstWordMs: 4_100 }),
    });
    await ledger.settle(ids.kept, { status: "done", error: null });
    // Out of the window, so the ten above stay the ten the percentiles are over.
    await database
      .update(lafThreadRuns)
      .set({ startedAt: at(-24 * 60) })
      .where(eq(lafThreadRuns.runId, ids.kept));

    /*
     * A routine. Its row carries the same columns — they cost nothing to read off the same events
     * — and a first move is planted on it though no routine has one, to show the section reads
     * conversations and nothing else.
     */
    ids.routine = await open(30, {
      origin: "routine",
      threadId: null,
      label: null,
    });
    await ledger.settle(ids.routine, {
      status: "done",
      measure: measure({
        firstSignMs: 800,
        firstWordMs: 900,
        firstMove: move(),
      }),
    });

    // What some other hand might pass for a first move: words where the lists' own belong.
    ids.planted = await open(40);
    await ledger.settle(ids.planted, {
      status: "done",
      measure: measure({
        firstMove: {
          asked: ["mail", PLANTED, "weather", "mail"],
          verdict: "moved",
          kind: PLANTED,
          decisionMs: 200,
          callMs: 300,
        } as unknown as FirstMoveMeasure,
      }),
    });
    ids.unlisted = await open(41);
    await ledger.settle(ids.unlisted, {
      status: "done",
      measure: measure({
        firstMove: {
          asked: [PLANTED],
          verdict: "moved",
          kind: "weather",
          decisionMs: 200,
          callMs: 300,
        } as unknown as FirstMoveMeasure,
      }),
    });
    ids.unkept = await open(42);
    await ledger.settle(ids.unkept, {
      status: "done",
      measure: measure({
        // A verdict the decision has and the measure does not keep: nobody was asked.
        firstMove: {
          asked: ["weather"],
          verdict: PLANTED,
          kind: null,
          decisionMs: 200,
          callMs: null,
        } as unknown as FirstMoveMeasure,
      }),
    });

    const rows = await database.execute<{ value: string | null }>(
      turnsStatement({ since: at(-60), to: at(12 * 60), timeZone: ZONE }),
    );
    const value = [...rows][0]?.value;
    section = value ? (JSON.parse(value) as TurnsInsight) : null;
  }, 30_000);

  afterAll(async () => {
    if (made.length > 0) {
      await database
        .delete(lafThreadRuns)
        .where(inArray(lafThreadRuns.runId, made));
    }
    await database.delete(agents).where(eq(agents.id, botId));
    await database.$client.close();
  });

  test("the row holds what the meter read: two waits, and a first move as kinds, a verdict and two times", async () => {
    expect(await row(ids.said2)).toMatchObject({
      firstSignMs: 300,
      firstWordMs: 2_000,
      // The older number is still there, and still the Bot's start → the model's first output.
      firstTokenMs: 900,
      firstMoveAsked: ["weather"],
      firstMoveVerdict: "moved",
      firstMoveKind: "weather",
      firstMoveDecisionMs: 310,
      firstMoveCallMs: 2_400,
    });
    expect(await row(ids.said5)).toMatchObject({
      firstMoveAsked: ["calendar", "mail"],
      firstMoveVerdict: "moved",
      firstMoveKind: "mail",
    });
    expect(await row(ids.said6)).toMatchObject({
      firstMoveAsked: ["calendar", "mail"],
      firstMoveVerdict: "ambiguous",
      firstMoveKind: null,
      firstMoveDecisionMs: 240,
      firstMoveCallMs: null,
    });
    // Nobody was asked: the five say nothing, and the two waits are still there.
    expect(await row(ids.said9)).toMatchObject({
      firstWordMs: 11_000,
      firstSignMs: 11_000,
      firstMoveAsked: null,
      firstMoveVerdict: null,
      firstMoveKind: null,
      firstMoveDecisionMs: null,
      firstMoveCallMs: null,
    });
    expect(await row(ids.wordless)).toMatchObject({
      firstSignMs: 700,
      firstWordMs: null,
    });
  });

  test("an ending written after the fact keeps what the run measured, and one with no measure has none", async () => {
    expect(await row(ids.kept)).toMatchObject({
      status: "done",
      firstSignMs: 450,
      firstWordMs: 4_100,
    });
    expect(await row(ids.unmeasured)).toMatchObject({
      status: "done",
      firstSignMs: null,
      firstWordMs: null,
      firstMoveVerdict: null,
    });
  });

  test("a first move is written from the two closed lists or not at all", async () => {
    // The kinds that are kinds, once each and in the list's order; a kind that is not one moved nothing.
    expect(await row(ids.planted)).toMatchObject({
      firstMoveAsked: ["weather", "mail"],
      firstMoveVerdict: "moved",
      firstMoveKind: null,
      firstMoveDecisionMs: 200,
      firstMoveCallMs: 300,
    });
    // No kind of the list's was asked about, or the verdict is not one a measure keeps: nothing.
    for (const id of [ids.unlisted, ids.unkept]) {
      expect(await row(id)).toMatchObject({
        firstMoveAsked: null,
        firstMoveVerdict: null,
        firstMoveKind: null,
        firstMoveDecisionMs: null,
        firstMoveCallMs: null,
      });
    }
    // The lists themselves: what a column can say is these words and no others.
    expect([...FIRST_MOVE_ENDINGS]).toEqual([
      "moved",
      "no_answer",
      "below_bar",
      "ambiguous",
    ]);
  });

  test("the section counts the wait to the first word in tenths of a second, conversations only", () => {
    expect(section?.firstWord).toEqual([
      [12, 1],
      [13, 1],
      [20, 2],
      [21, 1],
      [34, 2],
      [50, 1],
      [83, 1],
      [110, 1],
    ]);
    // The ten, the one that said nothing, the unmeasured one, the one at work and the three planted.
    expect(section?.chatTurns).toBe(16);
  });

  test("the section counts, per kind of first move, the turns asked about it and the turns it moved", () => {
    expect(section?.firstMoves).toEqual({
      // Three moved and two under the bar, and the planted row that named it beside words.
      weather: [6, 3],
      // Asked about twice beside the mail, and moved for neither.
      calendar: [2, 0],
      // Beside the calendar twice — moved once — alone once with no answer, and the planted row.
      mail: [4, 1],
    });
    // Every kind this build has is there, a kind nobody was asked about included.
    expect(Object.keys(section?.firstMoves ?? {}).sort()).toEqual(
      [...FIRST_MOVE_KINDS].sort(),
    );
  });

  test("the median and the ninetieth percentile are nearest rank: a wait somebody had, and the one the database gives", async () => {
    if (!section) throw new Error("the section did not read");
    const day = summariseTurns(section, 1);
    // Ten turns: the fifth and the ninth, in the order of their waits.
    expect(day.firstWordTurns).toBe(10);
    expect(day.firstWordP50).toBe(2.1);
    expect(day.firstWordP90).toBe(8.3);
    // The same two read straight off the rows, by the statement handed to whoever asks by hand.
    const [read] = [
      ...(await database.execute<{
        turns: number | string;
        p50: number | string | null;
        p90: number | string | null;
      }>(sql`
        SELECT count(*) AS turns,
               percentile_disc(0.5) WITHIN GROUP (ORDER BY first_word_ms) AS p50,
               percentile_disc(0.9) WITHIN GROUP (ORDER BY first_word_ms) AS p90
          FROM laf_thread_runs
         WHERE origin = 'chat' AND turn_id = run_id AND first_word_ms IS NOT NULL
           AND started_at >= ${at(-60)} AND started_at < ${at(12 * 60)}`)),
    ];
    expect(Number(read?.turns)).toBe(10);
    expect(Number(read?.p50)).toBe(2_050);
    expect(Number(read?.p90)).toBe(8_300);
    expect(Math.round(Number(read?.p50) / 100) / 10).toBe(
      day.firstWordP50 ?? 0,
    );
    expect(Math.round(Number(read?.p90) / 100) / 10).toBe(
      day.firstWordP90 ?? 0,
    );
    // What the report already said is untouched: it stops at the model's first output.
    expect(day.firstAnswerP50).toBe(0.9);
  });

  test("a section from before the wait was measured reads as not measured, never as no wait", () => {
    if (!section) throw new Error("the section did not read");
    const {
      firstWord: _cells,
      chatTurns: _turns,
      firstMoves: _moves,
      ...older
    } = section;
    expect(summariseTurns(older, 7)).toMatchObject({
      firstWordP50: null,
      firstWordP90: null,
      firstWordTurns: 0,
    });
  });

  test("no word anybody typed reaches a column of the wait or the section", async () => {
    const rows = await database
      .select()
      .from(lafThreadRuns)
      .where(inArray(lafThreadRuns.runId, made));
    // Not vacuous: the label beside these columns does hold the words.
    expect(rows.some((found) => found.label === PLANTED)).toBe(true);
    const measured = rows.map(({ label, error, ...rest }) => rest);
    const everything = JSON.stringify({ measured, section });
    for (const piece of ["비밀번호", "7731", "김영희", "010-4455"]) {
      expect([piece, everything.includes(piece)]).toEqual([piece, false]);
    }
  });
});
