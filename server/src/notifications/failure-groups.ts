/**
 * A failure that keeps happening is one thing to be told about, not one per run.
 *
 * WHAT IT REPLACES. A routine that runs every hour and fails every hour for the same reason — a
 * provider refusing, a tool the Bot cannot use — drew a new heading and a new red line in the Bot's
 * conversation and raised a new `run.failed` notification every hour. By the afternoon the person
 * has eight identical red lines and eight identical buzzes, and what they learn is to stop reading
 * red. `alert-discipline` principle 2 says only a change of state is news; this is the one place the
 * code was not keeping it.
 *
 * THE SIGNATURE. A failure belongs to a group by (whose failure, what code, what the code names):
 * `routine:<id>`, the transcript's own failure code, and the tool the run could not use when the
 * code is about one. The first failure of a signature opens a group — one mark in the conversation,
 * one notification. Every later failure with the same signature is counted into it and writes
 * nothing else: no mark, no notification, no roster movement. A success of the routine closes all
 * of its open groups, so the next failure is news again. A different code is a different group,
 * and so is the same code about a different tool.
 *
 * WHERE A GROUP LIVES: IN THE NOTIFICATION IT RAISED. The `run.failed` outbox row the first failure
 * wrote is the group; its `subject` carries the signature, the count, the first and last
 * occurrence, the run the conversation's mark is keyed to, and whether the person has acknowledged
 * it or a success has closed it. No table of its own, because a group is exactly "a notification
 * that is still true" — and the row outlives a restart, which an in-memory counter would not. The
 * retention sweep keeps a group until thirty days after its last failure (`outbox.ts`).
 *
 * WRITTEN INSIDE THE RUN'S OWN SETTLEMENT. Whether this failure gets a mark in the conversation and
 * whether it counts as a repeat are one decision, so they commit together (`routines/settlement.ts`);
 * decided apart, a notification that failed to write would have left the next failure drawing a
 * second red line anyway. Offering the row to the doors still happens after the commit, from the
 * trail (`from-audit.ts`), because nothing may be announced for a record that could roll back.
 * Every write here is in a savepoint and swallows its own failure: a group that could not be
 * recorded is a failure told about the old way, never a run whose record was lost.
 *
 * WHAT IS NOT GROUPED, ON PURPOSE. A person's own question that fails keeps its own line: the next
 * question is not the same work repeated, and a line that moved away from a question would leave it
 * sitting unanswered with no sign why. A run the process died on is reported by boot once per
 * restart (`runner/laf-runner.ts`); each restart is its own event.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { TurnFailureCode } from "../channels/turn-failures";
import type { Database } from "../db/client";
import { lafNotifications } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import type { Executor } from "../runner/thread-store";
import type { RunFailureFacts } from "./outbox";

/** What a group keeps under `group` in its `run.failed` row's subject. */
export type FailureGroupFacts = {
  /** Whose failures these are: `routine:<id>`. */
  scope: string;
  /** What the code names — the tool a run could not use. Empty when the code names nothing. */
  target: string;
  /** How many failures the group holds, the one that opened it included. */
  count: number;
  firstAt: string;
  lastAt: string;
  /**
   * The ledger run of the failure that opened the group, which is the one that left a mark.
   *
   * The transcript's red line is keyed to that run (`channels/turn-failures.ts`), so this is how
   * the line finds the count it stands for. Absent when that failure left no mark: a Bot with no
   * conversation yet, or a run the ledger could not open.
   */
  runId?: string;
  /** The person said 확인. The group stays open, and stays quiet. */
  acknowledgedAt?: string;
  /** A success of the same routine. The next failure opens a new group. */
  closedAt?: string;
};

/** Which group a failure belongs to. See the module note. */
export type FailureSignature = {
  scope: string;
  code: TurnFailureCode;
  target: string;
};

/** A failure, as the settlement counted it, and as the trail row records it. */
export type CountedFailure = {
  /** The group's row in the outbox. */
  id: string;
  count: number;
  /** This failure opened the group, and is therefore the only one worth a notification. */
  opened: boolean;
};

/** A group as the transcript's line reads it. */
export type FailureGroupMark = {
  /** The group's row. What 확인 sends back (`POST /api/me/notifications/:id/acknowledge`). */
  id: string;
  count: number;
  lastAt: string;
  acknowledged: boolean;
  closed: boolean;
};

/**
 * The codes that are about one tool, and so name it.
 *
 * `laf:turn_tool_failed` is a Bot that could not use a tool — a name that does not exist, arguments
 * that are not an object, the same call over and over. "Could not use the search tool" and "could
 * not use the browser" are two problems with two fixes, so they are two groups. Every other code
 * is about the run as a whole — the model, the Bot's address, the clock — and names nothing more
 * than the routine already does.
 */
const NAMES_A_TOOL: ReadonlySet<TurnFailureCode> = new Set<TurnFailureCode>([
  "laf:turn_tool_failed",
]);

