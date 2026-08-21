/**
 * One row per run, whatever started it.
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
 * `laf_routine_runs` stays. It holds the ANSWER and the per-routine history a person reads; this
 * holds the fact that something is in flight. They are different questions.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafThreadRuns } from "../db/schema";

export type RunOrigin = "chat" | "routine" | "wake" | "handoff";

export type RunStart = {
  agentId: string | null;
  /** Whose Bot is busy. Null for work that belongs to nobody, which the roster then ignores. */
  userId: string | null;
  /** The conversation, when there is one. A routine has none. */
  threadId?: string | null;
  origin: RunOrigin;
  /** What it is doing, in words a person wrote — a routine's name. */
  label?: string | null;
  /** Machine-initiated runs carry one; a repeat with the same key must not run twice. */
  dedupeKey?: string | null;
};

export type RunLedger = {
  begin(start: RunStart): Promise<string>;
  finish(runId: string, error?: string | null): Promise<void>;
};

export function createRunLedger(database: Database): RunLedger {
  return {
    async begin(start) {
      const runId = randomUUID();
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

    async finish(runId, error) {
      await database
        .update(lafThreadRuns)
        .set({
          status: error ? "error" : "done",
          error: error ?? null,
          finishedAt: new Date(),
        })
        .where(eq(lafThreadRuns.runId, runId));
    },
  };
}
