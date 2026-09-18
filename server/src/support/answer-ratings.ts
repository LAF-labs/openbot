/**
 * 좋아요·아쉬워요 under a Bot's answer: the row, what may be rated, and the line the operator gets.
 *
 * WHY THIS EXISTS. The product was about to meet its first customers with no way to hear, answer by
 * answer, whether a Bot had done well. The 문의·의견 box (`feedback.ts`) hears about the product
 * when somebody has had enough to write a message; this hears about one reply, at the moment it was
 * read, for the cost of one press — and it reuses that box's door to the operator rather than
 * opening a second one.
 *
 * WHAT MAY BE RATED IS A BOT'S ANSWER IN THE PERSON'S OWN CONVERSATION, read off the stored message:
 * an assistant message in this person's thread for that channel whose record names the Bot that
 * gave it (`lafAgentId`, `runner/thread-store.ts`). Their own message is not an answer. An answer
 * from before speakers were recorded has no Bot to name in the alert and none to go with when that
 * Bot is deleted. An id from somebody else's thread is not in this conversation. All three are one
 * refusal, `laf:rating_message_not_found`, because from where the person stands they are one fact:
 * there is no answer here to rate. Not being in the conversation at all is `laf:channel_not_found`,
 * the same answer every channel route gives somebody who is not in it (`channels/roster.ts`).
 *
 * THE ANSWER NEVER LEAVES THE CONVERSATION. Rating it reads two fields of the stored message — its
 * role and its Bot — and never its words. The row keeps ids; the operator is sent the Bot's name,
 * the reason, what the person wrote and the ids to find the rest by on the VM.
 *
 * WHO IS TOLD. Only 아쉬워요 that carries a note — somebody took the trouble to say what was wrong,
 * and that is worth reading the day it is written. 좋아요, and 아쉬워요 with nothing written, are
 * counts: kept here and counted by the fleet (`insights/read.ts`), and paging the operator with
 * each would teach them to mute the channel the 문의·의견 messages arrive in. A note sent again
 * unchanged — the popover reopened and 보내기 pressed on what was already there — is not told twice.
 *
 * KOREAN, FROM A SERVER THAT OTHERWISE SENDS NO PROSE, for the reason `feedback.ts` gives: the
 * alert is read by the fleet's operator, and there is no surface on the other end of a webhook to
 * own the words. The person's screen gets the reason KEYS and says them in its own words.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import { readChannel } from "../channels/roster";
import type { Database } from "../db/client";
import { agents, lafAnswerRatings, lafThreadMessages } from "../db/schema";
import type { AnswerRatingFacts } from "../notifications/outbox";

/** The two presses. The same pair as the column's enum (`laf_answer_rating`). */
export const ANSWER_RATINGS = ["up", "down"] as const;
export type AnswerRating = (typeof ANSWER_RATINGS)[number];

/**
 * Why an answer fell short: 요청과 달라요, 사실과 달라요, 너무 느려요, 그 밖에.
 *
 * Catalogue-key shaped (`insights/catalogue-key.ts`) on purpose: the fleet re-checks every key a VM
 * hands back against that shape and files anything else as `other`, so a key written as
 * `wrong_facts` would be counted under the wrong name without anybody being told.
 */
export const ANSWER_RATING_REASONS = [
  "not-as-asked",
  "wrong-facts",
  "too-slow",
  "other",
] as const;
export type AnswerRatingReason = (typeof ANSWER_RATING_REASONS)[number];

/** How much a person may write under 아쉬워요. Checked on the route, so the refusal is a code. */
export const ANSWER_NOTE_MAX_LENGTH = 500;

/** The body is not a rating this route takes. */
export const RATING_INVALID = "laf:rating_invalid";
/** The note is longer than `ANSWER_NOTE_MAX_LENGTH`. Sent with `limit`. */
export const RATING_NOTE_TOO_LONG = "laf:rating_note_too_long";
/** There is no Bot's answer by that id in this conversation. See the module note. */
export const RATING_MESSAGE_NOT_FOUND = "laf:rating_message_not_found";
/** The person is not in that conversation — the same code every channel route answers with. */
export const RATING_CHANNEL_NOT_FOUND = "laf:channel_not_found";

/**
 * Longer than any id this deployment mints or AG-UI streams (a UUID, `msg_<run id>`). Past it the
 * id cannot name a stored message, so it is refused without asking the database to look.
 */
const MESSAGE_ID_MAX_LENGTH = 200;

export const isAnswerRatingReason = (
  value: unknown,
): value is AnswerRatingReason =>
  typeof value === "string" &&
  (ANSWER_RATING_REASONS as readonly string[]).includes(value);

/** What a press asks for, once the route has read it. */
export type AnswerRatingChoice = {
  rating: AnswerRating;
  reason: AnswerRatingReason | null;
  note: string | null;
};

