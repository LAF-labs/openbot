/**
 * 연결 점검: what a person runs when the app seems stuck, and the sentences that say what it found.
 *
 * WHY IT EXISTS. When something stopped working, all a person could tell whoever runs the product was
 * "안 돼요", and nobody could tell a dead server from a café Wi-Fi from a clock set by hand. The
 * window is the one place that can tell those apart — whether a request gets out, whether a live
 * socket opens from HERE, what this device's clock says — so the check runs in it, one step after
 * another, and says after each one what it saw.
 *
 * FACTS FIRST, WORDS AFTER. The runner turns what happened into a result made only of closed values
 * (`shared/support/connection-check.ts`): which check, pass, fail or skip, a reason code, a timing,
 * a status, an error's CLASS. The sentence a person reads is worked out from that result when it is
 * drawn (`adviceFor`), never stored in it — so what is copied, and what the 문의·의견 box may attach,
 * is the result and cannot hold a sentence, a message an error carried, or anything the person typed.
 *
 * EVERYTHING THAT TOUCHES THE WORLD IS HANDED IN (`CheckIO`): the requests, the sockets, the clocks.
 * What each answer MEANS is plain functions of what came back, so every mapping is tested with fakes
 * and no DOM (`tests/connection-check.test.ts`).
 *
 * NOTHING HERE MAY BE A BROWSER-ONLY API WITHOUT A FALLBACK. The check runs in the installed app's
 * window first — a webview on the same origin, whose engine is whatever the person's system ships —
 * so a bound is a timer and an `AbortController` rather than `AbortSignal.timeout`, and a duration
 * falls back to `Date.now` where there is no `performance`.
 *
 * THE SOCKETS ARE THE CHECK'S OWN. Both doors answer `?probe` with one frame and a close, after every
 * gate the real socket has and before anything the real one does: the account's feed never counts a
 * probe as a listener, and the live screen never opens the Bot's browser for one — a second viewer
 * there replaces the first, which would freeze the picture in any window already watching.
 */
import {
  CHECK_MS_MAX,
  CHECK_SKEW_MAX_MS,
  type CheckReason,
  type CheckSurface,
  CONNECTION_CHECKS,
  CONNECTION_PROBE_PARAM,
  type ConnectionCheckFacts,
  type ConnectionCheckId,
  type ConnectionCheckResult,
  type ErrorClass,
  errorClassOf,
  readConnectionCheck,
} from "@shared/support/connection-check";
import { t } from "@/lib/i18n";
import { inShell } from "@/lib/notifications/shell";

export type {
  ConnectionCheckFacts,
  ConnectionCheckId,
  ConnectionCheckResult,
} from "@shared/support/connection-check";
export { CONNECTION_CHECKS } from "@shared/support/connection-check";

// --- what the world answered, as facts -----------------------------------------------------------

/** How one request ended. `body` is the parsed JSON, or undefined when it was not JSON. */
export type HttpAnswer =
  | {
      kind: "answered";
      ms: number;
      status: number;
      body: unknown;
      /** The `Date` header, as sent. */
      date: string | null;
    }
  | { kind: "threw"; ms: number; error: ErrorClass; offline: boolean }
  | { kind: "timed_out"; ms: number };

/** How one probe socket ended. */
export type SocketAnswer =
  /** The first message arrived. */
  | { kind: "answered"; ms: number }
  /** `new WebSocket` itself threw. */
  | { kind: "unsupported"; error: ErrorClass }
  /** Closed before it ever opened: the handshake did not get through. */
  | { kind: "not_opened"; ms: number; close: number | null }
  /** A bound ran out — before the socket opened, or after, waiting for the first message. */
  | { kind: "timed_out"; ms: number; opened: boolean }
  /** Opened, and closed before anything arrived. */
  | { kind: "closed_early"; ms: number; close: number | null };

