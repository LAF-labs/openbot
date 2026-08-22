/**
 * When each message in a thread was first seen and which Bot said it, straight out of the snapshot.
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

/** Message id to the id of the Bot that said it, for every message that carries one. */
export type MessageSpeakers = Record<string, string>;

export type ThreadMarks = {
  times: MessageTimes;
  speakers: MessageSpeakers;
  /**
   * Assistant messages the record does not name a Bot for.
   *
   * Listed rather than left to the caller to work out, because working it out needs the roles and
   * the roles are only here. It is what a room with several Bots backfills: those rows were
   * written when every group turn was pinned to the first member. A user's message is never in it
   * — a person is not one of the Bots, and a speaker map that claimed otherwise would be a trap
   * for whoever reads it next.
   */
  unattributed: string[];
};

export function createMessageTimeReader(database: Database) {
  return async (threadId: string): Promise<ThreadMarks> => {
    const [row] = await database
      .select({ messages: lafThreadSnapshots.messages })
      .from(lafThreadSnapshots)
      .where(eq(lafThreadSnapshots.threadId, threadId))
      .limit(1);
    if (!row) return { times: {}, speakers: {}, unattributed: [] };

    /*
     * Anything that is not a stamped message is skipped rather than defaulted. A missing time makes
     * the transcript draw one fewer separator; a made-up one makes it lie about when something was
     * said, and this column has held rows written before stamping existed.
     */
    const stored: unknown = row.messages;
    if (!Array.isArray(stored)) {
      return { times: {}, speakers: {}, unattributed: [] };
    }
    const times: MessageTimes = {};
    const speakers: MessageSpeakers = {};
    const unattributed: string[] = [];
    for (const message of stored) {
      if (typeof message !== "object" || message === null) continue;
      const { id, role, lafAt, lafAgentId } = message as {
        id?: unknown;
        role?: unknown;
        lafAt?: unknown;
        lafAgentId?: unknown;
      };
      if (typeof id !== "string") continue;
      if (typeof lafAt === "string") times[id] = lafAt;
      if (typeof lafAgentId === "string") speakers[id] = lafAgentId;
      else if (role === "assistant") unattributed.push(id);
    }
    return { times, speakers, unattributed };
  };
}