/**
 * The body, read into a choice or refused with a code.
 *
 * `rating`, `reason` and `note` are the only keys read. A reason or a note under 좋아요 is refused
 * rather than dropped: the screen never sends one, so a client that does is wrong about what it is
 * saying, and keeping the rating while throwing its words away would tell that client its words
 * were kept. An empty note is no note.
 */
export function readAnswerRatingChoice(
  body: unknown,
):
  | { ok: true; choice: AnswerRatingChoice }
  | { ok: false; code: string; limit?: number } {
  if (!body || typeof body !== "object") {
    return { ok: false, code: RATING_INVALID };
  }
  const { rating, reason, note } = body as Record<string, unknown>;
  if (rating !== "up" && rating !== "down") {
    return { ok: false, code: RATING_INVALID };
  }
  if (
    reason !== undefined &&
    reason !== null &&
    !isAnswerRatingReason(reason)
  ) {
    return { ok: false, code: RATING_INVALID };
  }
  if (note !== undefined && note !== null && typeof note !== "string") {
    return { ok: false, code: RATING_INVALID };
  }
  const written = typeof note === "string" ? note.trim() : "";
  if (written.length > ANSWER_NOTE_MAX_LENGTH) {
    return {
      ok: false,
      code: RATING_NOTE_TOO_LONG,
      limit: ANSWER_NOTE_MAX_LENGTH,
    };
  }
  const chosen = isAnswerRatingReason(reason) ? reason : null;
  if (rating === "up" && (chosen !== null || written !== "")) {
    return { ok: false, code: RATING_INVALID };
  }
  return {
    ok: true,
    choice: { rating, reason: chosen, note: written === "" ? null : written },
  };
}

