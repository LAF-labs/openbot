/**
 * What every answer from this process carries, and what a request has to fit inside.
 *
 * THREE THINGS THE SECURITY AUDIT MEASURED AS ABSENT (A8, 2026-09-10): no security header on any
 * answer — `secureHeaders` and `c.header` both zero, so an approval button could be framed by any
 * page and pressed through the frame; no ceiling on any body — an anonymous `POST …/trigger` with a
 * 20 MB body was read whole before the token was looked at; and no rate on any door — 300 concurrent
 * requests on one cookie all answered. One middleware for the three, mounted first in `app.ts`,
 * because each is a property of the process rather than of a route.
 *
 * HEADERS. The front door (`app/Caddyfile`) sets the SPA's, since it serves the SPA; this sets them
 * on everything this process answers, and the two do not overlap — the Caddyfile leaves what it
 * proxies alone. A JSON answer gets a policy that allows nothing, since nothing renders it. An HTML
 * page this process draws (`/connected`, better-auth's error page) gets one computed from the page:
 * its inline scripts by hash, and nothing else may run. Deliberately not
 * `Cross-Origin-Resource-Policy` and not `Cross-Origin-Opener-Policy`: the installed shell's
 * unreachable page probes the deployment with a `no-cors` fetch that CORP would turn into a
 * permanent "server down", and the consent window the app opens is one COOP would cut off from the
 * page that opened it.
 *
 * BODY. A megabyte, before any route runs. Bigger only where an honest body is bigger — a Bot's file
 * written into its workspace, and a conversation turn, which carries the thread (see
 * `LARGER_BODIES`) — and only for a body that DECLARES its length: Hono's `bodyLimit` refuses on
 * `Content-Length` without reading a byte, but has to read a chunked body to count it, and a
 * chunked body arrives before the session is checked. So a chunked body is held to the megabyte
 * everywhere, and the larger ceilings are free to be large.
 *
 * RATE. In memory, by decision: one API process per VM (docs/laf/deployment-model.md), so a map in
 * this process is the whole picture. Three doors, the three whose cost lands on somebody's model
 * bill or somebody's provider: starting a sign-in (per address), sending a message (per session and
 * per address), and the anonymous routine trigger (per trigger token and per address). A fixed
 * window of a minute — coarse, and enough: what this stops is a burst, which is what a script or a
 * mistake makes. `Retry-After` says when.
 *
 * THE ADDRESS is the last entry of `X-Forwarded-For` — the one the front door wrote, which is all
 * Caddy sends when it trusts no proxy before it — and the socket's own when there is no such header
 * (a laptop). Never the first entry: that is whatever the client typed, and a limit keyed on a
 * header the client controls is not a limit.
 */
import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "hono/bun";
import { every } from "hono/combine";

export const BODY_LIMIT_BYTES = 1_000_000;

/**
 * The routes an honest body outgrows the megabyte on, and what they are allowed instead.
 *
 * - A Bot's file write. The workspace refuses more than a megabyte of contents on its own
 *   (agent-computer/src/workspace.ts), and that megabyte arrives here JSON-escaped, where a newline
 *   or a quote is two bytes — two and a half, so the computer's refusal stays the one that names the
 *   real limit.
 * - A conversation turn. CopilotKit posts the whole transcript it holds with every run, tool results
 *   and all, and a person's thread with a Bot is one thread for good (A5 §2) — so the body of a turn
 *   grows with the conversation, and a megabyte here would one day refuse somebody's every message
 *   to a Bot they had talked to for months. Behind the session guard, and only for a declared
 *   length, so an anonymous caller is refused before a byte of it is read.
 */
