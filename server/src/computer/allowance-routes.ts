/**
 * "What I have told my Bot it need not ask me about", for the person who told it.
 *
 * The same rows as `/api/approvals/standing`, which is the administrator's door and names every Bot
 * at once. This one is the owner's, for one Bot, behind the ownership guard rather than the role:
 * the 0.5.4 review measured the card promising "관리 화면에서 취소할 때까지" to an owner who was
 * not an administrator and could not open that screen at all, so the "항상 허용" they pressed had
 * no way back that they could find — a boundary lying by omission (ux-review-0.5.4 §1.7).
 *
 * READ FROM THE STORE THE GATEWAY CONSULTS, not from a copy: what this lists is exactly what
 * `settle.ts` finds, and a revoke here is the same `revoke` the administrator's button calls, marked
 * under the person who pressed it and written to the trail under the same event.
 *
 * And it says whether the list is in force. With `settleWithoutAsking` off nothing on it is
 * honoured; a list headed "not asked about" that is in fact being asked about is the lie the admin
 * page already refuses to tell, so this answer carries the switch for the surface to say so.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import type { AppVariables } from "../auth/guards";
import { requireBotAccess } from "../auth/guards";
import type { ActionPolicy } from "./policy";
import type { StandingApprovalStore } from "./standing-approvals";

export function createAllowanceRoutes(
  standing: StandingApprovalStore,
  auditStore: AuditStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** The policy in force, for its one switch. Absent reads as the default, which is "allowed". */
  policy?: () => ActionPolicy | undefined,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const inForce = () =>
    (policy?.()?.settleWithoutAsking ?? "allowed") === "allowed";

  routes.get(
    "/:botId/allowances",
    requireUser,
    requireBotAccess(),
    async (context) =>
      context.json({
        allowances: await standing.list(context.req.param("botId")),
        inForce: inForce(),
      }),
  );

  routes.delete(
    "/:botId/allowances/:id",
    requireUser,
    requireBotAccess(),
    async (context) => {
      const botId = context.req.param("botId");
      const id = context.req.param("id");
      const actor = context.var.actor;
      /*
       * THIS BOT'S, OR NOT HERE. `revoke` takes an id and nothing else, so without this an owner
       * could withdraw an allowance on a Bot that is not theirs by naming its id under their own.
       * A row's Bot never changes, so reading the list first is not a race.
       */
      const mine = (await standing.list(botId)).some((row) => row.id === id);
      const revoked = mine ? await standing.revoke(id, actor.id) : null;
      if (!revoked) {
        // Already withdrawn (another tab), run out, or never this Bot's: the list is simply stale.
        return context.json(
          {
            error: "laf:allowance_not_standing",
            code: "laf:allowance_not_standing",
          },
          409,
        );
      }
      await recordAuditEvent(auditStore, {
        eventType: "approval.standing_revoked",
        targetType: "bot",
        targetId: revoked.botId,
        ...(actor.email === DEV_ACTOR.email ? {} : { actorUserId: actor.id }),
        payload: {
          bot: revoked.botId,
          allowance: revoked.id,
          rule: revoked.rule,
          scope: revoked.scope,
          scopeKind: revoked.scopeKind,
          scopeValue: revoked.scopeValue,
          tier: revoked.tier,
          grantedBy: revoked.grantedBy,
          grantedAt: revoked.grantedAt,
          revokedBy: actor.id,
          // Which door, so the trail can tell the owner's profile from the administrator's page.
          via: "profile",
        },
      });
      return context.json(revoked);
    },
  );

  return routes;
}
