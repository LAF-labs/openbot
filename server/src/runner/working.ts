/**
 * Which of this person's Bots are working right now.
 *
 * One indexed read against the run ledger, which is the point of unifying it: a chat turn and a
 * 6am routine are the same kind of fact here, so the roster shows scheduled work in progress
 * without knowing anything about schedules.
 *
 * Runs are also aged out. A row says `running` until something closes it, and the thing that
 * closes it is a process that can die — boot reconciles those to `unknown`, but only at boot, so
 * between a crash and a restart a stale row would show a Bot working forever. A run older than the
 * cutoff is treated as gone rather than reported: a Bot that looks idle while it is still thinking
 * is a smaller lie than one that looks busy for the rest of the afternoon.
 */
import { and, eq, gt, isNotNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafThreadRuns } from "../db/schema";

/** Anything older than this is presumed dead. Longer than any turn a person waits through. */
const STALE_AFTER_MS = 10 * 60 * 1000;

export type WorkingRun = {
  agentId: string;
  origin: string;
  /** What it is doing, when something wrote one down. A routine's name. */
  label: string | null;
  startedAt: string;
};

export function createWorkingReader(database: Database) {
  return async (userId: string): Promise<WorkingRun[]> => {
    const since = new Date(Date.now() - STALE_AFTER_MS);
    const rows = await database
      .select({
        agentId: lafThreadRuns.agentId,
        origin: lafThreadRuns.origin,
        label: lafThreadRuns.label,
        startedAt: lafThreadRuns.startedAt,
      })
      .from(lafThreadRuns)
      .where(
        and(
          eq(lafThreadRuns.userId, userId),
          eq(lafThreadRuns.status, "running"),
          gt(lafThreadRuns.startedAt, since),
          isNotNull(lafThreadRuns.agentId),
        ),
      );

    /*
     * One entry per Bot, oldest run wins. Two runs for one Bot is a real state — a routine firing
     * while somebody is mid-conversation with it — and the roster has one row to say it in, so it
     * says the thing that has been going on longest rather than whichever row came back first.
     */
    const byAgent = new Map<string, WorkingRun>();
    for (const row of rows) {
      if (!row.agentId) continue;
      const entry = {
        agentId: row.agentId,
        origin: row.origin,
        label: row.label,
        startedAt: row.startedAt.toISOString(),
      };
      const seen = byAgent.get(row.agentId);
      if (!seen || entry.startedAt < seen.startedAt) {
        byAgent.set(row.agentId, entry);
      }
    }
    return [...byAgent.values()];
  };
}
