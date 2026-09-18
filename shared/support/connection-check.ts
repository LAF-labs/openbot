/**
 * 연결 점검: the closed words a connection check is written in, and the one reading of them.
 *
 * The check runs in the person's window (`app/src/lib/support/connection-check.ts`) because only
 * the window can say what its own network lets through — whether a live socket opens from here,
 * whether this device's clock agrees with the server's. So, unlike everything else the 문의·의견 box
 * can attach (`server/src/support/diagnostics.ts`), its result is assembled by the browser. That is
 * exactly the arrangement the diagnostics header warns about: what a browser assembles, a browser
 * can fill with anything.
 *
 * SO IT IS A VOCABULARY, NOT A FORMAT. Every value a result can hold is on a list below or is a
 * bounded integer: which check, how it came out, why — a code, never a sentence — how long it took,
 * the HTTP status or socket close code it ended on, and the CLASS of an error, never its message.
 * `readConnectionCheck` rebuilds a result from those and nothing else, and refuses the whole of it
 * when one field is off the list, so a message, a URL, a password or a Korean sentence has nowhere
 * to ride: no field of this shape can hold one. The server reads the result through it before
 * anything is kept, and the window writes its copy text from the same fields.
 *
 * IT LIVES IN `shared/` BECAUSE BOTH SIDES NEED THE SAME LISTS. A reason the window learns to say and
 * the server has never heard of would be refused on the way in; one list cannot disagree with itself.
 */

/** Every check, in the order it runs and is drawn. */
export const CONNECTION_CHECKS = [
  "server",
  "database",
  "botService",
  "computer",
  "session",
  "secure",
  "conversationSocket",
  "liveScreenSocket",
  "clock",
] as const;

export type ConnectionCheckId = (typeof CONNECTION_CHECKS)[number];

export const CHECK_STATES = ["pass", "fail", "skip"] as const;

export type CheckState = (typeof CHECK_STATES)[number];

/**
 * Why a check came out the way it did.
 *
 * Grouped by the state they go with, but one list: the reading below holds a result to the list and
 * not to the pairing, because a pairing it got wrong would cost a fact and buy no safety.
 */
export const CHECK_REASONS = [
  // Passed.
  "answered",
  "ok",
  "signed_in",
  "https",
  "local",
  "in_sync",
  // Failed.
  "offline",
  "no_answer",
  "timed_out",
  "gateway",
  "server_error",
  "not_ours",
  "unexpected",
  "down",
  "signed_out",
  "revoked",
  "forbidden",
  "insecure",
  "not_opened",
  "silent",
  "closed_early",
  "session_ended",
  "unsupported",
  "skewed",
  // Skipped.
  "no_server",
  "no_session",
  "no_bot",
  "bots_unreadable",
  "not_configured",
  "not_reported",
  "no_date",
] as const;

export type CheckReason = (typeof CHECK_REASONS)[number];

/**
 * The class of an error, from the names the platform gives the ones a fetch or a socket can throw.
 *
 * The name and never the message: a fetch's message can carry the address it failed on, and a
 * message is text somebody else wrote. Anything not named here is `Other`.
 */