/** The report `/api/health` answers with (`server/src/health.ts`). */
type HealthReport = {
  status: "ok" | "degraded";
  checks: Record<string, unknown>;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/*
 * WHAT THE RUN RECORDS STAYS INSIDE WHAT THE VOCABULARY READS. The reading refuses a whole result for
 * one field out of range (`readConnectionCheck`), so a value the world can hand back past a bound — a
 * duration across a laptop's sleep, a clock set years wrong, a close code an engine left at 0 — is
 * clamped or dropped here, where the fact is recorded, rather than costing the person the result.
 */
const clamp = (value: number, least: number, most: number) =>
  Math.min(most, Math.max(least, value));

/** A status as the vocabulary holds one, or nothing. */
const statusOf = (status: number) =>
  Number.isInteger(status) && status >= 100 && status <= 599
    ? { http: status }
    : {};

function healthReportOf(body: unknown): HealthReport | null {
  const report = asRecord(body);
  const checks = asRecord(report?.checks);
  if (!report || !checks) return null;
  return report.status === "ok" || report.status === "degraded"
    ? { status: report.status, checks }
    : null;
}

/**
 * The front door's own answer for an API that is not behind it (`app/Caddyfile`, `handle_errors`):
 * `{"status":"down","checks":{"api":"unreachable"}}` on the health path, `laf:api_unreachable` on
 * every other.
 */
function isFrontDoorWithoutApi(body: unknown): boolean {
  const answer = asRecord(body);
  if (!answer) return false;
  if (answer.code === "laf:api_unreachable") return true;
  return (
    answer.status === "down" && asRecord(answer.checks)?.api === "unreachable"
  );
}

/** A `laf:` code in the body: this product's API answered, whatever the status says. */
const isOurRefusal = (body: unknown): boolean => {
  const code = asRecord(body)?.code;
  return typeof code === "string" && code.startsWith("laf:");
};

/**
 * What an answer that is not the one asked for says, by its status and by who wrote it.
 *
 * The API says every failure in its own words — a `laf:` code, even for the 500 it answers when
 * something threw (`app.onError`). So a 5xx WITHOUT one was written by whatever stands in front of
 * the API — the front door, a proxy, the development server — about an API it could not reach:
 * measured, Vite answers a stopped server with a bare 500. That is `gateway`, the same fact as the
 * front door's own words for it. Only a 5xx the API wrote itself is `server_error`: it is running,
 * and calling that a gateway would send somebody to wait for a restart that is not happening.
 */
function failureOfAnswer(status: number, body: unknown): CheckReason {
  if (isFrontDoorWithoutApi(body)) return "gateway";
  if (isOurRefusal(body)) return status >= 500 ? "server_error" : "unexpected";
  if (status >= 500) return "gateway";
  if (status >= 200 && status < 300) return "not_ours";
  return "unexpected";
}

/** A request that got no answer, as a failure of the check it was for. */
function unanswered(
  id: ConnectionCheckId,
  answer: Exclude<HttpAnswer, { kind: "answered" }>,
): ConnectionCheckResult {
  if (answer.kind === "timed_out") {
    return { id, state: "fail", reason: "timed_out", ms: answer.ms };
  }
  return {
    id,
    state: "fail",
    reason: answer.offline ? "offline" : "no_answer",
    ms: answer.ms,
    error: answer.error,
  };
}

// --- each check, as a function of what came back ------------------------------------------------

export type ServerVerdict = {
  result: ConnectionCheckResult;
  /** The report, when the API itself answered with one. Null means nothing behind it can be asked. */
  report: HealthReport | null;
};

/**
 * `/api/health`: whether this product's server answered, from here.
 *
 * A DEGRADED REPORT IS A PASS FOR THIS ROW. The server answered — 503 and all — and what it says is
 * down gets a row of its own below; failing the server for its database would tell somebody their
 * connection is broken when the connection is the one thing that worked.
 */
export function serverVerdict(answer: HttpAnswer): ServerVerdict {
  if (answer.kind !== "answered") {
    return { result: unanswered("server", answer), report: null };
  }
  const report = healthReportOf(answer.body);
  const base = {
    id: "server" as const,
    ms: answer.ms,
    ...statusOf(answer.status),
  };
  if (report) {
    return { result: { ...base, state: "pass", reason: "answered" }, report };
  }
  return {
    result: {
      ...base,
      state: "fail",
      reason: failureOfAnswer(answer.status, answer.body),
    },
    report: null,
  };
}

/** The report's names for the three rows it answers (`deploymentHealthProbes`). */
const REPORTED = {
  database: "database",
  botService: "agentBot",
  computer: "computer",
} as const;

/**
 * What the report says about the Bots' service, the Bots' computer and the database.
 *
 * A computer the report does not name is a deployment without one (`health.ts` leaves the probe out
 * rather than calling it down), so that row is skipped as not being there, not failed.
 */
export function reportVerdicts(
  report: HealthReport | null,
): ConnectionCheckResult[] {
  return (["database", "botService", "computer"] as const).map((id) => {
    if (!report) return { id, state: "skip", reason: "no_server" };
    const said = report.checks[REPORTED[id]];
    if (said === undefined) {
      return {
        id,
        state: "skip",
        reason: id === "computer" ? "not_configured" : "not_reported",
      };
    }
    return said === "ok"
      ? { id, state: "pass", reason: "ok" }
      : { id, state: "fail", reason: "down" };
  });
}

/** `/api/me`: whether this window is still signed in. Only whether: nothing in the answer is kept. */
export function sessionVerdict(answer: HttpAnswer): ConnectionCheckResult {
  if (answer.kind !== "answered") return unanswered("session", answer);
  const base = {
    id: "session" as const,
    ms: answer.ms,
    ...statusOf(answer.status),
  };
  const body = asRecord(answer.body);
  if (answer.status === 200 && typeof asRecord(body?.user)?.id === "string") {
    return { ...base, state: "pass", reason: "signed_in" };
  }
  if (answer.status === 401) {
    return {
      ...base,
      state: "fail",
      reason: body?.code === "laf:session_revoked" ? "revoked" : "signed_out",
    };
  }
  if (answer.status === 403)
    return { ...base, state: "fail", reason: "forbidden" };
  return {
    ...base,
    state: "fail",
    reason: failureOfAnswer(answer.status, answer.body),
  };
}

const isLocalHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname.endsWith(".localhost");

/** Whether this page came over https, or is the development server on this machine. Which, said. */
export function secureVerdict(location: {
  protocol: string;
  hostname: string;
}): ConnectionCheckResult {
  if (location.protocol === "https:") {
    return { id: "secure", state: "pass", reason: "https" };
  }
  if (location.protocol === "http:" && isLocalHost(location.hostname)) {
    return { id: "secure", state: "pass", reason: "local" };
  }
  return { id: "secure", state: "fail", reason: "insecure" };
}

/** The close code a door ends a socket with when the person's sessions were ended. */
const SESSION_ENDED_CLOSE = 4401;

export function socketVerdict(
  id: "conversationSocket" | "liveScreenSocket",
  answer: SocketAnswer,
): ConnectionCheckResult {
  switch (answer.kind) {
    case "answered":
      return { id, state: "pass", reason: "answered", ms: answer.ms };
    case "unsupported":
      return { id, state: "fail", reason: "unsupported", error: answer.error };
    case "not_opened":
      return {
        id,
        state: "fail",
        reason: "not_opened",
        ms: answer.ms,
        ...(answer.close !== null ? { close: answer.close } : {}),
      };
    case "timed_out":
      return {
        id,
        state: "fail",
        reason: answer.opened ? "silent" : "timed_out",
        ms: answer.ms,
      };
    case "closed_early":
      return {
        id,
        state: "fail",
        reason:
          answer.close === SESSION_ENDED_CLOSE
            ? "session_ended"
            : "closed_early",
        ms: answer.ms,
        ...(answer.close !== null ? { close: answer.close } : {}),
      };
  }
}

/**
 * More than this between the device's clock and the server's is worth a person's time.
 *
 * Routines run on the server's clock and every countdown the app draws — an approval's ten minutes,
 * a trial's last day — is the server's time read on this device's. A minute off is where those start
 * to read wrong; below it, the `Date` header's whole seconds and the trip itself are most of the gap.
 */
export const CLOCK_SKEW_LIMIT_MS = 60_000;

/**
 * `/api/version`'s `Date` header against this device's clock at the middle of the request.
 *
 * Only an answer from this product's API is read — a build in the body — because a proxy's error
 * page carries a `Date` too, and the clock worth comparing with is the one routines run on.
 */
export function clockVerdict(
  answer: HttpAnswer,
  deviceAtMiddle: number,
): ConnectionCheckResult {
  if (
    answer.kind !== "answered" ||
    answer.status !== 200 ||
    typeof asRecord(answer.body)?.version !== "string"
  ) {
    return { id: "clock", state: "skip", reason: "no_server" };
  }
  const sent = answer.date ? Date.parse(answer.date) : Number.NaN;
  if (Number.isNaN(sent)) {
    return { id: "clock", state: "skip", reason: "no_date" };
  }
  // The header is cut to the whole second: the server's moment lies somewhere in the next one.
  const skewMs = clamp(
    Math.round(deviceAtMiddle - (sent + 500)),
    -CHECK_SKEW_MAX_MS,
    CHECK_SKEW_MAX_MS,
  );
  return Math.abs(skewMs) > CLOCK_SKEW_LIMIT_MS
    ? { id: "clock", state: "fail", reason: "skewed", skewMs }
    : { id: "clock", state: "pass", reason: "in_sync", skewMs };
}

/** The Bot a live-screen probe names: one of the person's own, or why there is none. */
export function probeBotOf(
  answer: HttpAnswer,
): { botId: string } | { reason: "no_bot" | "bots_unreadable" } {
  const agents =
    answer.kind === "answered" && answer.status === 200
      ? asRecord(answer.body)?.agents
      : undefined;
  if (!Array.isArray(agents)) return { reason: "bots_unreadable" };
  const bots = agents
    .map(asRecord)
    .filter(
      (bot): bot is Record<string, unknown> =>
        bot !== null && typeof bot.id === "string" && bot.id.length > 0,
    );
  // The door opens only for the person's own Bot or one nobody made (`auth/stream-access.ts`).
  const pick = bots.find((bot) => bot.mine === true) ?? bots[0];
  return pick ? { botId: pick.id as string } : { reason: "no_bot" };
}

// --- the run -------------------------------------------------------------------------------------

/** The part of a WebSocket a probe uses. A real one is one; the tests hand in their own. */
export type ProbeSocket = {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  close: () => void;
};

export type CheckIO = {
  /** A request to this origin, abandoned when `signal` aborts. */
  request: (path: string, signal: AbortSignal) => Promise<Response>;
  /** A socket to this origin. May throw, which is its own answer. */
  openSocket: (path: string) => ProbeSocket;
  /** A clock for durations. */
  elapsed: () => number;
  /** This device's own clock, for comparing with the server's. */
  wallClock: () => number;
  /** Whether the device says it is offline — the one reading of `navigator.onLine` that means much. */
  isOffline: () => boolean;
  location: { protocol: string; hostname: string };
  surface: CheckSurface;
};

/**
 * How long each step may take. A step that takes longer has answered, and the answer is no.
 *
 * Long enough for a slow mobile connection to finish a real answer — the server's own health probes
 * give up at two seconds, so ten is well past a server that is merely busy.
 */
export const CHECK_BOUNDS = {
  requestMs: 10_000,
  openMs: 8_000,
  firstMessageMs: 5_000,
};

type Bounds = typeof CHECK_BOUNDS;

async function ask(
  io: CheckIO,
  path: string,
  bounds: Bounds,
  cancel: AbortSignal | undefined,
): Promise<HttpAnswer> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timer = setTimeout(stop, bounds.requestMs);
  cancel?.addEventListener("abort", stop);
  if (cancel?.aborted) stop();
  const started = io.elapsed();
  const took = () => clamp(Math.round(io.elapsed() - started), 0, CHECK_MS_MAX);
  try {
    const response = await io.request(path, controller.signal);
    const ms = took();
    const body: unknown = await response.json().catch(() => undefined);
    return {
      kind: "answered",
      ms,
      status: response.status,
      body,
      date: response.headers.get("date"),
    };
  } catch (error) {
    if (controller.signal.aborted) return { kind: "timed_out", ms: took() };
    return {
      kind: "threw",
      ms: took(),
      error: errorClassOf(error),
      offline: io.isOffline(),
    };
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener("abort", stop);
  }
}

