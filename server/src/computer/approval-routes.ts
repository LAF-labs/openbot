/**
 * Where a person answers the questions a boundary raised, wherever it raised them.
 *
 * Its own surface rather than a pair of handlers under the computer, because the computer is not the
 * only thing the action policy judges. The same rules decide a Bot's calls to somebody else's
 * servers, an `ask` rule written about those is the shape operators reach for first, "ask me before
 * anything changes anything in Jira", and a deployment that runs plugins without a browser would
 * otherwise raise questions on a surface it never mounted: the Bot would sit for the full ten
 * minutes and then report that nobody answered, having never asked anybody.
 *
 * Answering is a person acting, so it is audited as one, under their own actor and against the thing
 * the question was about rather than against whatever endpoint they happened to press the button on.
 * The row is written here, next to the answer, because these two handlers are the only place in the
 * product where consent is recorded and a second place would eventually record it differently.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import type { AppVariables } from "../auth/guards";
import { requireAdmin, requireAdminRoute } from "../auth/guards";
import {
  type ApprovalRegistry,
  type PendingApproval,
  presentable,
} from "./approvals";
import type {
  StandingApproval,
  StandingApprovalStore,
} from "./standing-approvals";

export function createApprovalRoutes(
  approvals: ApprovalRegistry,
  auditStore: AuditStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * The allowances, so a person can answer the wider question once and take it back later.
   *
   * Optional: without one the answering handler simply ignores `always`, and the two handlers below
   * report an empty list and refuse to withdraw anything. A deployment that has not wired it up
   * behaves exactly as this file did before — every asked action asks — rather than accepting a
   * widening it has nowhere to record.
   */
  standing?: StandingApprovalStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /*
   * BEFORE `/:botId`, and it has to stay there. Hono matches in registration order, so a `/standing`
   * registered after the parameter route is a Bot whose id happens to be "standing" — the list would
   * answer with that Bot's open questions and nothing anywhere would look wrong.
   */

  /**
   * What this deployment has stopped asking about.
   *
   * The owner's, like answering: this is the list of places a boundary has been stood down, and it
   * names the Bot, the rule and the scope. `GET /api/approvals/:botId` next door is readable by any
   * signed-in person, which is its own thing to fix; this one is not going to inherit it.
   */
  routes.get("/standing", requireUser, requireAdminRoute, async (context) => {
    const botId = context.req.query("bot");
    return context.json({
      standing: (await standing?.list(botId || undefined)) ?? [],
    });
  });

  /**
   * Ask to be asked again. The row stays and is marked; see the table's own comment.
   *
   * The guard is in the route's declaration rather than inside the handler, like the read above it:
   * these two are the list of places a boundary has been stood down and the button that puts one
   * back, and a check that lives in the middle of a function body is a check an unrelated edit can
   * drop while everything still compiles.
   */
  routes.delete(
    "/standing/:id",
    requireUser,
    requireAdminRoute,
    async (context) => {
      const record = context.var.actor;
      const revoked = await standing?.revoke(
        context.req.param("id") ?? "",
        record.id,
      );
      // Already withdrawn, or never granted here. Nothing is broken and there is nothing to retry —
      // the same conflict an answered question reports, for the same reason.
      if (!revoked) {
        return context.json(
          { error: "That allowance is no longer standing." },
          409,
        );
      }
      await recordAuditEvent(auditStore, {
        eventType: "approval.standing_revoked",
        targetType: "bot",
        targetId: revoked.botId,
        ...(record.email === DEV_ACTOR.email ? {} : { actorUserId: record.id }),
        payload: standingPayload(revoked, record.id),
      });
      return context.json(revoked);
    },
  );

  /**
   * The questions this Bot is waiting on, for the surface to poll.
   *
   * A read, so no audit row, exactly like asking who holds the wheel. The interesting rows are the
   * one written when the question was raised and the one written when somebody answered it.
   */
  routes.get("/:botId", requireUser, async (context) =>
    context.json({
      approvals: (
        await approvals.pending(context.req.param("botId") ?? "")
      ).map(presentable),
    }),
  );

  /**
   * Answering is deciding for the deployment, so it is the owner's alone: in
   * this build every administrator is the owner, and nobody else's yes can
   * spend a Bot's approval. Routing a question to a named approver other than
   * the owner is a later, multi-person feature — until then the narrow rule is
   * the honest one.
   */
  routes.post("/:botId/:approvalId", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    // Said explicitly, never defaulted. A body that forgot to say which way it went must not be
    // read as an approval, and reading a missing field as a refusal would be equally wrong.
    if (typeof body?.granted !== "boolean") {
      return context.json(
        { error: "Say whether this is allowed or not." },
        400,
      );
    }

    const botId = context.req.param("botId") ?? "";
    const record = context.var.actor;
    const answered = await approvals.answer(
      context.req.param("approvalId") ?? "",
      botId,
      record.id,
      body.granted,
    );
    // Nothing is broken and there is nothing to fix: the question expired, or somebody else answered
    // it, most likely in another tab. A conflict rather than a fault.
    if (!answered.ok) {
      return context.json(
        {
          error:
            "That request is no longer waiting for an answer. It may have expired, or somebody else answered it.",
        },
        409,
      );
    }

    await recordAuditEvent(auditStore, {
      eventType: body.granted ? "approval.granted" : "approval.denied",
      targetType: answered.approval.target.type,
      targetId: answered.approval.target.id,
      // Only a real users row may go in the audit table's foreign key column. The local development
      // actor is not one, so writing it there fails the constraint and loses the row entirely. Who
      // it was is recorded in the payload regardless.
      ...(record.email === DEV_ACTOR.email ? {} : { actorUserId: record.id }),
      payload: payloadFor(answered.approval, record.id),
    });

    /*
     * "And stop asking me about this."
     *
     * The scope is read off the approval, never off the body. The request says only that the person
     * pressed the wider button; WHAT that covers was decided when the question was raised, from the
     * action itself, and is the same string the surface printed on the button. A body that could
     * name its own scope would let a page show "always allow this one site" and grant every site.
     *
     * Granted after the answer, and only when the answer was yes: "always deny" is not a thing this
     * offers, because a person who wants an action forbidden should write it into the boundary where
     * everybody can see it rather than leave a refusal buried in an allowance table.
     *
     * Its own row in the trail, because this is an edit to the boundary rather than an answer to a
     * question — see the type's own comment in audit.ts.
     */
    if (body.granted && body.always === true && standing) {
      const scope = answered.approval.scope;
      if (scope) {
        const granted = await standing.grant({
          botId: answered.approval.botId,
          rule: answered.approval.rule,
          scope,
          question: answered.approval.question,
          grantedBy: record.id,
        });
        await recordAuditEvent(auditStore, {
          eventType: "approval.standing_granted",
          targetType: "bot",
          targetId: granted.botId,
          ...(record.email === DEV_ACTOR.email
            ? {}
            : { actorUserId: record.id }),
          payload: {
            ...standingPayload(granted, record.id),
            approval: answered.approval.id,
          },
        });
      }
    }

    // Projected, like the list above. What the surface does with an answer is stop showing the
    // question, and nothing it needs for that is worth sending the binding out of this process for.
    return context.json(presentable(answered.approval));
  });

  return routes;
}

