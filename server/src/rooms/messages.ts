/**
 * A room's transcript, straight out of the snapshot column.
 *
 * Not the runtime's own `/api/copilotkit/threads/:id/messages`. That route is answered by our
 * runner ONLY when the deployment is in local mode — in Intelligence mode the runtime answers it
 * from its own store, which has never seen a message the server wrote. A room's messages are all
 * written by the server, so a room in Intelligence mode would have opened empty and stayed empty.
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