function probe(
  io: CheckIO,
  path: string,
  bounds: Bounds,
  cancel: AbortSignal | undefined,
): Promise<SocketAnswer> {
  return new Promise((resolve) => {
    const started = io.elapsed();
    const took = () =>
      clamp(Math.round(io.elapsed() - started), 0, CHECK_MS_MAX);
    let socket: ProbeSocket;
    try {
      socket = io.openSocket(path);
    } catch (error) {
      resolve({ kind: "unsupported", error: errorClassOf(error) });
      return;
    }
    let opened = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (answer: SocketAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancel?.removeEventListener("abort", abandon);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Already closed, which is what was wanted.
      }
      resolve(answer);
    };
    const abandon = () => finish({ kind: "timed_out", ms: took(), opened });
    timer = setTimeout(abandon, bounds.openMs);
    cancel?.addEventListener("abort", abandon);
    if (cancel?.aborted) {
      abandon();
      return;
    }
    socket.onopen = () => {
      opened = true;
      clearTimeout(timer);
      timer = setTimeout(abandon, bounds.firstMessageMs);
    };
    socket.onmessage = () => finish({ kind: "answered", ms: took() });
    // The close that follows an error says how it ended; the error event says nothing.
    socket.onerror = () => {};
    socket.onclose = (event) => {
      const code = event?.code;
      const close =
        typeof code === "number" &&
        Number.isInteger(code) &&
        code >= 1000 &&
        code <= 4999
          ? code
          : null;
      finish(
        opened
          ? { kind: "closed_early", ms: took(), close }
          : { kind: "not_opened", ms: took(), close },
      );
    };
  });
}