/** The turns a run took, as much of them as the signature reads. */
type Steps = ReadonlyArray<{
  calls: ReadonlyArray<{ name: string; ok: boolean }>;
}> | null;

/** The last call in the run that did not go through, which is the tool the run ended on. */
function lastRefusedCall(steps: Steps): string {
  for (const step of [...(steps ?? [])].reverse()) {
    for (const call of [...step.calls].reverse()) {
      if (!call.ok && call.name) return call.name;
    }
  }
  return "";
}

/** Whose failures a routine's are. What a success of that routine closes. */
export const routineScope = (routineId: string) => `routine:${routineId}`;

export function routineFailureSignature(input: {
  routineId: string;
  code: TurnFailureCode;
  steps: Steps;
}): FailureSignature {
  return {
    scope: routineScope(input.routineId),
    code: input.code,
    target: NAMES_A_TOOL.has(input.code) ? lastRefusedCall(input.steps) : "",
  };
}

/**
 * A class id for `pg_advisory_xact_lock`, apart from the thread store's (`0x1af7`).
 *
 * Held on the scope for the rest of the settlement's transaction, so "is there an open group" and
 * "open one" cannot interleave with another run of the same routine. The Bot lane already runs one
 * thing at a time per Bot; the lock is what makes that true of every caller, a test with no lane
 * included, rather than true of the callers that happen to share one.
 */
const LOCK_CLASS = 0x1af8;

const lockScope = (scope: string) =>
  sql`select pg_advisory_xact_lock(${LOCK_CLASS}, hashtext(${scope}))`;

/** A row's group facts, as SQL: `subject -> 'group'`. */
const groupColumn = sql`${lafNotifications.subject} -> 'group'`;

/** The open group of this signature, addressed to this person. */
const openGroupOf = (userId: string, signature: FailureSignature) =>
  and(
    eq(lafNotifications.kind, "run.failed"),
    eq(lafNotifications.userId, userId),
    sql`${groupColumn} ->> 'scope' = ${signature.scope}`,
    sql`${lafNotifications.subject} ->> 'code' = ${signature.code}`,
    sql`${groupColumn} ->> 'target' = ${signature.target}`,
    sql`${groupColumn} ->> 'closedAt' is null`,
  );

/**
 * The subject with some of its group's fields replaced.
 *
 * `||` over `jsonb_set` on purpose: `jsonb_set` is strict, and a NULL anywhere in its arguments
 * turns the whole column NULL — a group's facts erased by a count that did not parse. Text
 * parameters are turned into JSON by `jsonb_build_object`, never cast to `jsonb` directly, which
 * this driver would store as a JSON string (see `db/schema/json.ts`).
 */
const withGroupFields = (fields: SQL) =>
  sql`${lafNotifications.subject} || jsonb_build_object('group', coalesce(${groupColumn}, '{}'::jsonb) || ${fields})`;

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function groupFactsOf(subject: unknown): Partial<FailureGroupFacts> {
  if (!subject || typeof subject !== "object") return {};
  const held = (subject as { group?: unknown }).group;
  return held && typeof held === "object"
    ? (held as Partial<FailureGroupFacts>)
    : {};
}

/**
 * Count this failure into the open group of its signature, if there is one.
 *
 * `unavailable` is kept apart from `new`: a group that could not be looked up must not be taken for
 * a group that does not exist, or a database having a bad minute would open a second group — and a
 * second notification — for a failure that is already being counted.
 */
export async function countRepeatedFailure(
  executor: Executor,
  input: { userId: string; signature: FailureSignature; at: Date },
): Promise<
  | { kind: "repeat"; id: string; count: number }
  | { kind: "new" }
  | { kind: "unavailable" }
> {
  try {
    return await executor.transaction(async (savepoint) => {
      await savepoint.execute(lockScope(input.signature.scope));
      const [row] = await savepoint
        .update(lafNotifications)
        .set({
          subject: withGroupFields(
            sql`jsonb_build_object('count', coalesce((${groupColumn} ->> 'count')::int, 1) + 1, 'lastAt', ${input.at.toISOString()}::text)`,
          ),
        })
        .where(openGroupOf(input.userId, input.signature))
        .returning({
          id: lafNotifications.id,
          subject: lafNotifications.subject,
        });
      if (!row) return { kind: "new" as const };
      return {
        kind: "repeat" as const,
        id: row.id,
        count: numberOf(groupFactsOf(row.subject).count, 2),
      };
    });
  } catch (error) {
    log.error("failure_group_not_counted", {
      scope: input.signature.scope,
      reason: describeFailure(error),
    });
    return { kind: "unavailable" };
  }
}

/**
 * Open a group with this failure in it: the `run.failed` row, written and offered to nobody yet.
 *
 * The caller's transaction owns the row until it commits; `outbox.offer` is what takes it to the
 * doors afterwards. Null when it could not be written, which the caller reports the old way.
 */
