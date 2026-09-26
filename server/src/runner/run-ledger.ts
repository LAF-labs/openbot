/**
 * One row per run, whatever started it — and ONE writer for that row.
 *
 * There were two run stories and they did not meet. A chat turn wrote `laf_thread_runs` the moment
 * it began, so a crash mid-turn left a record; a routine wrote `laf_routine_runs` once, afterwards,
 * with `startedAt` and `finishedAt` stamped together — which is not a record of a run, it is a
 * receipt for one that already ended. Nothing could answer "is this Bot working right now" for the
 * case that matters most: work nobody at a keyboard started.
 *
 * So the ledger is the one that was already designed to grow into this. Its own header says as
 * much: "the skeleton the real Run ledger will grow on". `threadId` is nullable now because a
 * routine has no conversation, and `userId` is here so the roster can ask what is running for one
 * person without scanning every run the deployment has ever seen.
 *
 * And then the table had two writers again: `laf-runner.ts` inserted its own row and updated it,
 * beside this module doing the same thing differently — a chat run's `eventCount` was written and
 * a routine's never was, `stopped` existed on one path and not on the other. `settle` is the second
 * half this module was missing; nothing else touches `laf_thread_runs`.
 *
 * `laf_routine_runs` stays. It holds the ANSWER and the per-routine history a person reads; this
 * holds the fact that something is in flight. They are different questions.
 */
import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafThreadRuns } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import {
  ENDING_CODE_SOURCE,
  endingOf,
  WITH_PERSON,
} from "../telemetry/run-ending";
import type { RunMeasure } from "../telemetry/run-meter";

/**
 * What starts a run, of what the enum column accepts.
 *
 * Exported as a value because one of the writers takes the origin off the wire and has to check it
 * against something (`laf-runner.ts`); a pg enum turns an unchecked string into a failed insert.
 *
 * The same three the enum holds. It held `handoff` and `room` too, until rooms and one Bot asking
 * another were removed (2026-09-24); migration 0047 deleted their runs and rebuilt the type.
 */
export const RUN_ORIGINS = ["chat", "routine", "wake"] as const;

export type RunOrigin = (typeof RUN_ORIGINS)[number];

export type RunStart = {
  agentId: string | null;
  /** Whose Bot is busy. Null for work that belongs to nobody, which the roster then ignores. */
  userId: string | null;
  /** The conversation, when there is one. A routine has none. */
  threadId?: string | null;
  origin: RunOrigin;
  /** What it is doing, in words a person wrote: a routine's name, or the start of a chat message. */
  label?: string | null;
  /** Machine-initiated runs carry one; a repeat with the same key must not run twice. */
  dedupeKey?: string | null;
  /**
   * The id the caller already has, when it has one.
   *
   * AG-UI's input carries a `runId` for a chat turn, and the events, the transcript and this row
   * all have to agree on it. Everything else lets the ledger mint one.
   */
  runId?: string;
  /**
   * This run carries on a step an earlier run of the same turn handed to a window: its input ends
   * on the step's result, not on anything the person said. It joins that run's turn rather than
   * opening one, so the report counts the person's errand once however many steps it took.
   */
  continues?: boolean;
};

/** How a run ended, as the events reported it. See `runOutcome` in `laf-runner.ts`. */
export type RunOutcome = {
  /** `waiting`: its step is with a window. See `runStatus` in `db/schema/laf.ts`. */
  status: "done" | "error" | "stopped" | "waiting";
  error?: string | null;
  /** How big the turn was. Zero for a run whose path does not stream events. */
  eventCount?: number;
  /**
   * What the run measured (`telemetry/run-meter.ts`). Absent on an ending written after the fact —
   * a step that came back or never did — which keeps what the run itself measured.
   */
  measure?: RunMeasure;
  /** A routine that stopped because a person has to answer something: 사장님 차례. */
  awaiting?: boolean;
};

/**
 * Anything an ending can be written on: the pool, or a transaction already open around the
 * caller.
 *
 * A routine settles its run in ONE transaction with the answer it delivered and the receipt it
 * writes (`routines/service.ts`), because a run row that said `running` beside an answer that had
 * already landed was what a restart then reported as interrupted — measured on 2026-09-10. An
 * ending written on the pool would commit on its own, before or after that transaction, and could
 * disagree with it either way.
 *
 * `execute` and `transaction` too, for the turn's facts an ending is read with (`settle`).
 */
export type LedgerExecutor = Pick<
  Database,
  "update" | "execute" | "transaction"
>;

/** How much of the person's message a chat run's label keeps: enough to recognise, not to reread. */
export const CHAT_LABEL_LENGTH = 40;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The first `limit` code points of some words, on one line, never cutting a character in half.
 *
 * Code points rather than UTF-16 units, because "40 characters" of Korean and of emoji must be the
 * same forty; and whole graphemes, because a family emoji is several code points joined, and a cut
 * through one leaves a stray person in the label. A grapheme that would cross the limit is left out
 * whole. Empty words are no label at all.
 */
