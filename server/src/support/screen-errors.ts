/**
 * `POST /api/support/screen-errors`: a part of the app's screen failed, and the app says so.
 *
 * WHY THIS EXISTS. The server's log and the 문의·의견 box's diagnostic details (`diagnostics.ts`)
 * only knew what the server had seen. A section of the screen that threw while drawing — the
 * roster, a transcript, a Bot's screen — was a failure nobody but the person in front of it ever
 * learned about, and the person could only say "안 돼요". The app now reports it here, and this
 * writes one line for it, which the diagnostic details carry to the operator if the person sends
 * them (`diagnostics.ts`, `eventFromLine`).
 *
 * WHAT A REPORT MAY SAY is `shared/screen-errors.ts`: closed facts, and never the error's message,
 * which quotes whatever the failing code was handed. A report with any field that does not fit is
 * refused whole and nothing is written — a client that grew a `message` field is turned away here,
 * not trusted to have scrubbed it.
 *
 * THREE LIMITS, IN THE ORDER A REQUEST MEETS THEM, AFTER THE SESSION GUARD:
 *
 *   - A RATE PER SESSION, six a minute. The app sends each fingerprint at most once per page load,
 *     so an honest page sends a handful in its life; six is a burst of different failures at once.
 *     What it protects is the log tail itself: the diagnostic details read the last 2,000 lines this
 *     process wrote (`log.ts`), and a page stuck in a loop reporting would push the person's real
 *     events out of it. Refused requests count too, the rule `middleware/security.ts` keeps.
 *   - A BODY of two kilobytes, refused on its declared length before it is read. A report is under
 *     four hundred bytes; the megabyte every other route may take is not this route's to offer.
 *   - THE SHAPE, fact by fact.
 *
 * The session is the one `middleware/security.ts` limits the message door by: better-auth's cookie,
 * hashed. A deployment running without sign-in (`LAF_DEV_NO_AUTH`, development only) has no cookie,
 * and is limited by the one person it stands in.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "../../../shared/log";
import {
  readScreenErrorReport,
  SCREEN_ERROR_MAX_BYTES,
} from "../../../shared/screen-errors";
import type { AppVariables } from "../auth/guards";
import { log as serverLog } from "../log";
import {
  BODY_TOO_LARGE,
  createLimiter,
  RATE_LIMITED,
  sessionKey,
} from "../middleware/security";

/** The line's event name, and what the diagnostic details look for. */
export const SCREEN_FAILED = "screen_failed";

/** A report that is not the shape `shared/screen-errors.ts` describes. */
export const SCREEN_ERROR_MALFORMED = "laf:screen_error_malformed";

/** Reports one session may send in a minute. See the module note for why six. */
export const SCREEN_ERRORS_PER_SESSION = 6;

export function createScreenErrorRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  options: {
    /** The server's logger unless a test hands one over; the diagnostic details read its tail. */
    log?: Logger;
    /** The clock the rate's window is kept on. */
    now?: () => number;
  } = {},
) {
  const log = options.log ?? serverLog;
  const limiter = createLimiter(options.now ?? Date.now);
  const routes = new Hono<{ Variables: AppVariables }>();

  const perSession: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    const session = sessionKey(context) ?? `actor:${context.var.actor.id}`;
    const verdict = limiter.take(
      `screen-error:${session}`,
      SCREEN_ERRORS_PER_SESSION,
    );
    if (verdict.allowed) return next();
    context.header(
      "Retry-After",
      String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))),
    );
    return context.json(RATE_LIMITED, 429);
  };

  routes.post(
    "/",
    requireUser,
    perSession,
    bodyLimit({
      maxSize: SCREEN_ERROR_MAX_BYTES,
      onError: (context) => context.json(BODY_TOO_LARGE, 413),
    }),
    async (context) => {
      // Not JSON is the same refusal as JSON of the wrong shape: neither is a report.
      const body: unknown = await context.req.json().catch(() => undefined);
      const report = readScreenErrorReport(body);
      if (!report) {
        return context.json(
          { error: SCREEN_ERROR_MALFORMED, code: SCREEN_ERROR_MALFORMED },
          400,
        );
      }
      /*
       * A warning, not an error: the server did not fail, a screen said it did. The person is
       * named because the line belongs to nothing else — no Bot, run or room vouches for a screen —
       * and that name is what lets the diagnostic details hand it to them and to nobody else.
       */
      log.warn(SCREEN_FAILED, { user: context.var.actor.id, ...report });
      return context.body(null, 204);
    },
  );

  return routes;
}
