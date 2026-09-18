/**
 * 좋아요·아쉬워요 under a Bot's answer: the calls, and the exact shape of what they send.
 *
 * THE BODY IS BUILT HERE AND NOWHERE ELSE, and it is not handed the answer: which way, a reason key,
 * and what the person wrote are the only things it can carry. The server keeps only those keys
 * whatever arrives (`server/src/support/answer-ratings.ts`), and a client that never sends more is
 * the half of that promise this file owns — `answer-rating.test.ts` serialises the body and says so.
 *
 * WHAT THE SCREEN DRAWS IS WHAT THE SERVER KEPT. A press is drawn as pressed once the route has
 * answered with the rating as it now stands, never on the press itself: a control that lit up for a
 * rating the server refused would be telling somebody their opinion had been heard when it had not.
 */
import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";

export type AnswerRating = "up" | "down";

/** The reasons 아쉬워요 offers, as the server's keys. The words are the popover's own. */
export const ANSWER_RATING_REASONS = [
  "not-as-asked",
  "wrong-facts",
  "too-slow",
  "other",
] as const;
export type AnswerRatingReason = (typeof ANSWER_RATING_REASONS)[number];

/** The server's limit, repeated so the box can stop somebody before the refusal. */
export const ANSWER_NOTE_MAX_LENGTH = 500;

/** One answer's rating, as the server kept it. */
export type RatedAnswer = {
  rating: AnswerRating;
  reason: AnswerRatingReason | null;
  note: string | null;
  updatedAt: string;
};

/** Message id to its rating, for one conversation. An answer nobody rated is simply absent. */
export type AnswerRatings = Readonly<Record<string, RatedAnswer>>;

/** What a press asks for. */
export type RatingChoice = {
  rating: AnswerRating;
  reason: AnswerRatingReason | null;
  note: string;
};

/** The rating as the server now holds it, and which doors told the operator about it. */
export type RatingReceipt = RatedAnswer & { told: string[] };

/**
 * The refusals the route can answer with, in the English `t()` reads as a key.
 *
 * `t()` on a variable is invisible to `i18n-coverage.test.ts`; `answer-rating.test.ts` walks this
 * table, and checks it against the codes the server's module declares.
 */
export const RATING_REFUSALS: Record<string, string> = {
  "laf:rating_invalid": "That did not save. Try again.",
  "laf:rating_note_too_long":
    "That is over {limit} characters. Shorten it a little.",
  "laf:rating_message_not_found": "This answer can no longer be rated.",
  "laf:channel_not_found": "This conversation is no longer here.",
};

/** The code a refused rating answered with, beside the sentence this screen says for it. */
export class RatingRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RatingRefusedError";
    this.code = code;
  }
}

const isRating = (value: unknown): value is AnswerRating =>
  value === "up" || value === "down";

const isReason = (value: unknown): value is AnswerRatingReason =>
  typeof value === "string" &&
  (ANSWER_RATING_REASONS as readonly string[]).includes(value);

/** A rating read off the wire, or null when it is not one this screen could draw. */
function ratedAnswerOf(value: unknown): RatedAnswer | null {
  if (!value || typeof value !== "object") return null;
  const held = value as Record<string, unknown>;
  if (!isRating(held.rating) || typeof held.updatedAt !== "string") {
    return null;
  }
  return {
    rating: held.rating,
    reason: isReason(held.reason) ? held.reason : null,
    note: typeof held.note === "string" ? held.note : null,
    updatedAt: held.updatedAt,
  };
}

/** Exactly what is sent: the rating, and for 아쉬워요 a reason and words when there are any. */
export function ratingBody(choice: RatingChoice): {
  rating: AnswerRating;
  reason?: AnswerRatingReason;
  note?: string;
} {
  if (choice.rating === "up") return { rating: "up" };
  const note = choice.note.trim();
  return {
    rating: "down",
    ...(choice.reason ? { reason: choice.reason } : {}),
    ...(note ? { note } : {}),
  };
}

const ratingsPath = (channelId: string) =>
  `/api/support/ratings/${encodeURIComponent(channelId)}`;

export async function rateAnswer(
  channelId: string,
  messageId: string,
  choice: RatingChoice,
  fetchImpl: typeof fetch = fetch,
): Promise<RatingReceipt> {
  const response = await fetchImpl(
    `${ratingsPath(channelId)}/${encodeURIComponent(messageId)}`,
    {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ratingBody(choice)),
    },
  );
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : "";
    const known = RATING_REFUSALS[code];
    throw new RatingRefusedError(
      code,
      known
        ? t(known, {
            limit:
              typeof body?.limit === "number"
                ? body.limit
                : ANSWER_NOTE_MAX_LENGTH,
          })
        : t("That did not save. Try again."),
    );
  }
  const rated = ratedAnswerOf(body);
  if (!rated) throw new Error(t("That did not save. Try again."));
  return {
    ...rated,
    told: Array.isArray(body?.told)
      ? body.told.filter((door): door is string => typeof door === "string")
      : [],
  };
}

/**
 * This person's ratings in one conversation.
 *
 * THROWS when the server will not say, rather than answering "none": a deployment with no rating
 * route, or a conversation this person cannot rate in, is one where the controls must not be drawn
 * at all — a 좋아요 that saves nowhere is worse than no 좋아요.
 */
export async function readAnswerRatings(
  channelId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AnswerRatings> {
  const response = await fetchImpl(ratingsPath(channelId), {
    credentials: "include",
  });
  const body = (await response.json().catch(() => null)) as {
    ratings?: unknown;
  } | null;
  if (!response.ok || !Array.isArray(body?.ratings)) {
    throw new Error(t("That did not save. Try again."));
  }
  const ratings: Record<string, RatedAnswer> = {};
  for (const entry of body.ratings as unknown[]) {
    const messageId = (entry as { messageId?: unknown } | null)?.messageId;
    const rated = ratedAnswerOf(entry);
    if (typeof messageId === "string" && rated) ratings[messageId] = rated;
  }
  return ratings;
}

export const answerRatingKeys = {
  channel: (channelId: string) => ["answer-ratings", channelId] as const,
};

/**
 * One read per conversation, shared by every answer in it — each control selects its own row.
 *
 * Never stale on its own: the only thing that changes a rating is a press in this tab, and the
 * press writes the server's answer into this cache (`AnswerRatingControls`). No retry: a refusal
 * here is a fact about the deployment, not a flake, and it is what hides the controls.
 */
export function answerRatingsQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: answerRatingKeys.channel(channelId),
    queryFn: () => readAnswerRatings(channelId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}