/**
 * What an answer records: the question, the boundary that raised it, and who answered.
 *
 * The Bot whose turn met the rule comes off the approval rather than out of the request, so the row
 * says which Bot it was actually about even if somebody arrives at the wrong address with a real id.
 */
/**
 * What an allowance records: which Bot, which boundary, and exactly how wide.
 *
 * The scope in both halves — as one string and split — so a reader filtering the trail can find
 * every allowance about one host without knowing how the key is spelled, and the question is the
 * sentence the person was reading when they widened it.
 */
function standingPayload(standing: StandingApproval, actor: string) {
  return {
    bot: standing.botId,
    actor,
    allowance: standing.id,
    rule: standing.rule,
    scope: standing.scope,
    scopeKind: standing.scopeKind,
    scopeValue: standing.scopeValue,
    reason: standing.question,
    grantedBy: standing.grantedBy,
  };
}

function payloadFor(approval: PendingApproval, answeredBy: string) {
  return {
    bot: approval.botId,
    actor: answeredBy,
    approval: approval.id,
    rule: approval.rule,
    // The question as a person read it, so the trail records what they were shown rather than a
    // reconstruction of it.
    reason: approval.question,
    // Who was driving when the boundary stopped, which is usually not who answered. The gap between
    // the two is the reason this is its own row.
    asked: approval.actor,
  };
}