export function headOf(text: string, limit: number): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  let kept = "";
  let count = 0;
  for (const { segment } of graphemes.segment(flat)) {
    const size = [...segment].length;
    if (count + size > limit) break;
    kept += segment;
    count += size;
  }
  return kept.trimEnd() || null;
}

/**
 * A chat run's label: the start of what the person said, when the person is what started it.
 *
 * The column always said "in the person's own words where there are any", and a chat run is the one
 * run that has some; only routines ever wrote it. 오늘 (the Bot's day in the sidebar) reads it to
 * name a turn. Only when the newest message IS the person's: a browser step coming back to the Bot is
 * also a chat run, and its newest message is a tool's result — that run carries the turn on, and
 * has no words of its own (`runner/laf-runner.ts`, `carriesAStepOn`).
 *
 * Written when the run opens, after nothing the model reads: the label is never read into a prompt.
 */
export function chatLabelOf(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): string | null {
  const last = messages.at(-1);
  if (last?.role !== "user") return null;
  const content = last.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              part && typeof part === "object" && part.type === "text"
                ? String(part.text ?? "")
                : "",
            )
            .join(" ")
        : "";
  return headOf(text, CHAT_LABEL_LENGTH);
}

export type RunLedger = {
  begin(start: RunStart): Promise<string>;
  /** The full ending, for a caller that watched the events and knows how it really finished. */
  settle(
    runId: string,
    outcome: RunOutcome,
    executor?: LedgerExecutor,
  ): Promise<void>;
  /** The short ending, for a caller that only knows whether it threw. */
  finish(
    runId: string,
    error?: string | null,
    executor?: LedgerExecutor,
  ): Promise<void>;
};

const WHOLE_CODE = new RegExp(ENDING_CODE_SOURCE);

/** A column's worth of a count: whole, not negative, and inside an `integer`. */
const whole = (value: number | null): number | null =>
  value === null || !Number.isFinite(value)
    ? null
    : Math.min(2_147_483_647, Math.max(0, Math.round(value)));

/** The measure as columns. Nothing but numbers leaves here. */
function measureColumns(measure: RunMeasure) {
  return {
    queuedMs: whole(measure.queuedMs),
    firstTokenMs: whole(measure.firstTokenMs),
    streamMs: whole(measure.streamMs),
    totalMs: whole(measure.totalMs),
    modelRequests: whole(measure.modelRequests) ?? 0,
    toolCalls: whole(measure.toolCalls) ?? 0,
    retries: whole(measure.retries) ?? 0,
    promptTokens: whole(measure.promptTokens) ?? 0,
    cachedTokens: whole(measure.cachedTokens) ?? 0,
    costUsd:
      Number.isFinite(measure.costUsd) && measure.costUsd > 0
        ? measure.costUsd
        : 0,
  };
}

/** What the ledger reads about a run's turn before it writes the run's ending. */
type TurnSoFar = {
  agentId: string | null;
  /** The provisional code a `waiting` settle left: whose the step was. */
  endingCode: string | null;
  /** When the turn's first run was accepted, on the database's clock like the trail's rows. */
  turnStartedAt: Date | null;
};

/** Where the turn's facts are read: a transaction, or a savepoint inside the caller's. */
type Reader = Pick<Database, "execute">;

async function turnSoFar(
  database: Reader,
  runId: string,
): Promise<TurnSoFar | null> {
  const rows = await database.execute<{
    agent_id: string | null;
    ending_code: string | null;
    turn_started_at: string | Date | null;
  }>(sql`
    SELECT r.agent_id, r.ending_code, coalesce(o.started_at, r.started_at) AS turn_started_at
      FROM laf_thread_runs r
      LEFT JOIN laf_thread_runs o ON o.run_id = r.turn_id
     WHERE r.run_id = ${runId}`);
  const row = [...rows][0];
  if (!row) return null;
  return {
    agentId: row.agent_id,
    endingCode: row.ending_code,
    turnStartedAt:
      row.turn_started_at === null ? null : new Date(row.turn_started_at),
  };
}

/**
 * The questions asked about this Bot's actions since its turn began, how many a person granted,
 * and how many nobody has answered.
 *
 * BY BOT AND TIME, because the question's row (`approval.requested`, written by the gateway and the
 * plugin store) names the Bot and the approval and not the run: in a conversation it is asked by a
 * window, between two runs, and no run is open to name. One person has one Bot, and a routine takes
 * its Bot's lane, so the questions in a turn's window are that turn's — except for a routine and a
 * conversation overlapping on the one Bot, which would each count the other's. Paired by the
 * approval's id, as `notifications/approval-metrics.ts` and the fleet's `approvals` pair them.
 */