export async function openFailureGroup(
  executor: Executor,
  input: {
    userId: string;
    botId: string;
    channelId?: string | undefined;
    run: RunFailureFacts;
    signature: FailureSignature;
    runId?: string | null | undefined;
    at: Date;
  },
): Promise<string | null> {
  const id = randomUUID();
  const at = input.at.toISOString();
  const facts: FailureGroupFacts = {
    scope: input.signature.scope,
    target: input.signature.target,
    count: 1,
    firstAt: at,
    lastAt: at,
    ...(input.runId ? { runId: input.runId } : {}),
  };
  try {
    await executor.transaction(async (savepoint) => {
      await savepoint.insert(lafNotifications).values({
        id,
        kind: "run.failed",
        botId: input.botId,
        userId: input.userId,
        ...(input.channelId ? { channelId: input.channelId } : {}),
        subject: { kind: "run", ...input.run, group: facts },
        createdAt: input.at,
      });
    });
    return id;
  } catch (error) {
    log.error("failure_group_not_opened", {
      scope: input.signature.scope,
      reason: describeFailure(error),
    });
    return null;
  }
}

/**
 * A success: every open group of this scope is closed, so the next failure is news again.
 *
 * Addressed to the person the groups were addressed to. A routine with no author has none left —
 * the account's rows went with it — and nothing to close.
 */
export async function closeFailureGroups(
  executor: Executor,
  input: { userId: string | null; scope: string; at: Date },
): Promise<number> {
  if (!input.userId) return 0;
  const userId = input.userId;
  try {
    return await executor.transaction(async (savepoint) => {
      await savepoint.execute(lockScope(input.scope));
      const closed = await savepoint
        .update(lafNotifications)
        .set({
          subject: withGroupFields(
            sql`jsonb_build_object('closedAt', ${input.at.toISOString()}::text)`,
          ),
        })
        .where(
          and(
            eq(lafNotifications.kind, "run.failed"),
            eq(lafNotifications.userId, userId),
            sql`${groupColumn} ->> 'scope' = ${input.scope}`,
            sql`${groupColumn} ->> 'closedAt' is null`,
          ),
        )
        .returning({ id: lafNotifications.id });
      return closed.length;
    });
  } catch (error) {
    log.error("failure_groups_not_closed", {
      scope: input.scope,
      reason: describeFailure(error),
    });
    return 0;
  }
}

/**
 * The person said 확인: the group goes quiet, and its notification is no longer waiting for them.
 *
 * Idempotent, so a second press — two tabs, a double click — answers the same as the first rather
 * than a 404 that would draw as something having gone wrong. The first acknowledgement's time is
 * kept. Only their own rows, and only rows that are groups.
 */
export async function acknowledgeFailureGroup(
  database: Pick<Database, "update">,
  input: { userId: string; id: string; at: Date },
): Promise<boolean> {
  const acknowledged = await database
    .update(lafNotifications)
    .set({
      seenAt: sql`coalesce(${lafNotifications.seenAt}, ${input.at})`,
      subject: withGroupFields(
        sql`jsonb_build_object('acknowledgedAt', coalesce(${groupColumn} ->> 'acknowledgedAt', ${input.at.toISOString()}::text))`,
      ),
    })
    .where(
      and(
        eq(lafNotifications.id, input.id),
        eq(lafNotifications.userId, input.userId),
        eq(lafNotifications.kind, "run.failed"),
        sql`${groupColumn} is not null`,
      ),
    )
    .returning({ id: lafNotifications.id });
  return acknowledged.length > 0;
}

/**
 * The groups whose mark is one of these runs, keyed by run.
 *
 * What the transcript's failure line reads to say how many times, and when last. One query for a
 * page of failures; the run ids are the ledger's own and unique, so no person or thread is needed to
 * tell whose they are — the route already checked that the thread is the caller's.
 */
export async function failureGroupsMarkedAt(
  database: Pick<Database, "select">,
  runIds: readonly string[],
): Promise<Map<string, FailureGroupMark>> {
  const marks = new Map<string, FailureGroupMark>();
  if (runIds.length === 0) return marks;
  const rows = await database
    .select({ id: lafNotifications.id, subject: lafNotifications.subject })
    .from(lafNotifications)
    .where(
      and(
        eq(lafNotifications.kind, "run.failed"),
        inArray(sql`(${groupColumn} ->> 'runId')`, [...runIds]),
      ),
    );
  for (const row of rows) {
    const facts = groupFactsOf(row.subject);
    if (!facts.runId) continue;
    marks.set(facts.runId, {
      id: row.id,
      count: numberOf(facts.count, 1),
      lastAt: facts.lastAt ?? facts.firstAt ?? "",
      acknowledged: Boolean(facts.acknowledgedAt),
      closed: Boolean(facts.closedAt),
    });
  }
  return marks;
}