const probePath = (path: string) => `${path}?${CONNECTION_PROBE_PARAM}=1`;

export type RunOptions = {
  /** Each result, the moment it is known. */
  onResult?: (result: ConnectionCheckResult) => void;
  /** A step that takes time has started. */
  onStart?: (id: ConnectionCheckId) => void;
  /** Aborted, the run stops where it is, reports nothing more and answers null. */
  signal?: AbortSignal;
  bounds?: Partial<Bounds>;
};

/**
 * Every check, one after another, each said the moment it is known.
 *
 * ONE AFTER ANOTHER, and what an earlier one found decides whether a later one is worth asking. A
 * server that did not answer makes every question behind it a timeout, and a signed-out window makes
 * both sockets a refusal; asking anyway would add a wait and a second failure that says the same
 * thing as the first in words that sound like a different problem — "your network blocks live
 * connections", about a server that is simply down. So those are skipped, with the reason.
 */
export async function runConnectionCheck(
  io: CheckIO,
  options: RunOptions = {},
): Promise<ConnectionCheckFacts | null> {
  const bounds = { ...CHECK_BOUNDS, ...options.bounds };
  const cancel = options.signal;
  const results: ConnectionCheckResult[] = [];
  const say = (result: ConnectionCheckResult) => {
    results.push(result);
    options.onResult?.(result);
  };
  const cancelled = () => cancel?.aborted === true;
  const skip = (
    id: ConnectionCheckId,
    reason: CheckReason,
  ): ConnectionCheckResult => ({ id, state: "skip", reason });

  options.onStart?.("server");
  const health = await ask(io, "/api/health", bounds, cancel);
  if (cancelled()) return null;
  const server = serverVerdict(health);
  say(server.result);
  for (const result of reportVerdicts(server.report)) say(result);
  const serverUp = server.report !== null;

  let session: ConnectionCheckResult = skip("session", "no_server");
  if (serverUp) {
    options.onStart?.("session");
    session = sessionVerdict(await ask(io, "/api/me", bounds, cancel));
    if (cancelled()) return null;
  }
  say(session);
  const signedIn = session.state === "pass";

  say(secureVerdict(io.location));

  const behindTheSession = (id: ConnectionCheckId) =>
    serverUp ? skip(id, "no_session") : skip(id, "no_server");

  if (serverUp && signedIn) {
    options.onStart?.("conversationSocket");
    const answer = await probe(
      io,
      probePath("/api/channels/events"),
      bounds,
      cancel,
    );
    if (cancelled()) return null;
    say(socketVerdict("conversationSocket", answer));
  } else {
    say(behindTheSession("conversationSocket"));
  }

  if (!serverUp || !signedIn) {
    say(behindTheSession("liveScreenSocket"));
  } else if (server.report?.checks.computer === undefined) {
    // No computer here, so no screen: the door would refuse before any network was involved.
    say(skip("liveScreenSocket", "not_configured"));
  } else {
    options.onStart?.("liveScreenSocket");
    const bot = probeBotOf(await ask(io, "/api/agents", bounds, cancel));
    if (cancelled()) return null;
    if ("reason" in bot) {
      say(skip("liveScreenSocket", bot.reason));
    } else {
      const answer = await probe(
        io,
        probePath(`/api/computers/${encodeURIComponent(bot.botId)}/stream`),
        bounds,
        cancel,
      );
      if (cancelled()) return null;
      say(socketVerdict("liveScreenSocket", answer));
    }
  }

  if (serverUp) {
    options.onStart?.("clock");
    const before = io.wallClock();
    const version = await ask(io, "/api/version", bounds, cancel);
    const after = io.wallClock();
    if (cancelled()) return null;
    say(clockVerdict(version, (before + after) / 2));
  } else {
    say(skip("clock", "no_server"));
  }

  return {
    at: new Date(io.wallClock()).toISOString(),
    surface: io.surface,
    checks: results,
  };
}

