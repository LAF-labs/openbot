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
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafThreadRuns } from "../db/schema";

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
};

/** How a run ended, as the events reported it. See `runOutcome` in `laf-runner.ts`. */
export type RunOutcome = {
  status: "done" | "error" | "stopped";
  error?: string | null;
  /** How big the turn was. Zero for a run whose path does not stream events. */
  eventCount?: number;
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
 */
export type LedgerExecutor = Pick<Database, "update">;

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

export function createRunLedger(database: Database): RunLedger {
  const settle: RunLedger["settle"] = async (
    runId,
    outcome,
    executor = database,
  ) => {
    await executor
      .update(lafThreadRuns)
      .set({
        status: outcome.status,
        error: outcome.error ?? null,
        ...(outcome.eventCount === undefined
          ? {}
          : { eventCount: outcome.eventCount }),
        finishedAt: new Date(),
      })
      .where(eq(lafThreadRuns.runId, runId));
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
