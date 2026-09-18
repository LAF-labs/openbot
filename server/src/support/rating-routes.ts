/**
 * `PUT /api/support/ratings/:channelId/:messageId`: 좋아요 or 아쉬워요 under one of a Bot's answers.
 * `GET /api/support/ratings/:channelId`: the ones this person left in one conversation, so the
 * transcript draws them again after a reload.
 *
 * Under `/api/support` because this is the 문의·의견 box's door, reached from a different place: what
 * a person thinks of an answer is for the people who run the product, it reaches them through the
 * same outbox and the same alert webhook, and a second door to the operator would be a second thing
 * to keep honest.
 *
 * PUT, BECAUSE A SECOND PRESS REPLACES THE FIRST. The answer names the rating as it now stands and
 * which doors told the operator about it — `told` is empty for every 좋아요, for 아쉬워요 with
 * nothing written, and for a note sent again unchanged, which is the truth in each case.
 *
 * FACTS, NEVER SENTENCES, as everywhere else: a refusal is a code and the screen owns the words.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { NotificationOutbox } from "../notifications/outbox";
import {
  type AnswerRatingStore,
  answerRatingFacts,
  RATING_CHANNEL_NOT_FOUND,
  readAnswerRatingChoice,
  tellsTheOperator,
} from "./answer-ratings";

export function createAnswerRatingRoutes(
  service: {
    ratings: AnswerRatingStore;
    /** Absent on a deployment without one: the rating is kept and `told` is empty. */
    outbox?: NotificationOutbox;
  },
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:channelId", requireUser, async (context) => {
    const ratings = await service.ratings.list(
      context.var.actor,
      context.req.param("channelId"),
    );
    if (!ratings) {
      return context.json(
        { error: RATING_CHANNEL_NOT_FOUND, code: RATING_CHANNEL_NOT_FOUND },
        404,
      );
    }
    return context.json({
      ratings: ratings.map((rating) => ({
        messageId: rating.messageId,
        rating: rating.rating,
        reason: rating.reason,
        note: rating.note,
        updatedAt: rating.updatedAt.toISOString(),
      })),
    });
  });

  routes.put("/:channelId/:messageId", requireUser, async (context) => {
    const actor = context.var.actor;
    // Refused on its shape before anything is looked up, so a bad body writes nothing anywhere.
    const read = readAnswerRatingChoice(
      await context.req.json().catch(() => null),
    );
    if (!read.ok) {
      return context.json(
        {
          error: read.code,
          code: read.code,
          ...(read.limit === undefined ? {} : { limit: read.limit }),
        },
        400,
      );
    }

    const outcome = await service.ratings.record(actor, {
      channelId: context.req.param("channelId"),
      messageId: context.req.param("messageId"),
      ...read.choice,
    });
    if (!outcome.ok) {
      return context.json({ error: outcome.code, code: outcome.code }, 404);
    }
    const rating = outcome.rating;

    /*
     * The telling, after the row, exactly as a 문의·의견 message is told: `enqueue` never throws and
     * answers null when it could not write, and the rating is kept either way — so the worst this
     * can do is leave `told` empty, which is then the truth.
     */
    const note = rating.note;
    const notice =
      service.outbox && note && tellsTheOperator(rating)
        ? await service.outbox.enqueue({
            kind: "support.answer_rating",
            botId: rating.agentId,
            userId: actor.id,
            channelId: rating.channelId,
            rating: answerRatingFacts({ ...rating, note }),
          })
        : null;

    return context.json({
      id: rating.id,
      messageId: rating.messageId,
      rating: rating.rating,
      reason: rating.reason,
      note: rating.note,
      updatedAt: rating.updatedAt.toISOString(),
      told: notice?.deliveredVia ?? [],
    });
  });

  return routes;
}
