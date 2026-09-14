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

/**
 * The names a `name=value` pair carries a secret under, as any part of the name: `access_token`,
 * `X-Amz-Signature`, `aws_secret_access_key`, `JSESSIONID`. Long enough that a word containing one
 * by accident is not a thing a log line says.
 */
const SECRET_NAME_PARTS =
  "token|session|sessid|secret|password|passwd|pwd|passcode|api[_-]?key|credential|signature|authorization|private[_-]?key|access[_-]?key";

/**
 * The names too short to look for inside other words — `key` is in `monkey`, `sid` in `consider` —
 * so only as the whole name of a query or cookie parameter, where `?key=` and `connect.sid=` are
 * exactly what they look like. `code` is the OAuth callback's one-time grant.
 */
const SHORT_SECRET_NAMES = "key|pw|pass|pin|otp|sig|sid|auth|code";

/** The headers a credential travels in, written into a string as `Name: value`. */
const CREDENTIAL_HEADERS =
  "authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|x-openbot-computer-token|x-trigger-token|x-laf-signature|cookie|set-cookie";

/**
 * Patterns a secret takes when it turns up inside an ordinary string. Cut where the secret starts.
 *
 * WHAT THE FIRST FIVE MISSED (A5 §6, 2026-09-10): twenty-six values handed to `scrubString`, and
 * twelve came back whole — `?password=`, `?pwd=`, `?api_key=` and `?key=`, the query strings Korean
 * admin pages actually use, because the one `name=value` shape knew only `token`, `session` and
 * `secret`; `PHPSESSID=` and `aws_secret_access_key =` for the same reason; a PEM private key,
 * `ghp_`, `xoxb-`, `KakaoAK` and 솔라피's `key:secret`, whose shapes nothing knew; and a password
 * in a Korean sentence. `operating.md` had promised a URL with a password in it was cut; only
 * `scheme://user:pass@host` was. Every one is a row in `tests/log.test.ts`.
 *
 * Order matters where one shape's output could feed another: the block and the prefixed keys first,
 * then the header lines, then the name-shaped pairs.
 *
 * What no shape here catches is a secret with nothing beside it to say so — `it's Hunter2` — and a
 * Korean sentence that names one only through a subject particle (`비밀번호가 …`), which is far more
 * often the site's error message than the password. Neither belongs in a log line in the first
 * place; keeping them out is the discipline's job (`tests/log-discipline.test.ts`), and this is the
 * net under it.
 */