export const LARGER_BODIES: ReadonlyArray<{
  name: string;
  matches: (path: string) => boolean;
  maxBytes: number;
}> = [
  {
    name: "workspace-write",
    matches: (path) => /^\/api\/computers\/[^/]+\/files\/write$/.test(path),
    maxBytes: 2_500_000,
  },
  {
    name: "conversation-turn",
    matches: (path) => path.startsWith("/api/copilotkit/"),
    maxBytes: 32_000_000,
  },
];

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMITS = {
  signIn: { perIp: 20 },
  // A Bot working through a task sends one run per step, and a step is a model call and an action:
  // sixty a minute is a Bot no model can outpace, and a script that can.
  message: { perSession: 60, perIp: 240 },
  trigger: { perToken: 30, perIp: 60 },
} as const;

type Door = keyof typeof RATE_LIMITS;

export const RATE_LIMITED = {
  error: "laf:rate_limited",
  code: "laf:rate_limited",
};
export const BODY_TOO_LARGE = {
  error: "laf:body_too_large",
  code: "laf:body_too_large",
};

/**
 * Which door a request is knocking on, if any. POST only; every one of them is a POST.
 *
 * The conversation turn is matched the way CopilotKit's own router matches it — the last three
 * non-empty segments `agent/<id>/run` under the runtime's base path (`fetch-router.mjs`,
 * @copilotkit/runtime 1.67.1) — because a pattern stricter than the router it guards is a door with
 * a second entrance: `/api/copilotkit//x/agent/bot/run` reaches the same run.
 */
export function doorFor(method: string, pathname: string): Door | undefined {
  if (method !== "POST") return undefined;
  const path = pathname.replace(/\/{2,}/g, "/");
  if (path.startsWith("/api/auth/sign-in/")) return "signIn";
  if (path.startsWith("/api/copilotkit/")) {
    const segments = path.split("/").filter(Boolean);
    const verb = segments.at(-1);
    if (
      segments.length >= 3 &&
      segments.at(-3) === "agent" &&
      (verb === "run" || verb === "suggest")
    ) {
      return "message";
    }
    return undefined;
  }
  if (/^\/api\/channels\/[^/]+\/room-turn\/?$/.test(path)) return "message";
  if (/^\/api\/routines\/[^/]+\/trigger\/?$/.test(path)) return "trigger";
  return undefined;
}

export type SecurityOptions = {
  /** The clock, so a test can watch a window close. */
  now?: () => number;
};

/** How many keys the limiter holds before it sweeps the expired ones. A number, not a policy. */
const SWEEP_AT = 10_000;

type Window = { count: number; resetAt: number };

/**
 * A fixed window of a minute per key. Exported for the one door that is limited per session after
 * its guard rather than before it (`support/screen-errors.ts`), so there is one limiter, not two.
 */
