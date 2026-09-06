/**
 * `POST /api/support/feedback`: the 문의·의견 box, as the browser reaches it.
 *
 * FACTS, NEVER SENTENCES. A refusal carries a code and the surface owns the words, the same
 * arrangement `account/routes.ts` and the consent call use. The answer to a message that landed is
 * three facts: the row's id, when it was received, and which doors told the operator — which is
 * what lets the box say 보냈습니다 as something the server said rather than something the box hoped.
 *
 * WHAT THE SERVER KEEPS FROM THE BODY, AND WHAT IT DOES NOT. The text, and — only inside `screen`,
 * which is present only when the person ticked the box — a path and a failure code. Nothing else
 * is read. A client that sent a screenshot, a transcript or a Bot's last answer under any other key
 * would find none of it stored, because the shape of the row is the rule and the route never
 * copies the body into it. The tests send exactly that and assert it went nowhere.
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { NotificationOutbox } from "../notifications/outbox";
import { FEEDBACK_MAX_LENGTH, type FeedbackStore } from "./feedback";

export type SupportService = {
  feedback: FeedbackStore;
  auditStore: AuditStore;
  /** Absent on a deployment without one; the row is kept and `told` is empty. */
  outbox?: NotificationOutbox;
};

/** A path, not a URL: the query and the fragment go, and it has to start at the root. */
const ROUTE_MAX_LENGTH = 200;
/** The shape every failure code in this product has: `laf:turn_rate_limited`, `laf.empty_answer`. */
const FAILURE_CODE = /^laf[:.][a-z0-9_.]{1,60}$/;

function screenRoute(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith("/") || path.length > ROUTE_MAX_LENGTH) return undefined;
  return path;
}

function screenFailure(value: unknown): string | undefined {
  return typeof value === "string" && FAILURE_CODE.test(value)
    ? value
    : undefined;
}

export function createSupportRoutes(
  service: SupportService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/feedback", requireUser, async (context) => {
    const actor = context.var.actor;
    const body = (await context.req.json().catch(() => null)) as {
      text?: unknown;
      screen?: unknown;
    } | null;

    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) {
      return context.json({ error: "laf:feedback_empty" }, 400);
    }
    if (text.length > FEEDBACK_MAX_LENGTH) {
      return context.json(
        { error: "laf:feedback_too_long", limit: FEEDBACK_MAX_LENGTH },
        400,
      );
    }

    const screen =
      body?.screen && typeof body.screen === "object"
        ? (body.screen as { route?: unknown; failureCode?: unknown })
        : null;
    const route = screen ? screenRoute(screen.route) : undefined;
    const failureCode = screen ? screenFailure(screen.failureCode) : undefined;

    const receipt = await service.feedback.record({
      userId: actor.id,
      text,
      ...(route ? { route } : {}),
      ...(failureCode ? { failureCode } : {}),
    });

    /*
     * The telling, after the row. `enqueue` never throws and answers null when nothing could be
     * written; either way the message is already kept, so the worst this can do is leave `told`
     * empty — which is the truth.
     */
    const notice = service.outbox
      ? await service.outbox.enqueue({
          kind: "support.feedback",
          // Nobody's Bot. The column is not null; nothing reads it for a support row.
          botId: "",
          userId: actor.id,
          support: {
            feedbackId: receipt.id,
            text,
            ...(route ? { route } : {}),
            ...(failureCode ? { failureCode } : {}),
          },
        })
      : null;
    const told = notice?.deliveredVia ?? [];

    // The trail says that a message was sent and how far it got. Not what it said: the words are
    // in their own table, and the trail outlives the account by a year.
    await recordAuditEvent(service.auditStore, {
      eventType: "support.feedback_sent",
      targetType: "feedback",
      targetId: receipt.id,
      actorUserId: actor.id,
      payload: {
        length: text.length,
        withScreen: screen !== null,
        told,
      },
    }).catch(() => undefined);

    return context.json(
      { id: receipt.id, receivedAt: receipt.createdAt.toISOString(), told },
      201,
    );
  });

  return routes;
}
