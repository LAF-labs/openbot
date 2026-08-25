import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentMemories } from "../db/schema";

/** One thing a Bot learned, as the person reading the list sees it. */
export type AgentMemory = {
  id: string;
  content: string;
  createdAt: Date;
};

/**
 * The most a Bot may carry into a conversation.
 *
 * A cap rather than everything, because this text is prepended to every single turn: unbounded, a
 * Bot that has worked with somebody for a year spends its whole context remembering and has none
 * left to answer with. Oldest fall out first — what somebody told it last week is more likely to
 * still be true than what it inferred in its first hour.
 */
export const MAX_MEMORIES_CARRIED = 40;

/** How long one remembered fact may be. Long enough for a sentence, short enough to read in a list. */
export const MAX_MEMORY_LENGTH = 400;

export type AgentMemoryStore = {
  /** What this Bot still knows about this person, oldest first. */
  list(agentId: string, ownerUserId: string): Promise<AgentMemory[]>;
  /** Append one fact. Returns null when the text is empty or too long to be one. */
  remember(
    agentId: string,
    ownerUserId: string,
    content: string,
  ): Promise<AgentMemory | null>;
  /**
   * Stop carrying one fact.
   *
   * Returns whether a row was actually cleared rather than resolving either way, so a caller can
   * tell "forgotten" from "no such row" — reporting success for an id that matched nothing is how
   * a Forget button convinces somebody a thing is gone when it is still being read every turn.
   */
  forget(id: string, ownerUserId: string): Promise<boolean>;
};

export function createAgentMemoryStore(database: Database): AgentMemoryStore {
  return {
    async list(agentId, ownerUserId) {
      const rows = await database
        .select({
          id: agentMemories.id,
          content: agentMemories.content,
          createdAt: agentMemories.createdAt,
        })
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.agentId, agentId),
            eq(agentMemories.ownerUserId, ownerUserId),
            isNull(agentMemories.forgottenAt),
          ),
        )
        // Oldest first: the prompt reads as a history, and the cap drops the far end.
        .orderBy(asc(agentMemories.createdAt))
        .limit(MAX_MEMORIES_CARRIED);
      return rows;
    },

    async remember(agentId, ownerUserId, content) {
      const text = content.trim();
      if (!text || text.length > MAX_MEMORY_LENGTH) return null;

      const [row] = await database
        .insert(agentMemories)
        .values({
          id: `memory_${crypto.randomUUID()}`,
          agentId,
          ownerUserId,
          content: text,
        })
        .returning({
          id: agentMemories.id,
          content: agentMemories.content,
          createdAt: agentMemories.createdAt,
        });
      return row ?? null;
    },

    async forget(id, ownerUserId) {
      const cleared = await database
        .update(agentMemories)
        .set({ forgottenAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(agentMemories.id, id),
            eq(agentMemories.ownerUserId, ownerUserId),
            // Already forgotten is not an error, but it is not a second forgetting either.
            isNull(agentMemories.forgottenAt),
          ),
        )
        .returning({ id: agentMemories.id });
      return cleared.length > 0;
    },
  };
}