export const ERROR_CLASSES = [
  "TypeError",
  "AbortError",
  "TimeoutError",
  "SyntaxError",
  "SecurityError",
  "NetworkError",
  "InvalidStateError",
  "Error",
  "Other",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Where the check ran: the installed app's window, or a browser tab. */
export const CHECK_SURFACES = ["shell", "browser"] as const;

export type CheckSurface = (typeof CHECK_SURFACES)[number];

export type ConnectionCheckResult = {
  id: ConnectionCheckId;
  state: CheckState;
  reason: CheckReason;
  /** How long it took, where that means something: a request's answer, a socket's first message. */
  ms?: number;
  /** The HTTP status the check ended on. */
  http?: number;
  /** The WebSocket close code the check ended on. */
  close?: number;
  error?: ErrorClass;
  /** The clock only: this device's time minus the server's, in milliseconds. */
  skewMs?: number;
};

export type ConnectionCheckFacts = {
  /** When the check finished, ISO-8601. */
  at: string;
  surface: CheckSurface;
  checks: ConnectionCheckResult[];
};

/**
 * The query parameter that makes a socket door answer as a probe: every gate the real socket has,
 * then one frame and a close, and nothing registered, recorded or opened inward
 * (`server/src/channels/events-routes.ts`, `server/src/live-screen.ts`).
 */
export const CONNECTION_PROBE_PARAM = "probe";

/** The class of whatever was thrown, as one of {@link ERROR_CLASSES}. */
export function errorClassOf(error: unknown): ErrorClass {
  const name =
    error && typeof error === "object" && "name" in error
      ? (error as { name: unknown }).name
      : undefined;
  return typeof name === "string" &&
    (ERROR_CLASSES as readonly string[]).includes(name)
    ? (name as ErrorClass)
    : "Other";
}

/**
 * The longest a timing may be: past the longest bound the check waits, with room. The window clamps
 * to it rather than sending more — a laptop closed mid-check wakes to a duration of hours, and a
 * result the reading refuses is a result nobody gets to see.
 */
export const CHECK_MS_MAX = 600_000;
/** A clock can be off by a lot on a device nobody set; a year either way is still a fact. Clamped too. */
export const CHECK_SKEW_MAX_MS = 366 * 24 * 60 * 60 * 1000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const isOneOf = <T extends string>(
  list: readonly T[],
  value: unknown,
): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

const isWhole = (value: unknown, least: number, most: number) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= least &&
  value <= most;

/** One result, rebuilt from its own fields, or null when any of them is off the list. */
function readResult(value: unknown): ConnectionCheckResult | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    !isOneOf(CONNECTION_CHECKS, raw.id) ||
    !isOneOf(CHECK_STATES, raw.state) ||
    !isOneOf(CHECK_REASONS, raw.reason)
  ) {
    return null;
  }
  const result: ConnectionCheckResult = {
    id: raw.id,
    state: raw.state,
    reason: raw.reason,
  };
  if (raw.ms !== undefined) {
    if (!isWhole(raw.ms, 0, CHECK_MS_MAX)) return null;
    result.ms = raw.ms as number;
  }
  if (raw.http !== undefined) {
    if (!isWhole(raw.http, 100, 599)) return null;
    result.http = raw.http as number;
  }
  if (raw.close !== undefined) {
    if (!isWhole(raw.close, 1000, 4999)) return null;
    result.close = raw.close as number;
  }
  if (raw.error !== undefined) {
    if (!isOneOf(ERROR_CLASSES, raw.error)) return null;
    result.error = raw.error;
  }
  if (raw.skewMs !== undefined) {
    if (!isWhole(raw.skewMs, -CHECK_SKEW_MAX_MS, CHECK_SKEW_MAX_MS))
      return null;
    result.skewMs = raw.skewMs as number;
  }
  return result;
}

/**
 * A check's result as this vocabulary allows it, or null.
 *
 * Rebuilt rather than passed through: a key this file does not name is not copied, whatever it
 * holds. And refused whole rather than trimmed: a result with one field off the list was not written
 * by this product's window, and a part of it is not a fact anybody should be shown as the person's.
 */
export function readConnectionCheck(
  value: unknown,
): ConnectionCheckFacts | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.at !== "string" || !ISO_INSTANT.test(raw.at)) return null;
  const at = new Date(raw.at);
  if (Number.isNaN(at.getTime())) return null;
  if (!isOneOf(CHECK_SURFACES, raw.surface)) return null;
  if (
    !Array.isArray(raw.checks) ||
    raw.checks.length === 0 ||
    raw.checks.length > CONNECTION_CHECKS.length
  ) {
    return null;
  }
  const checks: ConnectionCheckResult[] = [];
  const seen = new Set<ConnectionCheckId>();
  for (const entry of raw.checks) {
    const result = readResult(entry);
    if (!result || seen.has(result.id)) return null;
    seen.add(result.id);
    checks.push(result);
  }
  return { at: at.toISOString(), surface: raw.surface, checks };
}