/** The check as this window runs it. Called at the press, never at import: tests have no window. */
export function browserCheckIO(): CheckIO {
  const monotonic =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now();
  return {
    request: (path, signal) =>
      fetch(path, { credentials: "include", cache: "no-store", signal }),
    openSocket: (path) => {
      // Same origin, so the scheme follows the page: wss when it came over https.
      const url = new URL(path, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(url.toString()) as unknown as ProbeSocket;
    },
    elapsed: monotonic,
    wallClock: () => Date.now(),
    isOffline: () =>
      typeof navigator !== "undefined" && navigator.onLine === false,
    location: {
      protocol: window.location.protocol,
      hostname: window.location.hostname,
    },
    surface: inShell() ? "shell" : "browser",
  };
}

// --- the last result, for this tab ----------------------------------------------------------------

/*
 * MODULE STATE, ON PURPOSE — the arrangement `last-failure.ts` uses for the same reason. One tab, one
 * last check; a reload forgets it. It is what 복사 copies and what the 문의·의견 box can attach, and
 * a check that outlived the window it described would be describing somebody else's afternoon.
 */
let last: ConnectionCheckFacts | null = null;
const listeners = new Set<() => void>();

export function rememberConnectionCheck(facts: ConnectionCheckFacts): void {
  last = facts;
  for (const listener of listeners) listener();
}

export function lastConnectionCheck(): ConnectionCheckFacts | null {
  return last;
}

/**
 * For a screen that draws whether there is one (`useSyncExternalStore`): read in render, module
 * state is a value React cannot see change, and a compiled component would keep its first reading.
 */
export function subscribeToConnectionCheck(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests, which share one module registry. */
export function forgetConnectionCheck(): void {
  last = null;
  for (const listener of listeners) listener();
}

// --- what is copied -------------------------------------------------------------------------------

/**
 * The plain text 복사 puts on the clipboard: one line per check, in the vocabulary's own words.
 *
 * WRITTEN FROM THE READING, NOT FROM THE OBJECT. The result is read back through
 * `readConnectionCheck` first — the reading the server applies before it keeps one — and only what
 * survives it is written, so the text cannot carry a field the vocabulary does not have. The words are
 * codes rather than Korean on purpose: whoever the person pastes this to reads codes, and a sentence
 * would be the surface's words about the facts rather than the facts.
 */
export function connectionCheckText(facts: ConnectionCheckFacts): string {
  const read = readConnectionCheck(facts);
  if (!read) return "connection-check unreadable";
  const lines = [`connection-check ${read.at} surface=${read.surface}`];
  for (const check of read.checks) {
    const parts: string[] = [check.id, check.state, check.reason];
    if (check.ms !== undefined) parts.push(`${check.ms}ms`);
    if (check.http !== undefined) parts.push(`http=${check.http}`);
    if (check.close !== undefined) parts.push(`close=${check.close}`);
    if (check.error !== undefined) parts.push(`error=${check.error}`);
    if (check.skewMs !== undefined) {
      // `|| 0` so a gap under half a second reads +0s rather than the -0 rounding makes of it.
      const seconds = Math.round(check.skewMs / 1000) || 0;
      parts.push(`skew=${seconds >= 0 ? "+" : ""}${seconds}s`);
    }
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

// --- the words -----------------------------------------------------------------------------------

/** A row's name. */
export function checkName(id: ConnectionCheckId): string {
  switch (id) {
    case "server":
      return t("The app's server");
    case "database":
      return t("Database");
    case "botService":
      return t("Bot service");
    case "computer":
      return t("The Bots' computer");
    case "session":
      return t("Sign-in");
    case "secure":
      return t("Secure connection");
    case "conversationSocket":
      return t("Live connection for conversations");
    case "liveScreenSocket":
      return t("Live connection for the Bot's screen");
    case "clock":
      return t("This device's clock");
  }
}

/** A gap between two clocks, in the largest unit that says it. */
export function gapWords(ms: number): string {
  const seconds = Math.round(Math.abs(ms) / 1000);
  if (seconds < 60) return t("{count} s", { count: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("{count} min", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("{count} h", { count: hours });
  return t("{count} d", { count: Math.round(hours / 24) });
}

/** What the row says at its right edge once it is done: a timing, a fact, or the state. */
export function resultDetail(result: ConnectionCheckResult): string {
  if (result.state === "skip") return t("Skipped");
  if (result.state === "fail") return t("Failed");
  if (result.id === "secure") {
    return result.reason === "local" ? t("Local development address") : "https";
  }
  if (result.id === "clock") {
    const gap = Math.abs(result.skewMs ?? 0);
    return gap < 1_000
      ? t("Under a second apart")
      : t("{gap} apart", { gap: gapWords(gap) });
  }
  if (result.ms !== undefined) return t("{ms} ms", { ms: result.ms });
  return t("Working");
}

/** Why a check was not run. */
function skipReason(reason: CheckReason): string {
  switch (reason) {
    case "no_session":
      return t("Not checked, because the sign-in did not pass.");
    case "no_bot":
      return t("You have no Bot yet, so there is no screen to check.");
    case "bots_unreadable":
      return t("Your Bots could not be read, so this was not checked.");
    case "not_configured":
      return t("This server has no computer for Bots.");
    case "not_reported":
      return t("The server's report did not include this.");
    case "no_date":
      return t("The server's answer carried no time to compare with.");
    default:
      return t("The server did not answer, so this was not checked.");
  }
}

/** The sentence for a request to the server that failed, by why. */
function serverSentence(reason: CheckReason): string {
  switch (reason) {
    case "offline":
      return t(
        "This device is not connected to the internet, so check the Wi-Fi or the cable and check again.",
      );
    case "timed_out":
      return t(
        "The server took too long to answer, so check again in a moment on a steadier connection.",
      );
    case "gateway":
      return t(
        "The address answered but the app's server behind it did not; this usually clears on its own, so check again in a few minutes.",
      );
    case "server_error":
      return t(
        "The server answered with an error, so check again in a minute, and tell us through Questions and feedback if it keeps happening.",
      );
    case "not_ours":
      return t(
        "Something other than the app's server answered; if this network asks you to sign in or agree first, as in a café or hotel, do that and check again.",
      );
    case "unexpected":
      return t(
        "The server gave an answer the app did not expect, so check again in a minute, and tell us through Questions and feedback if it keeps happening.",
      );
    default:
      return t(
        "The server did not answer this device, so check again in a minute, and try another network if it keeps happening.",
      );
  }
}

/** The sentence for a socket that did not do its job, by why and by which. */
function socketSentence(
  result: ConnectionCheckResult,
  others: readonly ConnectionCheckResult[],
): string {
  switch (result.reason) {
    case "unsupported":
      return t(
        "This browser cannot open live connections, so update it or use the installed app.",
      );
    case "session_ended":
      return t("This sign-in was ended on the server, so sign in again.");
    case "silent":
      return t(
        "The live connection opened but nothing came through; a security program or a company network may be holding it back, so try another network.",
      );
    case "closed_early":
      return t(
        "The live connection was cut before anything came through, so check again, and try another network if it keeps happening.",
      );
  }
  /*
   * THE SCREEN'S SOCKET FAILING WHERE THE CONVERSATION'S GOT THROUGH is not the network: both go to
   * the same address through the same doors, and the only difference between them is on the server.
   * Failing the same way as the conversation's, it is the same fact, and it is said as one.
   */
  const conversation = others.find(
    (other) => other.id === "conversationSocket",
  );
  if (result.id === "liveScreenSocket" && conversation?.state === "pass") {
    return t(
      "The Bot's screen could not open its live connection though conversations can, so check again, and tell us through Questions and feedback if it keeps happening.",
    );
  }
  if (
    result.id === "liveScreenSocket" &&
    conversation?.state === "fail" &&
    conversation.reason === result.reason
  ) {
    return t(
      "The Bot's screen uses the same kind of live connection, so the same applies.",
    );
  }
  return t(
    "Ordinary requests reach the server but live connections do not; a company or school network, or a security program, may be blocking them, so try another network such as a phone's hotspot.",
  );
}

/**
 * The one sentence under a row that did not pass: what it probably means, and what to try.
 *
 * Only what the result shows. A socket that failed where plain requests got through is a network
 * that lets one through and not the other, and it is said that way; it is not called a firewall,
 * because nothing here can see one. `others` is the rest of the run, which is what tells those
 * cases apart.
 */
export function adviceFor(
  result: ConnectionCheckResult,
  others: readonly ConnectionCheckResult[] = [],
): string | null {
  if (result.state === "pass") return null;
  if (result.state === "skip") return skipReason(result.reason);
  switch (result.id) {
    case "server":
      return serverSentence(result.reason);
    case "database":
      return t(
        "The server cannot reach its database; it is not this device, so check again in a few minutes.",
      );
    case "botService":
      return t(
        "The server that makes Bots answer is not responding, so Bots cannot reply for now; it is not this device, so check again in a few minutes.",
      );
    case "computer":
      return t(
        "The Bots' computer is not responding, so Bots cannot open websites for now; it is not this device, so check again in a few minutes.",
      );
    case "session":
      if (result.reason === "signed_out") {
        return t("You are signed out, so sign in again.");
      }
      if (result.reason === "revoked") {
        return t("This sign-in was ended on the server, so sign in again.");
      }
      if (result.reason === "forbidden") {
        return t(
          "The server is working. This account's access was taken away, and whoever manages this place can give it back.",
        );
      }
      return t(
        "Whether you are signed in could not be checked, so check again in a moment.",
      );
    case "secure":
      return t(
        "This screen did not come over a secure (https) address, so what passes can be read on the way; open the app from its https address.",
      );
    case "conversationSocket":
    case "liveScreenSocket":
      return socketSentence(result, others);
    case "clock": {
      const gap = gapWords(result.skewMs ?? 0);
      return (result.skewMs ?? 0) > 0
        ? t(
            "This device's clock is {gap} ahead of the server's, so routine times and countdowns will look wrong; turn on setting the time automatically in the device's settings.",
            { gap },
          )
        : t(
            "This device's clock is {gap} behind the server's, so routine times and countdowns will look wrong; turn on setting the time automatically in the device's settings.",
            { gap },
          );
    }
  }
}

/** How many of a finished run did not pass. */
export function failedCount(facts: ConnectionCheckFacts): number {
  return facts.checks.filter((check) => check.state === "fail").length;
}

export const CHECK_TOTAL = CONNECTION_CHECKS.length;
