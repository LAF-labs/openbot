/**
 * A room's transcript, straight out of the store.
 *
 * Not the runtime's own `/api/copilotkit/threads/:id/messages`. That route answers from what a RUN
 * put through the runner, and a room's messages are written by the server rather than by a run, so
 * a room read that way opened empty and stayed empty.
 *
 * The same reasoning as `message-times.ts`, one layer up: our own fields live in the jsonb and the
 * runtime's whitelist would drop them on the way out, so this reads the rows.
 */
import type { Database } from "../db/client";
import { messagesFor } from "../runner/thread-store";

export function createThreadMessageReader(database: Database) {
  return async (threadId: string): Promise<unknown[]> =>
    messagesFor(database, threadId);
}
