/**
 * 진단 정보: what the 문의·의견 box can attach when a person ticks it, assembled HERE and never by
 * the browser.
 *
 * WHY. The box sent words and, at most, a path and a code (`routes.ts`). "안 돼요" with nothing
 * beside it is a message the operator answers by getting into somebody's VM and reading
 * `docker compose logs` — the Hermes comparison of 2026-09-07 (§4, row 8) put it as the one gap in
 * a log contract that was otherwise ahead: the lines are clean, and nothing carries them to the
 * person who has to read them. So a small bundle: which build, whether the deployment is healthy,
 * which failures this person's turns have met lately and how often, and their own recent events.
 *
 * SERVER-SIDE, because what a browser assembles a browser can also fill with anything — a
 * transcript under a key nobody looks at. The client never sends a bundle; it sends back the id of
 * one it was SHOWN (`createDiagnosticsShelf`), so what is stored is exactly what the person read
 * before pressing 보내기.
 *
 * NOBODY ELSE'S, AND NOTHING ANYBODY TYPED. A line is kept only when every Bot, run, conversation,
 * room and routine it names is this person's, checked against the tables that say so — a line
 * naming nobody is the deployment's, not theirs, and a line naming a room somebody else is in is
 * not theirs alone. What survives is an allow-list, not a scrub: the time, the level, the event's
 * name, the ids that proved it was theirs, a `laf:` code, a failure's closed fact word, and numbers
 * that are timings and counts. Every string is read back through `shared/log.ts`'s scrubber first
 * (`readLogLine`), and then anything that is not one of those shapes is dropped whole — a Korean
 * sentence, an address, an email, a URL with its query and a password all have characters none of
 * those shapes allow. `diagnostics.test.ts` serialises a bundle built from a log holding all four
 * and looks for them.
 *
 * The run ledger is read the same way: a run's `error` is free text written by whatever threw
 * (`channels/turn-failures.ts` says so), so it is reduced to the transcript's own failure code, and
 * its `label` — a routine's name, which a person wrote — is never read at all.
 *
 * ONE LINE IS OWNED DIFFERENTLY, AND CARRIES SEVEN MORE FACTS (2026-09-18). A part of the app's
 * screen that failed is reported by the app (`screen-errors.ts`), and no Bot, run or room vouches
 * for a screen: the line names the person whose screen it was, and is theirs when that is who asks.
 * What it may carry past the allow-list above is exactly what a report is made of — the section,
 * the route's template, the error's kind, the fingerprint, the build, the commit, the surface — and
 * each is checked again against the closed shapes the route refused by (`shared/screen-errors.ts`).
 * Those are facts by construction: a list, a list, a constructor's name, twelve hex digits, a
 * release word, hex, a list. Nothing else on that line is read, and no other line gains them.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import { type Build, type LogFields, readLogLine } from "../../../shared/log";
import { screenErrorFacts } from "../../../shared/screen-errors";
import type { ConnectionCheckFacts } from "../../../shared/support/connection-check";
import { classifyTurnFailure } from "../channels/turn-failures";
import type { Database } from "../db/client";
import {
  agentProfiles,
  channelMemberships,
  channelThreads,
  lafRoutines,
  lafThreadRuns,
} from "../db/schema";
import type { HealthReport } from "../health";
import { SCREEN_FAILED } from "./screen-errors";

/** How many of the person's events a bundle holds, newest kept. */
export const DIAGNOSTIC_EVENTS_MAX = 50;

/** How far back the failure counts look. Said in the preview, so it is a fact rather than a guess. */
export const FAILURE_WINDOW_DAYS = 7;

/** The refusal when this deployment was built without the pieces a bundle is made from. */
export const DIAGNOSTICS_UNAVAILABLE = "laf:diagnostics_unavailable";

/** The refusal when a send names a bundle this process no longer holds, or never showed this person. */
export const DIAGNOSTICS_EXPIRED = "laf:diagnostics_expired";

/**
 * One event, flat, the way a log line is.
 *
 * `source` says which record it was read from — `log` for a line this server wrote, `run` for a row
 * of the run ledger — so an operator greps the right place for the rest of it.
 */
export type DiagnosticEvent = {
  at: string;
  source: "log" | "run";
  event: string;
  [fact: string]: string | number | boolean;
};

export type FailureCount = {
  code: string;
  count: number;
  /** When the most recent one ended, ISO-8601. */
  lastAt: string;
};