const SECRET_SHAPES: ReadonlyArray<[RegExp, string]> = [
  // A PEM private key, whole — or to the end of the string, when the END line was cut off.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    REDACTED,
  ],
  // Every `sk-…` key OpenAI-compatible endpoints issue, including OpenRouter's `sk-or-…`.
  [/\bsk-[A-Za-z0-9_-]{6,}/g, `sk-${REDACTED}`],
  // Keys recognisable by their vendor's prefix: GitHub, Slack, AWS, Google.
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}/g, REDACTED],
  [/\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  // A credential header written into a string, whatever its scheme — Basic, KakaoAK, 솔라피's
  // HMAC-SHA256 — to the end of its line.
  [
    new RegExp(`\\b(${CREDENTIAL_HEADERS})\\s*:\\s*[^\\r\\n"']+`, "gi"),
    `$1: ${REDACTED}`,
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  [/\bKakaoAK\s+[A-Za-z0-9]{16,}/g, `KakaoAK ${REDACTED}`],
  // A JWT: three base64url parts. A session cookie and an OIDC id_token both look like this.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  // `scheme://user:password@host` — a connection string or a proxy URL with its credentials in it.
  [/\b([a-z][a-z0-9+.-]{0,30}):\/\/[^:/\s@]+:[^@/\s]+@/gi, `$1://${REDACTED}@`],
  // A quoted JSON member whose name says it is a secret, inside a body written as a string.
  [
    new RegExp(
      `"([a-z0-9_.-]{0,40}(?:${SECRET_NAME_PARTS})[a-z0-9_.-]{0,40})"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`,
      "gi",
    ),
    `"$1":"${REDACTED}"`,
  ],
  // `name=value` — a query string, a cookie, an environment line — whose NAME says it is a secret.
  // The name's length is bounded: unbounded on both sides of an alternation, a long run of letters
  // with no `=` in it is quadratic work for every string a line carries.
  [
    new RegExp(
      `\\b([a-z0-9_.-]{0,40}(?:${SECRET_NAME_PARTS})[a-z0-9_.-]{0,40})[ \\t]*=[ \\t]*[^;&\\s"']+`,
      "gi",
    ),
    `$1=${REDACTED}`,
  ],
  [
    new RegExp(`(^|[?&#;.])(${SHORT_SECRET_NAMES})=[^;&\\s"']+`, "gi"),
    `$1$2=${REDACTED}`,
  ],
  // A value stated after its name: `password: Hunter2`, `비밀번호는 Hunter2!입니다`, `인증번호=482913`.
  [/\b(password|passwd|passcode|otp)\s*:\s*[^\s"']+/gi, `$1: ${REDACTED}`],
  [
    /(비밀번호|비번|패스워드|암호|인증번호|보안코드)\s*(?:[:=]|은|는)\s*\S+/g,
    `$1 ${REDACTED}`,
  ],
];

export function scrubString(value: string): string {
  /*
   * CUT TWICE: loosely before, exactly after. The shapes run over the whole string, and a string
   * of a hundred thousand dots took the `user:pass@host` shape five seconds on its own (measured
   * 2026-09-13; twenty on the shapes before). Nothing past twice the ceiling can survive into the
   * line, and a secret that starts inside the ceiling and runs past twice it is a PEM block, which
   * its shape takes to the end of what is there.
   */
  let out =
    value.length > MAX_STRING * 2 ? value.slice(0, MAX_STRING * 2) : value;
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
  keepReserved = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(fields)) {
    if (depth === 0 && !keepReserved && RESERVED.has(key)) continue;
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

/**
 * A line read back: its fields, scrubbed AGAIN, or null for anything that is not a line of this shape.
 *
 * Again, because a line that leaves by a second door is judged by the rules in force the day it
 * leaves, not the day it was written — a shape added to `SECRET_SHAPES` since then covers what was
 * written before it. The four reserved keys are kept (they are the line), and nothing is added.
 */
export function readLogLine(line: string): LogFields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const fields = parsed as Record<string, unknown>;
  if (typeof fields.event !== "string" || typeof fields.at !== "string") {
    return null;
  }
  return scrubFields(fields, 0, true);
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

/** The last lines a logger wrote, for a reader inside the same process. See `rememberLines`. */
export type LineMemory = {
  /** Hand this to `createLogger`: it keeps the line, then passes it on unchanged. */
  sink: LogSink;
  /** What is kept, oldest first, as a copy. */
  lines: () => string[];
};

/**
 * THE TAIL OF THIS PROCESS'S LOG, IN MEMORY.
 *
 * A line goes to stdout, where `docker compose logs` reads it and this process cannot. The 문의·의견
 * box can attach a person's own recent events (`server/src/support/diagnostics.ts`), so the server's
 * logger keeps what it wrote here as well — the same finished, scrubbed bytes, and nothing a line did
 * not already say. Bounded twice, by lines and by characters, so a burst of long lines forgets the
 * oldest rather than growing; and a restart forgets all of it, which is what a tail does too.
 */
export function rememberLines(
  limits: { lines: number; chars: number },
  next: LogSink = consoleSink,
): LineMemory {
  const kept: string[] = [];
  let chars = 0;
  return {
    sink: (level, line) => {
      // The console first: an operator's log must not depend on anything this memory does.
      next(level, line);
      kept.push(line);
      chars += line.length;
      while (
        kept.length > limits.lines ||
        (chars > limits.chars && kept.length > 1)
      ) {
        chars -= (kept.shift() as string).length;
      }
    },
    lines: () => [...kept],
  };
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
 * Which build this is, for the `boot` line and for `GET /api/version`.
 *
 * Three facts, each from one place, and the one source of truth behind all of them is git:
 *
 *   - `version`  — what was BUILT. `BUILD_CHANNEL` is baked into the image by images.yml from the
 *                  ref it built: `vX.Y.Z` from a release tag, `edge` from main. It is what the
 *                  footer on Settings shows, because "stable" names a channel and not a build.
 *   - `channel`  — what was PULLED. `IMAGE_TAG` is the compose channel (stable, edge, vX.Y.Z),
 *                  passed into every service's environment by docker-compose.yml. Before anything
 *                  was baked this was the only version there was, so it is still the fallback for
 *                  `version` when an image carries no `BUILD_CHANNEL`.
 *   - `revision` — the commit, `GIT_SHA`, baked beside the channel.
 *
 * A source checkout has none of the three and says `source` rather than guessing.
 */
export type Build = { version: string; revision?: string; channel?: string };

export function buildOf(
  environment: Record<string, string | undefined> = process.env,
): Build {
  const channel = environment.IMAGE_TAG?.trim() || undefined;
  const version = environment.BUILD_CHANNEL?.trim() || channel || "source";
  const revision = environment.GIT_SHA?.trim() || undefined;
  return {
    version,
    ...(revision ? { revision } : {}),
    ...(channel ? { channel } : {}),
  };
}
