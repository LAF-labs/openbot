/**
 * The one shape a log line has, in every service an operator reads over `docker compose logs`.
 *
 * One JSON object per line: `level`, `at`, `svc`, `event`, then the facts. `event` is a snake_case
 * word for what happened — `boot`, `run_failed`, `runs_reconciled` — so a line can be grepped by
 * name and never by the wording of a sentence. There is no free-text message field on purpose:
 * a sentence is what a person paraphrases, and a paraphrase is what drifts.
 *
 * WHAT USED TO BE THERE, measured on 2026-09-06 across the three services. Seven different shapes:
 * bare sentences (`agent-bot listening on http://…`), `[tag] sentence` prefixes, hand-rolled
 * `JSON.stringify({type: …})` objects with no level and no time, and — the ones this file exists
 * for — `console.error("… failed:", error)` with the whole error object, which Bun prints as the
 * message, every own property and the stack. For the OpenAI client that is the provider's body,
 * the response headers and the request; for Drizzle it is the SQL and every bound parameter.
 *
 * THE FIELDS ARE SCRUBBED, NOT TRUSTED. A caller that hands an `Error` gets `describeFailure` of
 * it (a fact word for a provider or a query, one bounded line for anything else) and never a
 * stack. A string that looks like a key, a bearer token, a JWT or a URL with a password in it is
 * cut where the secret starts. A field whose NAME says it is a secret — `token`, `cookie`,
 * `authorization`, `apiKey` — is replaced whole when its value is a string. None of that is the
 * rule; the rule is that a log line carries facts about what happened and never the material it
 * happened to. The scrubbing is what catches the day somebody forgets, and the canary test
 * (`server/tests/log-hygiene.integration.test.ts`) is what proves the two together.
 *
 * Written over `console` rather than `process.stdout.write`, so a test's `spyOn(console, …)`
 * still sees every line, and so stdout and stderr keep the split `docker compose logs` shows:
 * `info` on stdout, `warn` and `error` on stderr.
 */
import { describeFailure } from "./failure-text";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export type Logger = {
  readonly svc: string;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
};

/** Where a finished line goes. Injected by tests; production uses `console`. */
export type LogSink = (level: LogLevel, line: string) => void;

export const REDACTED = "[redacted]";

/** Keys these four words belong to, in this order, before any field. */
const RESERVED = new Set(["level", "at", "svc", "event"]);

/** How deep a nested field is walked before it is summarised. Facts are flat; a tree is a dump. */
const MAX_DEPTH = 3;
/** How many entries of an array survive. A list of fifty Bots is a fact; a transcript is not. */
const MAX_ITEMS = 50;
/** How long one string may be. A page's text or a prompt never belongs here; this is the backstop. */
const MAX_STRING = 2_000;

/**
 * A field whose name says its value is a secret.
 *
 * Whole-word on purpose: `promptTokens` and `totalTokens` are counts and must survive, `token` and
 * `x-api-key` must not. Only a STRING value is replaced — a number under a name like this is a
 * count, and a boolean is a flag.
 */
const SECRET_KEY =
  /(^|[^a-z])(token|secret|password|passwd|cookie|authorization|api[_-]?key|credential|bearer)([^a-z]|$)/i;