export type DiagnosticBundle = {
  assembledAt: string;
  /** What `GET /api/version` answers. */
  version: Build;
  /** What `GET /health` answered at that moment. */
  health: HealthReport;
  /** The window `failures` was counted over. */
  failureWindowDays: number;
  /** This person's turns that failed in the window, by code, most frequent first. */
  failures: FailureCount[];
  /** This person's own recent events, oldest first, at most `DIAGNOSTIC_EVENTS_MAX`. */
  events: DiagnosticEvent[];
  /**
   * The last 연결 점검 their window ran, when it sent one: the one part of a bundle the browser
   * assembles, because only the window knows what its network lets through. It arrives already read
   * through `readConnectionCheck` (`routes.ts`) — closed values, or nothing.
   */
  connectionCheck?: ConnectionCheckFacts;
};

/** What the fleet's alert webhook is told about a bundle: how much there is, and nothing in it. */
export type DiagnosticsSummary = {
  events: number;
  failures: number;
  failureCodes: number;
  checksDown: number;
};

export function summariseDiagnostics(
  bundle: DiagnosticBundle,
): DiagnosticsSummary {
  return {
    events: bundle.events.length,
    failures: bundle.failures.reduce((total, one) => total + one.count, 0),
    failureCodes: bundle.failures.length,
    checksDown: Object.values(bundle.health.checks).filter(
      (state) => state !== "ok",
    ).length,
  };
}

/** The kinds of thing a line can name, each decided by the table that says whose it is. */
type OwnedKind = "bot" | "run" | "thread" | "channel" | "routine";

/** The field names the server's lines use for each kind, and the one name the bundle uses. */
const ID_FIELDS: Readonly<Record<string, OwnedKind>> = {
  bot: "bot",
  botId: "bot",
  agent: "bot",
  agentId: "bot",
  // A room's member is a Bot (`rooms/service.ts`).
  member: "bot",
  run: "run",
  runId: "run",
  thread: "thread",
  threadId: "thread",
  channel: "channel",
  channelId: "channel",
  routine: "routine",
  routineId: "routine",
};

/**
 * Which of the ids a line might name are this person's. Anything absent is not.
 *
 * `user` is the person themselves, asked about by one line only — a screen that failed (see the
 * module note). Absent, no such line is anybody's.
 */
export type Ownership = Readonly<Record<OwnedKind, ReadonlySet<string>>> & {
  readonly user?: ReadonlySet<string>;
};

/** An id this deployment minted: a UUID, a Bot id. No `@`, no `/`, no space, no Hangul. */
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** The shape every failure code in this product has (the same as `routes.ts` accepts). */
const FACT_CODE = /^laf[:.][a-z0-9_.]{1,60}$/;
/**
 * The closed words `describeFailure` and its siblings (`shared/failure-text.ts`) can say. Anything
 * else `reason` holds is an error's own message — a site's sentence, an address — and is dropped.
 */
const CLOSED_REASON =
  /^(?:database error(?: \([0-9A-Z]{5}\))?|provider_[a-z_]{2,40}(?: \(\d{3}\))?|request_aborted|reply_unusable|no_credential)$/;
/** Timings and counts: the only numbers a bundle carries. */
const NUMBER_FACT =
  /^(?:ms|[a-z][A-Za-z]{0,30}Ms|count|chunks|attempts|status|opaqueFrames|chars|tools|exposed|deferred|spoke)$/;
const EVENT_NAME = /^[a-z0-9_]{1,64}$/;
const SERVICE_NAME = /^[a-z][a-z-]{0,30}$/;
const LEVELS = new Set(["info", "warn", "error"]);

/** The ids a line names, by kind, or null when one of them is not an id at all. */
function namedIds(fields: LogFields): Array<[OwnedKind, string]> | null {
  const named: Array<[OwnedKind, string]> = [];
  for (const [key, value] of Object.entries(fields)) {
    const kind = ID_FIELDS[key];
    if (!kind) continue;
    if (typeof value !== "string" || !ID_SHAPE.test(value)) return null;
    named.push([kind, value]);
  }
  return named;
}

/**
 * A line as an event, when it is this person's; null otherwise.
 *
 * Every id it names must be theirs, and it must name at least one. The facts that survive are the
 * allow-list in the module note; everything else on the line stays on the line.
 */
