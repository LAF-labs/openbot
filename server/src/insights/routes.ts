/**
 * `GET /api/admin/metrics/insights?days=N`: the fleet's read of this VM's counts.
 *
 * NOT A PERSON'S DOOR. `/api/admin/metrics/approvals` sits behind an administrator's session; the
 * fleet has no session on any customer's VM and must not be given one, because a session here is
 * a login to somebody's Bots. So this door takes one thing — the fleet's bearer token
 * (`LAF_FLEET_METRICS_TOKEN`) — and opens onto counts and catalogue codes and nothing else
 * (`read.ts`). A person's cookie does not open it, an administrator's included.
 *
 * NOT MOUNTED WITHOUT A TOKEN (`app.ts`), so a VM that was never given one answers this path with
 * the same 404 as a path that does not exist and advertises nothing. With one, a request without
 * the right bearer is 401 before anything else is looked at, the window included: the fleet
 * reading 401 knows its token is wrong, where a 404 would have sent it looking for an old image.
 *
 * THE COMPARISON TAKES THE SAME TIME HOWEVER MUCH OF THE TOKEN IS RIGHT. Both sides are hashed
 * first, so the compare is over two equal-length digests and neither the token's length nor its
 * matching prefix is something a stopwatch can learn.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  DEFAULT_INSIGHT_DAYS,
  type InsightsReport,
  MAX_INSIGHT_DAYS,
} from "./report";

/** No bearer, or not the fleet's. */
export const FLEET_TOKEN_REFUSED = "laf:fleet_token_refused";
/** `days` that is not a whole number of days the trail could hold. */
export const INSIGHT_DAYS_INVALID = "laf:insight_days_invalid";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Whether the header carries exactly this token as a bearer, compared in constant time. */
export function bearerMatches(
  header: string | undefined,
  token: string,
): boolean {
  const presented = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header ?? "")?.[1] ?? "";
  // Compared even when nothing was presented, so a missing header costs what a wrong one does.
  const same = timingSafeEqual(digest(presented), digest(token));
  return same && presented.length > 0;
}

/**
 * `?days=`: absent is laf-control's own default; present, a whole number from 1 to 365, or null.
 * Refused rather than clamped: a window the fleet did not ask for, echoed back, is a number it
 * would file under the wrong week.
 */
export function insightDays(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return DEFAULT_INSIGHT_DAYS;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const days = Number(raw);
  return days >= 1 && days <= MAX_INSIGHT_DAYS ? days : null;
}

export function createInsightsRoutes(options: {
  token: string;
  read: (days: number) => Promise<InsightsReport>;
}) {
  const routes = new Hono();

  routes.get("/insights", async (context) => {
    if (!bearerMatches(context.req.header("authorization"), options.token)) {
      context.header("WWW-Authenticate", "Bearer");
      return context.json(
        { error: FLEET_TOKEN_REFUSED, code: FLEET_TOKEN_REFUSED },
        401,
      );
    }
    const days = insightDays(context.req.query("days"));
    if (days === null) {
      return context.json(
        {
          error: INSIGHT_DAYS_INVALID,
          code: INSIGHT_DAYS_INVALID,
          min: 1,
          max: MAX_INSIGHT_DAYS,
        },
        400,
      );
    }
    // Counts about somebody's business: nothing between here and the fleet keeps a copy.
    context.header("Cache-Control", "no-store");
    return context.json(await options.read(days));
  });

  return routes;
}