/** One rating as the person's screen reads it back. */
export type StoredAnswerRating = {
  id: string;
  channelId: string;
  messageId: string;
  agentId: string;
  rating: AnswerRating;
  reason: AnswerRatingReason | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A rating just recorded: what it is now, whose Bot it was about, and what it replaced. */
export type RecordedAnswerRating = StoredAnswerRating & {
  /** The Bot's name as it stands now, for the operator's line. */
  botName: string;
  /** The rating this one replaced, if any. Whether the operator is told is decided against it. */
  previous: { rating: AnswerRating; note: string | null } | null;
};

export type AnswerRatingOutcome =
  | { ok: true; rating: RecordedAnswerRating }
  | {
      ok: false;
      code: typeof RATING_CHANNEL_NOT_FOUND | typeof RATING_MESSAGE_NOT_FOUND;
    };

export type AnswerRatingStore = {
  /** Keep this person's rating of one answer, replacing any they gave it before. */
  record: (
    actor: AgentActor,
    input: AnswerRatingChoice & { channelId: string; messageId: string },
  ) => Promise<AnswerRatingOutcome>;
  /** This person's ratings in one conversation, or null when they are not in it. */
  list: (
    actor: AgentActor,
    channelId: string,
  ) => Promise<StoredAnswerRating[] | null>;
};

function stored(row: typeof lafAnswerRatings.$inferSelect): StoredAnswerRating {
  return {
    id: row.id,
    channelId: row.channelId,
    messageId: row.messageId,
    agentId: row.agentId,
    rating: row.rating,
    // Only the route writes this column, and only with a key from the list; read back the same way.
    reason: isAnswerRatingReason(row.reason) ? row.reason : null,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createAnswerRatingStore(database: Database): AnswerRatingStore {
  return {
    record: async (actor, input) => {
      // Membership, through the read every channel route uses: null for somebody not in it.
      const channel = await readChannel(database, actor, input.channelId);
      if (!channel) return { ok: false, code: RATING_CHANNEL_NOT_FOUND };
      if (input.messageId.length > MESSAGE_ID_MAX_LENGTH) {
        return { ok: false, code: RATING_MESSAGE_NOT_FOUND };
      }

      /*
       * THE ROLE AND THE BOT, AND NOT ONE WORD OF THE ANSWER. Two fields out of the jsonb, found
       * through the thread's unique index on the message id — so rating an answer costs one indexed
       * read however long the conversation, and the answer's text never enters this process.
       */
      const [answer] = await database
        .select({
          role: sql<string | null>`${lafThreadMessages.message} ->> 'role'`,
          agentId: sql<
            string | null
          >`${lafThreadMessages.message} ->> 'lafAgentId'`,
        })
        .from(lafThreadMessages)
        .where(
          and(
            eq(lafThreadMessages.threadId, channel.threadId),
            sql`(${lafThreadMessages.message} ->> 'id') = ${input.messageId}`,
          ),
        )
        .limit(1);
      if (answer?.role !== "assistant" || !answer.agentId) {
        return { ok: false, code: RATING_MESSAGE_NOT_FOUND };
      }
      const [bot] = await database
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, answer.agentId))
        .limit(1);
      if (!bot) return { ok: false, code: RATING_MESSAGE_NOT_FOUND };
      const agentId = answer.agentId;

      return database.transaction(async (transaction) => {
        const person = and(
          eq(lafAnswerRatings.userId, actor.id),
          eq(lafAnswerRatings.channelId, input.channelId),
          eq(lafAnswerRatings.messageId, input.messageId),
        );
        // Locked, so two presses racing on one answer decide "told already?" one after the other.
        const [previous] = await transaction
          .select({
            rating: lafAnswerRatings.rating,
            note: lafAnswerRatings.note,
          })
          .from(lafAnswerRatings)
          .where(person)
          .for("update");
        const [row] = await transaction
          .insert(lafAnswerRatings)
          .values({
            id: randomUUID(),
            userId: actor.id,
            channelId: input.channelId,
            messageId: input.messageId,
            agentId,
            rating: input.rating,
            reason: input.reason,
            note: input.note,
          })
          .onConflictDoUpdate({
            target: [
              lafAnswerRatings.userId,
              lafAnswerRatings.channelId,
              lafAnswerRatings.messageId,
            ],
            // The whole rating is replaced — a 좋아요 after a 아쉬워요 keeps no reason and no note.
            set: {
              agentId,
              rating: input.rating,
              reason: input.reason,
              note: input.note,
              updatedAt: sql`now()`,
            },
          })
          .returning();
        if (!row) throw new Error("laf:rating_not_recorded");
        return {
          ok: true,
          rating: {
            ...stored(row),
            botName: bot.name,
            previous: previous ?? null,
          },
        } as const;
      });
    },

    list: async (actor, channelId) => {
      const channel = await readChannel(database, actor, channelId);
      if (!channel) return null;
      const rows = await database
        .select()
        .from(lafAnswerRatings)
        .where(
          and(
            eq(lafAnswerRatings.userId, actor.id),
            eq(lafAnswerRatings.channelId, channelId),
          ),
        )
        .orderBy(asc(lafAnswerRatings.createdAt));
      return rows.map(stored);
    },
  };
}

/** Whether this rating is one the operator hears about. See "WHO IS TOLD" above. */
export function tellsTheOperator(
  rating: Pick<RecordedAnswerRating, "rating" | "note" | "previous">,
): boolean {
  if (rating.rating !== "down" || !rating.note) return false;
  const { previous } = rating;
  return !(previous?.rating === "down" && previous.note === rating.note);
}

/** What the outbox row carries for a rating the operator is told about. */
export function answerRatingFacts(
  rating: RecordedAnswerRating & { note: string },
): AnswerRatingFacts {
  return {
    ratingId: rating.id,
    channelId: rating.channelId,
    messageId: rating.messageId,
    agentId: rating.agentId,
    botName: rating.botName,
    reason: rating.reason,
    note: rating.note,
  };
}

/** The operator's words for a reason. The person's screen has its own (`app/src/lib/support`). */
const REASON_WORDS: Record<AnswerRatingReason, string> = {
  "not-as-asked": "요청과 달라요",
  "wrong-facts": "사실과 달라요",
  "too-slow": "너무 느려요",
  other: "그 밖에",
};

/** The body the alert webhook receives: the same three-part shape as a 문의·의견 message. */
export type AnswerRatingAlertBody = {
  text: string;
  content: string;
  rating: {
    id: string;
    origin: string;
    rating: "down";
    reason: string | null;
    note: string;
    bot: { id: string; name: string };
    channelId: string;
    messageId: string;
    at: string;
  };
};

/**
 * The line, in the fleet alert's register: a `[LAF]` prefix, what happened, the origin; then the
 * Bot and the reason, what the person wrote on a line of its own so a chat client shows it whole,
 * and the ids — with the fact that the answer is not in it said out loud, so the operator reading
 * the line does not go looking for it in the message.
 *
 * Built field by field: the facts are JSON read back out of an outbox row, and only the fields
 * named here may cross whatever else a stored row came to carry.
 */
export function answerRatingAlertBody(
  facts: AnswerRatingFacts,
  origin: string,
  at: string,
): AnswerRatingAlertBody {
  const reason = typeof facts.reason === "string" ? facts.reason : null;
  const said = reason
    ? (REASON_WORDS[reason as AnswerRatingReason] ?? reason)
    : "고르지 않음";
  const text = [
    `[LAF] 답변이 아쉬워요 · ${origin || "(origin unset)"}`,
    `봇: ${facts.botName} · 이유: ${said}`,
    facts.note,
    `평가 ${facts.ratingId} · 대화 ${facts.channelId} · 메시지 ${facts.messageId} (답변 내용은 싣지 않음)`,
  ].join("\n");
  return {
    text,
    content: text,
    rating: {
      id: facts.ratingId,
      origin,
      rating: "down",
      reason,
      note: facts.note,
      bot: { id: facts.agentId, name: facts.botName },
      channelId: facts.channelId,
      messageId: facts.messageId,
      at,
    },
  };
}