export function eventFromLine(
  line: string,
  ownership: Ownership,
): DiagnosticEvent | null {
  const fields = readLogLine(line);
  if (!fields) return null;
  if (fields.event === SCREEN_FAILED) return screenEventFrom(fields, ownership);
  const named = namedIds(fields);
  if (!named || named.length === 0) return null;
  if (!named.every(([kind, id]) => ownership[kind].has(id))) return null;

  const at = new Date(String(fields.at));
  const event = String(fields.event);
  if (Number.isNaN(at.getTime()) || !EVENT_NAME.test(event)) return null;

  const out: DiagnosticEvent = { at: at.toISOString(), source: "log", event };
  if (typeof fields.level === "string" && LEVELS.has(fields.level)) {
    out.level = fields.level;
  }
  if (typeof fields.svc === "string" && SERVICE_NAME.test(fields.svc)) {
    out.svc = fields.svc;
  }
  for (const [kind, id] of named) out[kind] = id;
  for (const [key, value] of Object.entries(fields)) {
    if (key === "code" && typeof value === "string" && FACT_CODE.test(value)) {
      out.code = value;
    } else if (
      key === "reason" &&
      typeof value === "string" &&
      (CLOSED_REASON.test(value) || FACT_CODE.test(value))
    ) {
      out.reason = value;
    } else if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      NUMBER_FACT.test(key)
    ) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A screen that failed, when it was this person's screen; null otherwise.
 *
 * Theirs when the line names them as `user`, and names nothing else: the route writes the person
 * and the report and no id besides, so a `screen_failed` line naming a Bot or a room is not one it
 * wrote. Then the same time, level and service as every other line, and the report's facts that
 * still fit their shapes — each one alone, so a fact a newer rule refuses leaves the rest standing.
 */
function screenEventFrom(
  fields: LogFields,
  ownership: Ownership,
): DiagnosticEvent | null {
  const person = fields.user;
  if (typeof person !== "string" || !ownership.user?.has(person)) return null;
  if (namedIds(fields)?.length !== 0) return null;
  const at = new Date(String(fields.at));
  if (Number.isNaN(at.getTime())) return null;

  const out: DiagnosticEvent = {
    at: at.toISOString(),
    source: "log",
    event: SCREEN_FAILED,
  };
  if (typeof fields.level === "string" && LEVELS.has(fields.level)) {
    out.level = fields.level;
  }
  if (typeof fields.svc === "string" && SERVICE_NAME.test(fields.svc)) {
    out.svc = fields.svc;
  }
  for (const [fact, value] of Object.entries(screenErrorFacts(fields))) {
    if (typeof value === "string") out[fact] = value;
  }
  return out;
}

/** The columns of a run the bundle reads. Never `label`, never `dedupeKey`. */
export type LedgerRun = {
  runId: string;
  agentId: string | null;
  status: "running" | "done" | "error" | "stopped" | "unknown";
  origin: string;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

/** A run's status as an event name, in the words agent-bot's own lines use for the same run. */
function runEventName(status: LedgerRun["status"]): string {
  switch (status) {
    case "running":
      return "run_started";
    case "done":
      return "run_finished";
    case "error":
      return "run_failed";
    case "stopped":
      return "run_stopped";
    case "unknown":
      return "run_interrupted";
  }
}

/** The failure code a run ended with, in the transcript's terms. Null for one that did not fail. */
function failureOf(run: Pick<LedgerRun, "status" | "error">): string | null {
  if (run.status === "unknown") return "laf:turn_interrupted";
  if (run.status === "error") return classifyTurnFailure(run.error);
  return null;
}

export function eventFromRun(run: LedgerRun): DiagnosticEvent | null {
  if (!ID_SHAPE.test(run.runId)) return null;
  const endedAt = run.finishedAt ?? run.startedAt;
  const out: DiagnosticEvent = {
    at: endedAt.toISOString(),
    source: "run",
    event: runEventName(run.status),
    run: run.runId,
    origin: run.origin,
  };
  if (run.agentId && ID_SHAPE.test(run.agentId)) out.bot = run.agentId;
  const code = failureOf(run);
  if (code) out.code = code;
  if (run.finishedAt) {
    out.ms = Math.max(0, run.finishedAt.getTime() - run.startedAt.getTime());
  }
  return out;
}

export function countFailures(
  runs: readonly Pick<
    LedgerRun,
    "status" | "error" | "startedAt" | "finishedAt"
  >[],
): FailureCount[] {
  const byCode = new Map<string, FailureCount>();
  for (const run of runs) {
    const code = failureOf(run);
    if (!code) continue;
    const at = (run.finishedAt ?? run.startedAt).toISOString();
    const seen = byCode.get(code);
    if (!seen) {
      byCode.set(code, { code, count: 1, lastAt: at });
      continue;
    }
    seen.count += 1;
    if (at > seen.lastAt) seen.lastAt = at;
  }
  return [...byCode.values()].sort(
    (a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt),
  );
}

/**
 * The whole bundle from what was read. Pure: the tests hand it a log and a ledger of their own.
 */
export function assembleDiagnostics(input: {
  lines: readonly string[];
  ownership: Ownership;
  runs: readonly LedgerRun[];
  failedRuns: readonly LedgerRun[];
  version: Build;
  health: HealthReport;
  now: Date;
  connectionCheck?: ConnectionCheckFacts | null;
}): DiagnosticBundle {
  const events = [
    ...input.lines.map((line) => eventFromLine(line, input.ownership)),
    ...input.runs.map(eventFromRun),
  ]
    .filter((event): event is DiagnosticEvent => event !== null)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-DIAGNOSTIC_EVENTS_MAX);
  return {
    assembledAt: input.now.toISOString(),
    version: {
      version: input.version.version,
      ...(input.version.revision ? { revision: input.version.revision } : {}),
      ...(input.version.channel ? { channel: input.version.channel } : {}),
    },
    health: { status: input.health.status, checks: input.health.checks },
    failureWindowDays: FAILURE_WINDOW_DAYS,
    failures: countFailures(input.failedRuns),
    events,
    ...(input.connectionCheck
      ? { connectionCheck: input.connectionCheck }
      : {}),
  };
}

/** The ids of each kind the lines name, so ownership is asked about those and no others. */
function idsNamedIn(lines: readonly string[]): Record<OwnedKind, Set<string>> {
  const found: Record<OwnedKind, Set<string>> = {
    bot: new Set(),
    run: new Set(),
    thread: new Set(),
    channel: new Set(),
    routine: new Set(),
  };
  for (const line of lines) {
    const fields = readLogLine(line);
    const named = fields ? namedIds(fields) : null;
    for (const [kind, id] of named ?? []) found[kind].add(id);
  }
  return found;
}

export type DiagnosticsSource = {
  assemble: (
    userId: string,
    deployment: { version: Build; health: HealthReport },
    /** The person's last 연결 점검, already read through the vocabulary. */
    connectionCheck?: ConnectionCheckFacts | null,
  ) => Promise<DiagnosticBundle>;
};

/**
 * The bundle, from this process's own log tail and this deployment's tables.
 *
 * Ownership is asked of the tables that write it down, and only about ids the tail actually names:
 * a Bot by `agent_profiles.owner_user_id` (a deleted Bot's past is still its owner's), a run by the
 * ledger's `user_id`, a conversation by `channel_threads` (unique on the thread), a routine by
 * authorship or by the Bot it drives (the rule `routines/service.ts` reads), and a room only when
 * nobody else is in it.
 */
export function createDiagnosticsSource(input: {
  database: Database;
  lines: () => readonly string[];
  now?: () => Date;
}): DiagnosticsSource {
  const { database } = input;
  const now = input.now ?? (() => new Date());

  const ownedBy = async (
    userId: string,
    named: Record<OwnedKind, Set<string>>,
  ): Promise<Ownership> => {
    const list = (kind: OwnedKind) => [...named[kind]];
    const [bots, runs, threads, channels, routines] = await Promise.all([
      named.bot.size || named.routine.size
        ? database
            .select({ id: agentProfiles.agentId })
            .from(agentProfiles)
            .where(eq(agentProfiles.ownerUserId, userId))
        : [],
      named.run.size
        ? database
            .select({ id: lafThreadRuns.runId })
            .from(lafThreadRuns)
            .where(
              and(
                eq(lafThreadRuns.userId, userId),
                inArray(lafThreadRuns.runId, list("run")),
              ),
            )
        : [],
      named.thread.size
        ? database
            .select({ id: channelThreads.threadId })
            .from(channelThreads)
            .where(
              and(
                eq(channelThreads.userId, userId),
                inArray(channelThreads.threadId, list("thread")),
              ),
            )
        : [],
      named.channel.size
        ? database
            .select({
              id: channelMemberships.channelId,
              userId: channelMemberships.userId,
            })
            .from(channelMemberships)
            .where(inArray(channelMemberships.channelId, list("channel")))
        : [],
      named.routine.size
        ? database
            .select({
              id: lafRoutines.id,
              createdById: lafRoutines.createdById,
              agentId: lafRoutines.agentId,
            })
            .from(lafRoutines)
            .where(inArray(lafRoutines.id, list("routine")))
        : [],
    ]);

    const ownBots = new Set(bots.map((row) => row.id));
    const members = new Map<string, Set<string>>();
    for (const row of channels) {
      const people = members.get(row.id) ?? new Set<string>();
      people.add(row.userId);
      members.set(row.id, people);
    }
    return {
      // The person asking, for the one line that names a person rather than a thing of theirs.
      user: new Set([userId]),
      bot: new Set([...named.bot].filter((id) => ownBots.has(id))),
      run: new Set(runs.map((row) => row.id)),
      thread: new Set(threads.map((row) => row.id)),
      channel: new Set(
        [...members]
          .filter(([, people]) => people.size === 1 && people.has(userId))
          .map(([id]) => id),
      ),
      routine: new Set(
        routines
          .filter(
            (row) => row.createdById === userId || ownBots.has(row.agentId),
          )
          .map((row) => row.id),
      ),
    };
  };

  const ledgerColumns = {
    runId: lafThreadRuns.runId,
    agentId: lafThreadRuns.agentId,
    status: lafThreadRuns.status,
    origin: lafThreadRuns.origin,
    error: lafThreadRuns.error,
    startedAt: lafThreadRuns.startedAt,
    finishedAt: lafThreadRuns.finishedAt,
  };

  return {
    async assemble(userId, deployment, connectionCheck) {
      const at = now();
      const lines = input.lines();
      const since = new Date(
        at.getTime() - FAILURE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      const [ownership, runs, failedRuns] = await Promise.all([
        ownedBy(userId, idsNamedIn(lines)),
        database
          .select(ledgerColumns)
          .from(lafThreadRuns)
          .where(eq(lafThreadRuns.userId, userId))
          .orderBy(desc(lafThreadRuns.startedAt))
          .limit(DIAGNOSTIC_EVENTS_MAX),
        database
          .select(ledgerColumns)
          .from(lafThreadRuns)
          .where(
            and(
              eq(lafThreadRuns.userId, userId),
              gte(lafThreadRuns.startedAt, since),
              or(
                eq(lafThreadRuns.status, "error"),
                eq(lafThreadRuns.status, "unknown"),
              ),
            ),
          )
          .orderBy(desc(lafThreadRuns.startedAt))
          // A deployment failing every minute for a week is 10,080 rows; the counts are what matter.
          .limit(2_000),
      ]);
      return assembleDiagnostics({
        lines,
        ownership,
        runs,
        failedRuns,
        version: deployment.version,
        health: deployment.health,
        now: at,
        connectionCheck,
      });
    },
  };
}

/**
 * The bundles a person has been SHOWN, held until they send one or it goes stale.
 *
 * In this process, on purpose (`docs/laf/deployment-model.md`: one API process per VM): a send
 * names the id of what the preview drew, and that exact bundle is what gets stored — not a second
 * one assembled a minute later with an event the person never saw. A restart forgets them, and a
 * send that names a forgotten one is refused (`laf:diagnostics_expired`) so the box can show the
 * new one first rather than attach something unseen.
 */
export type DiagnosticsShelf = {
  hold: (userId: string, bundle: DiagnosticBundle) => string;
  /** The bundle this person was shown under `id`, or null. Another person's id is null too. */
  find: (userId: string, id: string) => DiagnosticBundle | null;
  release: (id: string) => void;
};

export function createDiagnosticsShelf(
  options: { ttlMs?: number; max?: number; now?: () => number } = {},
): DiagnosticsShelf {
  const ttlMs = options.ttlMs ?? 30 * 60 * 1000;
  const max = options.max ?? 200;
  const now = options.now ?? Date.now;
  const held = new Map<
    string,
    { userId: string; bundle: DiagnosticBundle; at: number }
  >();

  const sweep = () => {
    const stale = now() - ttlMs;
    for (const [id, entry] of held) {
      if (entry.at <= stale) held.delete(id);
    }
    // Insertion-ordered: past the cap, the oldest go first.
    for (const id of held.keys()) {
      if (held.size <= max) break;
      held.delete(id);
    }
  };

  return {
    hold(userId, bundle) {
      const id = randomUUID();
      held.set(id, { userId, bundle, at: now() });
      sweep();
      return id;
    },
    find(userId, id) {
      sweep();
      const entry = held.get(id);
      return entry && entry.userId === userId ? entry.bundle : null;
    },
    release(id) {
      held.delete(id);
    },
  };
}
