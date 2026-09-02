/**
 * The in-app door, and the one number §5.7 asks for.
 *
 * TWO SURFACES, ONE FILE, because they are the two halves of the same question. The door is what a
 * person's own page reads to find out what is waiting for them; the metric is what an operator
 * reads to find out whether that ever works. Splitting them would put the endpoint that proves the
 * feature somewhere other than the feature.
 *
 * THE DOOR IS THE SOURCE OF TRUTH AND THE SOCKET IS NOT. A frame can be missed — the tab was
 * closed, the socket was reconnecting, the person was asleep — so the page reads this on load and
 * on every reconnect, exactly the way the roster recovers (see `channels/events.ts`). Nothing may
 * be knowable only through the socket.
 *
 * FACT CODES, NOT SENTENCES. `laf:notification_not_found` rather than a line of English: the
 * surface owns the words, here as everywhere else.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import type { ApprovalMetrics } from "./approval-metrics";
import { metricDays } from "./approval-metrics";
import type { NotificationOutbox } from "./outbox";

export function createNotificationRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  outbox: NotificationOutbox,
  /**
   * The approvals KPI. Absent answers 503 rather than zeroes.
   *
   * A metric that reports nothing when it cannot be computed is indistinguishable from a deployment
   * where nobody has ever been asked anything, and those two want opposite reactions.
   */
  approvalMetrics?: (days: number) => Promise<ApprovalMetrics>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * What is waiting for the person asking. Theirs alone: the id comes from the session, never the URL.
   *
   * `since` is the client's bookmark — the newest row it has already seen — so a page that has been
   * open all day asks for what arrived since its last frame instead of re-reading the same list.
   */
  routes.get("/me/notifications", requireUser, async (context) => {
    const since = context.req.query("since");
    return context.json({
      notifications: await outbox.list(context.var.actor.id, {
        ...(since ? { since } : {}),
      }),
    });
  });

  /**
   * They looked at it.
   *
   * A 404 for a row that is somebody else's, and the same 404 for one that was already seen: from
   * where the caller stands those are one fact, which is that there is nothing here to mark. It is
   * also the only answer that does not tell an unauthorised caller whether an id exists.
   */
  routes.post("/me/notifications/:id/seen", requireUser, async (context) => {
    const marked = await outbox.markSeen(
      context.var.actor.id,
      context.req.param("id") ?? "",
    );
    if (!marked) {
      return context.json({ error: "laf:notification_not_found" }, 404);
    }
    return context.body(null, 204);
  });

  /**
   * How long people take to answer, and how long at night. The operator's, like the trail.
   *
   * A read of the audit trail rather than of the outbox — see `approval-metrics.ts` for why that
   * distinction is the whole point.
   */
  routes.get("/admin/metrics/approvals", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!approvalMetrics) {
      return context.json({ error: "laf:metrics_unavailable" }, 503);
    }
    return context.json(
      await approvalMetrics(metricDays(context.req.query("days"))),
    );
  });

  return routes;
}
