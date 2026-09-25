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
import { requireAdminRoute, requireBotAccess } from "../auth/guards";
import {
  type ApprovalRegistry,
  type PendingApproval,
  presentable,
} from "./approvals";
import type {
  AllowanceTier,
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
  /**
   * "They have answered, so stop telling them about it."
   *
   * The notification outbox, reached as one function rather than as a store, so this file goes on
   * knowing nothing about how somebody was told — a webhook, the page's own socket, a message on
   * their phone one day. Absent leaves every notification for this question sitting unseen until
   * the person opens the list, which is not wrong so much as untidy: the question is gone and the
   * row says it is still waiting.
   *
   * Fire-and-forget after the answer has been recorded. An outbox that is having a bad minute must
   * not turn a person's yes into a 500.
   */
  onAnswered?: (approvalId: string) => void,
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
   * The administrator's, and NOT like answering, which is each Bot's owner's (below): this is the
   * list of places a boundary has been stood down, and it names the Bot, the rule and the scope.
   * `GET /api/approvals/:botId` next door is the Bot's driver's; this one names every Bot at once,
   * so it is narrower still.
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
        ...(record.email === DEV_ACTOR.email ? {} : { actorUserId: record.id }),
        payload: standingPayload(revoked, record.id),
      });
      return context.json(revoked);
    },
  );

  /*
   * WHOSE BOT, ON BOTH OF THESE.
   *
   * The list read any Bot's open questions for any signed-in person — measured 2026-09-10 (audit
   * A8): a colleague naming the owner's Bot got 200 and, once a question was waiting, the URL, the
   * host, the tool and the scope of what the owner's Bot was about to do. The comment on
   * `/standing` above called that "its own thing to fix"; this is it. `requireBotAccess` also owns
   * the shape check the two handlers used to carry themselves, so a malformed id is still a 400 and
   * still refused before it is used as a key — see the guard.
   */

  /**
   * The questions this Bot is waiting on, for the surface to poll.
   *
   * A read, so no audit row, exactly like asking who holds the wheel. The interesting rows are the
   * one written when the question was raised and the one written when somebody answered it.
   */
  routes.get("/:botId", requireUser, requireBotAccess(), async (context) => {
    const botId = context.req.param("botId") ?? "";
    return context.json({
      /*
       * A lambda, never `.map(presentable)`: `map` hands the index as the second argument, which is
       * `presentable`'s clock, so every question read as held at time zero. MEASURED 2026-09-25
       * (0.5.4 final QA): a window closed without its `pagehide` (a crash, a killed process) left
       * its holder behind, the list said `held: true` for the question's whole ten minutes, no other
       * window took the step on, and an answer given on the phone went nowhere.
       */
      approvals: (await approvals.pending(botId)).map((approval) =>
        presentable(approval),
      ),
    });
  });

  /**
   * Answering is the Bot's owner's: the person the question was raised for, and the one its notice
   * reaches (the outbox names the run's own actor, never a role). Nobody else's yes can spend a
   * Bot's approval; routing a question to a named approver other than the owner is a later,
   * multi-person feature.
   *
   * OWNERSHIP IS THE WHOLE OF THE RULE — `requireBotAccess`, the predicate every other door a Bot id
   * opens asks. This handler used to require the administrator's role as well, on the reasoning
   * that "every administrator is the owner"; once `397213f` took the administrator exception out of
   * the ownership guard, the pair admitted nobody to a `user`'s Bot. Its owner was told 403, the
   * administrator 404, and every ask on it ran out its ten minutes (audit R1-02, R3-06, R5-06,
   * 2026-09-16). A Bot that is not yours is still "not here", before the question is looked up.
   */
  routes.post(
    "/:botId/:approvalId",
    requireUser,
    requireBotAccess(),
    async (context) => {
      const body = (await context.req.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      // Said explicitly, never defaulted. A body that forgot to say which way it went must not be
      // read as an approval, and reading a missing field as a refusal would be equally wrong.
      if (typeof body?.granted !== "boolean") {
        return context.json(
          {
            error: "laf:approval_answer_missing",
            code: "laf:approval_answer_missing",
          },
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
        tierOf(body),
      );
      // Nothing is broken and there is nothing to fix: the question expired, or somebody else answered
      // it, most likely in another tab. A conflict rather than a fault.
      if (!answered.ok) {
        return context.json(
          {
            error: "laf:approval_not_waiting",
            code: "laf:approval_not_waiting",
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

      // After the row, never before it: the trail is the record and the notification is bookkeeping.
      onAnswered?.(answered.approval.id);

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
       *
       * THE MIDDLE ANSWER binds to the thread the question was raised from, which is on the approval
       * for the same reason the scope is: a body that could name the thread could bind an allowance
       * to a conversation the person was not looking at. A question with no thread on it — raised
       * from outside any conversation — cannot be answered that way, and the card did not offer it;
       * a request that asks anyway gets the once it did give and no allowance, rather than a
       * standing one it did not ask for.
       */
      // Off the answered record, which kept only a tier this question could give (`tierGiven`).
      const tier = answered.approval.tier;
      if (body.granted && tier && standing) {
        const scope = answered.approval.scope;
        const threadId = answered.approval.threadId;
        if (scope && (tier === "always" || threadId)) {
          const granted = await standing.grant({
            botId: answered.approval.botId,
            rule: answered.approval.rule,
            scope,
            subject: answered.approval.subject,
            grantedBy: record.id,
            tier,
            ...(tier === "thread" ? { threadId } : {}),
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
    },
  );

  /**
   * "Ask me again": the person taking their own No back, from the line the answered card left.
   *
   * Nothing is reopened and nothing is granted. The No stood for thirty minutes after its question
   * closed (DECLINE_STICKS_MS), so a person who changed their mind had no way to say so and the Bot
   * was refused without asking; now the next attempt at the action raises a fresh question, which
   * is answered on a card like any other. The same person as answering (`requireBotAccess`), and a
   * row of its own, since it changes what the boundary does next.
   */
  routes.post(
    "/:botId/:approvalId/reconsider",
    requireUser,
    requireBotAccess(),
    async (context) => {
      const botId = context.req.param("botId") ?? "";
      const record = context.var.actor;
      const lifted = await approvals.liftDecline(
        context.req.param("approvalId") ?? "",
        botId,
      );
      // Ran out, already taken back, or forgotten by a restart: the next attempt asks either way.
      if (!lifted.ok) {
        return context.json(
          {
            error: "laf:decline_not_standing",
            code: "laf:decline_not_standing",
          },
          409,
        );
      }
      await recordAuditEvent(auditStore, {
        eventType: "approval.decline_lifted",
        targetType: lifted.approval.target.type,
        targetId: lifted.approval.target.id,
        ...(record.email === DEV_ACTOR.email ? {} : { actorUserId: record.id }),
        payload: payloadFor(lifted.approval, record.id),
      });
      return context.json({ lifted: true });
    },
  );

  /*
   * WHICH WINDOW CARRIES A STEP ON (UX review 0.5.4, candidate 1).
   *
   * A question used to live only as long as the window whose tool call raised it: close or reload
   * that window and the card was gone, and nothing could carry the Bot's step on once somebody
   * answered. The question now names its step (`ApprovalStep`), every window of the conversation
   * draws it, and exactly one of them holds it — the one that will send the action once it is
   * allowed and hand the result back to the Bot. These three are how a window says so. All three
   * are the Bot's owner's, like answering; none of them answers anything.
   */

  /** "I am still waiting on this, and I will carry it on." Polled by the holding window. */
  routes.post(
    "/:botId/:approvalId/hold",
    requireUser,
    requireBotAccess(),
    async (context) => {
      const holder = holderOf(await context.req.json().catch(() => null));
      if (!holder) {
        return context.json(
          { error: "laf:holder_missing", code: "laf:holder_missing" },
          400,
        );
      }
      const held = await approvals.hold(
        context.req.param("approvalId") ?? "",
        context.req.param("botId") ?? "",
        holder,
      );
      if (!held.ok) {
        return context.json(
          {
            error: "laf:approval_not_waiting",
            code: "laf:approval_not_waiting",
          },
          409,
        );
      }
      return context.json({
        approval: presentable(held.approval),
        holding: held.holding,
      });
    },
  );

  /**
   * "This window is going away": sent as the page is hidden for good, so the next window to open
   * the conversation takes the step at once instead of waiting out the quiet. Always 200 — there is
   * nothing for a page that is closing to do with a refusal.
   */
  routes.post(
    "/:botId/:approvalId/release",
    requireUser,
    requireBotAccess(),
    async (context) => {
      const holder = holderOf(await context.req.json().catch(() => null));
      const released = holder
        ? await approvals.release(
            context.req.param("approvalId") ?? "",
            context.req.param("botId") ?? "",
            holder,
          )
        : false;
      return context.json({ released });
    },
  );

  /** The turn that raised it was stopped: nobody is waiting for this answer any more. */
  routes.post(
    "/:botId/:approvalId/withdraw",
    requireUser,
    requireBotAccess(),
    async (context) => {
      const record = context.var.actor;
      const withdrawn = await approvals.withdraw(
        context.req.param("approvalId") ?? "",
        context.req.param("botId") ?? "",
      );
      if (!withdrawn) {
        return context.json(
          {
            error: "laf:approval_not_waiting",
            code: "laf:approval_not_waiting",
          },
          409,
        );
      }
      // The notice about it is stale in the same way an answered one's is.
      onAnswered?.(withdrawn.id);
      await recordAuditEvent(auditStore, {
        eventType: "approval.withdrawn",
        targetType: withdrawn.target.type,
        targetId: withdrawn.target.id,
        ...(record.email === DEV_ACTOR.email ? {} : { actorUserId: record.id }),
        payload: payloadFor(withdrawn, record.id),
      });
      return context.json({ withdrawn: true });
    },
  );

  return routes;
}

/**
 * The window's own name for itself, off a body. A made-up id, checked for shape only: it
 * authorises nothing, it only tells one window from another.
 */
function holderOf(body: unknown): string | undefined {
  const holder = (body as { holder?: unknown } | null)?.holder;
  return typeof holder === "string" && /^[A-Za-z0-9-]{8,64}$/.test(holder)
    ? holder
    : undefined;
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
 * every allowance about one host without knowing how the key is spelled, and the subject is what the
 * Bot was about to do when they widened it.
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
    // How long it was meant to last, and for which conversation where it was one. A reader
    // counting what has been stood down for good must be able to leave the afternoon's out.
    tier: standing.tier,
    ...(standing.threadId ? { thread: standing.threadId } : {}),
    ...(standing.expiresAt ? { expiresAt: standing.expiresAt } : {}),
    ...(standing.subject ? { subject: standing.subject } : {}),
    grantedBy: standing.grantedBy,
  };
}

/**
 * Which of the wider answers the body asked for, or undefined for "this once".
 *
 * `tier` is the field; `always: true` is what the card sent before the middle answer existed and
 * still means what it meant. Anything else — a tier this build does not know — is read as "this
 * once", because a widening nobody can name is not one anybody consented to.
 */
function tierOf(body: Record<string, unknown>): AllowanceTier | undefined {
  if (body.tier === "always" || body.tier === "thread") return body.tier;
  if (body.always === true) return "always";
  return undefined;
}

function payloadFor(approval: PendingApproval, answeredBy: string) {
  return {
    bot: approval.botId,
    actor: answeredBy,
    approval: approval.id,
    rule: approval.rule,
    // What they were shown, in the same facts the card was drawn from. A sentence here would be a
    // second description of the question, written by a server that does not speak the language the
    // person answered in.
    subject: approval.subject,
    // Who was driving when the boundary stopped, which is usually not who answered. The gap between
    // the two is the reason this is its own row.
    asked: approval.actor,
  };
}
