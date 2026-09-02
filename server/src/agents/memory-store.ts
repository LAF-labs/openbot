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

/** The words that name a secret, in both languages a person here would use. */
const SECRET_WORDS =
  /(비밀번호|비번|패스워드|암호|인증번호|일회용\s?번호|카드\s?번호|계좌\s?번호|주민\s?등록\s?번호|주민번호|보안\s?코드|password|passwd|pwd|passcode|one[-\s]?time\s?code|card\s?number|account\s?number|cvc|cvv|pin)/i;

/**
 * Something in the sentence that looks like a VALUE rather than like prose.
 *
 * Three or more ASCII characters, at least one of them a digit. That shape is what a password, a
 * code and an account fragment all have and what Korean prose does not: "비밀번호는 절대 묻지
 * 않는다" has no such token, and "비밀번호는 8자리 이상" only has a bare `8`, because the counter
 * after it is Korean and breaks the run. Passwords people actually hand over — `hunter2!`,
 * `shop1234`, `Sunflower99` — all have one.
 */
const VALUE_SHAPED = /[A-Za-z0-9!@#$%^&*()\-+=./]{3,}/g;

/** Twelve or more digits once separators are ignored: a card, an account, a resident number. */
const LONG_DIGIT_RUN = /(?:\d[\s-]?){12,}/;

/**
 * Whether a fact a Bot is trying to remember looks like a secret.
 *
 * WHY THE PATTERN AND NOT THE RUN. The stronger check would be "anything typed while a
 * `computer_request_secret` was open in this run" — but a memory is written through an ordinary
 * HTTP route that carries a person, a Bot and a sentence, and nothing else. It has no run id, and
 * the wheel's state lives in the browser container, one service away. That is a wire to build when
 * there is a reason; the pattern is what is cheap and true today.
 *
 * Deliberately not clever. It refuses a SHAPE — a secret word in the same sentence as something
 * that looks like a value, or a long run of digits on its own — rather than a subject, because a
 * shop owner talks about cards and passwords constantly and those sentences are exactly the facts
 * a Bot is for. A filter that ate "우리 가게는 카드 결제만 받는다" would be switched off in a week.
 *
 * A determined model can still spell a password out in words, which is why this is one of three
 * things in the way and not the only one: the prompt says not to, `computer_request_secret` exists
 * so it never has to, and this is the floor under both.
 */
export function looksLikeASecret(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (LONG_DIGIT_RUN.test(trimmed)) return true;
  if (!SECRET_WORDS.test(trimmed)) return false;
  return (trimmed.match(VALUE_SHAPED) ?? []).some((token) => /\d/.test(token));
}

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