export function createLimiter(now: () => number) {
  const windows = new Map<string, Window>();
  return {
    /** Spend one, or say how long until the next one is free. */
    take(
      key: string,
      limit: number,
    ): { allowed: boolean; retryAfterMs: number } {
      const at = now();
      if (windows.size > SWEEP_AT) {
        for (const [name, window] of windows) {
          if (window.resetAt <= at) windows.delete(name);
        }
      }
      const current = windows.get(key);
      if (!current || current.resetAt <= at) {
        windows.set(key, { count: 1, resetAt: at + RATE_LIMIT_WINDOW_MS });
        return { allowed: true, retryAfterMs: 0 };
      }
      if (current.count >= limit) {
        return { allowed: false, retryAfterMs: current.resetAt - at };
      }
      current.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

function clientAddress(context: Context): string {
  const last = context.req.header("x-forwarded-for")?.split(",").pop()?.trim();
  if (last) return last;
  try {
    return getConnInfo(context).remote.address ?? "unknown";
  } catch {
    // `app.request()` in a test, or any embedding with no socket behind the request.
    return "unknown";
  }
}

/** A secret as a name for a minute in a map: hashed, never kept. */
const nameOf = (secret: string) =>
  createHash("sha256").update(secret).digest("hex").slice(0, 32);

/**
 * The session, by better-auth's session cookie — `better-auth.session_token`, or its
 * `__Secure-` spelling on https — and by nothing else in the header: the rest of the cookies are the
 * page's, and a key that changed with a theme cookie would be a limit a new theme resets.
 */
export function sessionKey(context: Context): string | undefined {
  for (const pair of (context.req.header("cookie") ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    if (pair.slice(0, at).trim().endsWith("better-auth.session_token")) {
      const value = pair.slice(at + 1).trim();
      if (value) return nameOf(value);
    }
  }
  return undefined;
}

function createRateLimit(now: () => number): MiddlewareHandler {
  const limiter = createLimiter(now);
  return async (context, next) => {
    const door = doorFor(context.req.method, context.req.path);
    if (!door) return next();
    const takes: Array<[key: string, limit: number]> = [
      [`${door}:ip:${clientAddress(context)}`, RATE_LIMITS[door].perIp],
    ];
    if (door === "message") {
      const session = sessionKey(context);
      if (session) {
        takes.push([
          `message:session:${session}`,
          RATE_LIMITS.message.perSession,
        ]);
      }
    }
    if (door === "trigger") {
      const token = context.req.header("x-trigger-token");
      if (token) {
        takes.push([
          `trigger:token:${nameOf(token)}`,
          RATE_LIMITS.trigger.perToken,
        ]);
      }
    }
    // Every count is spent, so a refused request still counts against each key it named.
    const refused = takes
      .map(([key, limit]) => limiter.take(key, limit))
      .filter((verdict) => !verdict.allowed);
    if (refused.length === 0) return next();
    const wait = Math.max(...refused.map((verdict) => verdict.retryAfterMs));
    context.header("Retry-After", String(Math.max(1, Math.ceil(wait / 1000))));
    return context.json(RATE_LIMITED, 429);
  };
}

const tooLarge = (context: Context) => context.json(BODY_TOO_LARGE, 413);

function createBodyLimit(): MiddlewareHandler {
  const standard = bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: tooLarge });
  const larger = LARGER_BODIES.map((route) => ({
    ...route,
    limit: bodyLimit({ maxSize: route.maxBytes, onError: tooLarge }),
  }));
  return (context, next) => {
    const declared =
      context.req.header("content-length") !== undefined &&
      context.req.header("transfer-encoding") === undefined;
    const route = declared
      ? larger.find((candidate) => candidate.matches(context.req.path))
      : undefined;
    return (route?.limit ?? standard)(context, next);
  };
}

/** A JSON answer: nothing renders it, so nothing is allowed. */
export const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** The inline scripts of an HTML page this process drew, as the hashes a policy names them by. */
export function inlineScriptHashes(html: string): string[] {
  return [
    ...html.matchAll(
      /<script(?![^>]*\bsrc=)(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi,
    ),
  ].map(
    (match) =>
      `'sha256-${createHash("sha256")
        .update(match[1] ?? "")
        .digest("base64")}'`,
  );
}

export function htmlCsp(html: string): string {
  const scripts = inlineScriptHashes(html);
  return [
    "default-src 'none'",
    `script-src ${scripts.length > 0 ? scripts.join(" ") : "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** The same five the front door sets on the SPA, bar the referrer, which an API can keep to itself. */
export const FIXED_HEADERS: ReadonlyArray<[string, string]> = [
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "no-referrer"],
  [
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  ],
];

const addHeaders: MiddlewareHandler = async (context, next) => {
  await next();
  const headers = context.res.headers;
  for (const [name, value] of FIXED_HEADERS) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (headers.has("Content-Security-Policy")) return;
  if ((headers.get("content-type") ?? "").startsWith("text/html")) {
    // Read off a clone: the body is read once, and it is the response's to give.
    headers.set(
      "Content-Security-Policy",
      htmlCsp(await context.res.clone().text()),
    );
    return;
  }
  headers.set("Content-Security-Policy", API_CSP);
};

/** The one middleware `app.ts` mounts, first: headers on the way out, the limits on the way in. */
export function createSecurityMiddleware(
  options: SecurityOptions = {},
): MiddlewareHandler {
  return every(
    addHeaders,
    createRateLimit(options.now ?? Date.now),
    createBodyLimit(),
  );
}
