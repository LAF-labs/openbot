/**
 * A room's transcript, straight out of the snapshot column.
 *
 * Not the runtime's own `/api/copilotkit/threads/:id/messages`. That route answers from what a RUN
 * put through the runner, and a room's messages are written by the server rather than by a run, so
 * a room read that way opened empty and stayed empty.
 *
 * The same reasoning as `message-times.ts`, one layer up: our own fields live in the jsonb and the
 * runtime's whitelist would drop them on the way out, so this reads the column.
 */
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafThreadSnapshots } from "../db/schema";

export function createThreadMessageReader(database: Database) {
  return async (threadId: string): Promise<unknown[]> => {
    const [row] = await database
      .select({ messages: lafThreadSnapshots.messages })
      .from(lafThreadSnapshots)
      .where(eq(lafThreadSnapshots.threadId, threadId))
      .limit(1);
    const stored: unknown = row?.messages;
    return Array.isArray(stored) ? stored : [];
  };
}