async function approvalsSince(
  database: Reader,
  agentId: string,
  since: Date,
): Promise<{ asked: number; granted: number; open: number }> {
  const rows = await database.execute<{
    asked: number | string;
    granted: number | string;
    open: number | string;
  }>(sql`
    SELECT count(*) AS asked,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM audit_events d
              WHERE d.event_type = 'approval.granted'
                AND d.payload->>'approval' = r.payload->>'approval')) AS granted,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM audit_events d
              WHERE d.event_type IN ('approval.granted', 'approval.denied')
                AND d.payload->>'approval' = r.payload->>'approval')) AS open
      FROM audit_events r
     WHERE r.event_type = 'approval.requested'
       AND r.payload->>'bot' = ${agentId}
       AND r.created_at >= ${since}`);
  const row = [...rows][0];
  return {
    asked: Number(row?.asked ?? 0),
    granted: Number(row?.granted ?? 0),
    open: Number(row?.open ?? 0),
  };
}

export function createRunLedger(database: Database): RunLedger {
  const settle: RunLedger["settle"] = async (
    runId,
    outcome,
    executor = database,
  ) => {
    /*
     * THE TURN'S FACTS ARE READ ON THE CALLER'S EXECUTOR, IN A SAVEPOINT, and never allowed to cost
     * the ending.
     *
     * Not on the pool: a routine settles inside its own transaction (`routines/settlement.ts`), and
     * a read on a second connection from inside one is the deadlock `db/client.ts` warns of — every
     * pooled connection in such a transaction, each waiting for another. In a savepoint, a read that
     * fails is rolled back alone and the caller's transaction stays usable, so the ending is written
     * without these facts: a lost measurement is a gap in a report, a lost ending is a Bot the
     * roster calls busy. On the pool it is a transaction of two reads.
     */
    let facts: {
      turn: TurnSoFar | null;
      approvals: { asked: number; granted: number; open: number } | null;
    } = { turn: null, approvals: null };
    try {
      facts = await executor.transaction(async (reader) => {
        const turn = await turnSoFar(reader, runId);
        const approvals =
          outcome.status !== "waiting" && turn?.agentId && turn.turnStartedAt
            ? await approvalsSince(reader, turn.agentId, turn.turnStartedAt)
            : null;
        return { turn, approvals };
      });
    } catch (error) {
      log.warn("run_measure_unread", {
        run: runId,
        reason: describeFailure(error),
      });
    }
    const { turn, approvals } = facts;
    const { ending, code } = endingOf({
      status: outcome.status,
      error: outcome.error ?? null,
      personNeeded:
        outcome.measure?.personNeeded ?? turn?.endingCode === WITH_PERSON,
      emptyAnswer: outcome.measure?.emptyAnswer ?? false,
      awaiting: outcome.awaiting ?? false,
      approvalsOpen: approvals?.open ?? null,
    });
    await executor
      .update(lafThreadRuns)
      .set({
        status: outcome.status,
        error: outcome.error ?? null,
        ...(outcome.eventCount === undefined
          ? {}
          : { eventCount: outcome.eventCount }),
        finishedAt: new Date(),
        ending,
        // Only a code's shape is ever written; anything else was never a code.
        endingCode: code !== null && WHOLE_CODE.test(code) ? code : null,
        ...(outcome.measure ? measureColumns(outcome.measure) : {}),
        ...(approvals
          ? {
              approvalsAsked: approvals.asked,
              approvalsGranted: approvals.granted,
            }
          : {}),
      })
      .where(eq(lafThreadRuns.runId, runId));
  };

  /**
   * The turn a run carrying a step on belongs to: the thread's newest run's, which is the run that
   * handed the step over. Its own id when there is none to join — a thread whose rows predate
   * turns, or none — so a continuation is never counted as nobody's.
   */
  const turnOf = async (runId: string, start: RunStart): Promise<string> => {
    if (!start.continues || !start.threadId) return runId;
    const [latest] = await database
      .select({ runId: lafThreadRuns.runId, turnId: lafThreadRuns.turnId })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.threadId, start.threadId))
      .orderBy(desc(lafThreadRuns.startedAt))
      .limit(1);
    return latest ? (latest.turnId ?? latest.runId) : runId;
  };

  return {
    async begin(start) {
      const runId = start.runId ?? randomUUID();
      await database.insert(lafThreadRuns).values({
        runId,
        threadId: start.threadId ?? null,
        agentId: start.agentId,
        userId: start.userId,
        label: start.label ?? null,
        origin: start.origin,
        dedupeKey: start.dedupeKey ?? null,
        status: "running",
        turnId: await turnOf(runId, start),
      });
      return runId;
    },

    settle,

    async finish(runId, error, executor) {
      await settle(
        runId,
        {
          status: error ? "error" : "done",
          error: error ?? null,
        },
        executor,
      );
    },
  };
}
