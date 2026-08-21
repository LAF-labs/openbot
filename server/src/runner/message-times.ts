/**
 * When each message in a thread was first seen, read straight out of the snapshot.
 *
 * Straight out, and deliberately not through `getThreadMessages`. That method prefers CopilotKit's
 * in-memory copy for a live thread, and the in-memory copy is AG-UI's own — it has never carried
 * our `lafAt` and never will. The stamps only exist in the jsonb column, so this reads the column.
 *
 * The other door is closed too: `GET /api/copilotkit/threads/:id/messages` rebuilds each message
 * from a fixed whitelist of keys, so a timestamp on the stored object is dropped on the way out
 * whatever the store holds. That is why the times need a route of their own rather than a field.
 */
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafThreadSnapshots } from "../db/schema";

/** Message id to ISO-8601, for every message in the thread that carries a stamp. */
export type MessageTimes = Record<string, string>;

export function createMessageTimeReader(database: Database) {
  return async (threadId: string): Promise<MessageTimes> => {
    const [row] = await database
      .select({ messages: lafThreadSnapshots.messages })
      .from(lafThreadSnapshots)
      .where(eq(lafThreadSnapshots.threadId, threadId))
      .limit(1);
    if (!row) return {};

    /*
     * Anything that is not a stamped message is skipped rather than defaulted. A missing time makes
     * the transcript draw one fewer separator; a made-up one makes it lie about when something was
     * said, and this column has held rows written before stamping existed.
     */
    const stored: unknown = row.messages;
    if (!Array.isArray(stored)) return {};
    const times: MessageTimes = {};
    for (const message of stored) {
      if (typeof message !== "object" || message === null) continue;
      const { id, lafAt } = message as { id?: unknown; lafAt?: unknown };
      if (typeof id === "string" && typeof lafAt === "string") {
        times[id] = lafAt;
      }
    }
    return times;
  };
}