/** Patterns a secret takes when it turns up inside an ordinary string. Cut where the secret starts. */
const SECRET_SHAPES: ReadonlyArray<[RegExp, string]> = [
  // Every `sk-…` key OpenAI-compatible endpoints issue, including OpenRouter's `sk-or-…`.
  [/\bsk-[A-Za-z0-9_-]{6,}/g, `sk-${REDACTED}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  // A JWT: three base64url parts. A session cookie and an OIDC id_token both look like this.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  // `scheme://user:password@host` — a connection string or a proxy URL with its credentials in it.
  [/\b([a-z][a-z0-9+.-]*):\/\/[^:/\s@]+:[^@/\s]+@/gi, `$1://${REDACTED}@`],
  // `name=value` cookies and query strings that name a token.
  [
    /\b([a-z0-9_.-]*(?:token|session|secret)[a-z0-9_.-]*)=[^;&\s]+/gi,
    `$1=${REDACTED}`,
  ],
];

export function scrubString(value: string): string {
  let out = value;
  for (const [shape, replacement] of SECRET_SHAPES) {
    out = out.replace(shape, replacement);
  }
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}…`;
  return out;
}

function scrubValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (value instanceof Error) return describeFailure(value);
  switch (typeof value) {
    case "string":
      return scrubString(value);
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[nested]";
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, MAX_ITEMS)
      .map((item) => scrubValue(item, depth + 1));
    return value.length > MAX_ITEMS
      ? [...kept, `…${value.length - MAX_ITEMS} more`]
      : kept;
  }
  if (typeof value === "object") {
    return scrubFields(value as Record<string, unknown>, depth + 1);
  }
  return String(value);
}

function scrubFields(
  fields: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(fields)) {
    if (depth === 0 && RESERVED.has(key)) continue;
    const value =
      typeof raw === "string" && SECRET_KEY.test(key)
        ? REDACTED
        : scrubValue(raw, depth);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** `Bot answered empty` is a sentence; `bot_answered_empty` is a name. Only names go on the wire. */
export function eventName(event: string): string {
  const name = event
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return name || "event";
}

/** One line, as a string, with nothing on it that was not decided here. Pure, for the tests. */
export function logLine(
  level: LogLevel,
  svc: string,
  event: string,
  fields: LogFields = {},
  at: Date = new Date(),
): string {
  return JSON.stringify({
    level,
    at: at.toISOString(),
    svc,
    event: eventName(event),
    ...scrubFields(fields, 0),
  });
}

export const consoleSink: LogSink = (level, line) => {
  if (level === "info") console.log(line);
  else if (level === "warn") console.warn(line);
  else console.error(line);
};

export function createLogger(svc: string, sink: LogSink = consoleSink): Logger {
  const emit = (level: LogLevel) => (event: string, fields?: LogFields) => {
    let line: string;
    try {
      line = logLine(level, svc, event, fields);
    } catch {
      // A field that cannot be serialised (a cycle, a proxy that throws) must not take the line
      // with it: the event still goes out, and says that its facts did not.
      line = logLine(level, svc, event, { fieldsDropped: true });
    }
    sink(level, line);
  };
  return { svc, info: emit("info"), warn: emit("warn"), error: emit("error") };
}

/**
 * A crash as one line, then the exit Bun would have made anyway.
 *
 * Bun's own report of an uncaught exception is the error object printed whole — message, own
 * properties, stack, and for a Drizzle failure at boot that is the statement and its parameters
 * (measured: a server started against an unmigrated database printed `update "laf_thread_runs"
 * set …` with its values). The line says what kind of failure it was and the first frame it was
 * thrown from, which is where an operator starts, and never the values.
 */
export function reportCrashes(log: Logger): void {
  process.on("uncaughtException", (error) => {
    const frame = (error instanceof Error ? error.stack : undefined)
      ?.split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("at "));
    log.error("crashed", {
      reason: error,
      name: error instanceof Error ? error.name : typeof error,
      ...(frame ? { where: frame } : {}),
    });
    process.exit(1);
  });
}

/**
 * Which build this is, for the `boot` line.
 *
 * `IMAGE_TAG` is the compose channel the image was pulled by (stable, edge, vX.Y.Z), passed into
 * every service's environment by docker-compose.yml; `GIT_SHA` is there for anybody who bakes one
 * in. Neither set is a source checkout, and says so rather than guessing.
 */
export function buildOf(
  environment: Record<string, string | undefined> = process.env,
): { version: string; revision?: string } {
  const version = environment.IMAGE_TAG?.trim() || "source";
  const revision = environment.GIT_SHA?.trim();
  return revision ? { version, revision } : { version };
}
