import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  HUB_BUDGET_FACTS,
  HUB_BUDGET_LIMITS,
  HUB_BUDGET_RESERVATION_MS,
  HUB_BUDGET_SEAT_DAILY_USD,
  HUB_BUDGET_SWEEP_MS,
  HUB_BUDGET_TIME_ZONE,
  HUB_FACTS,
  HUB_HEADERS,
  type HubBudget,
  type HubBudgetEntry,
  type HubBudgetEntryState,
  type HubBudgetLine,
  type HubBudgetReached,
  type HubBudgetScope,
} from "../../shared/hub/protocol";
import type { Logger } from "../../shared/log";
import { recordAudit } from "./audit";
import type { AuthedMember, MemberVariables } from "./auth";
import type { HubDatabase, HubTransaction } from "./db/client";
import {
  hubBudgetEntries,
  hubBudgetLimits,
  hubJobs,
  hubMembers,
  hubTasks,
} from "./db/schema";
import { emitEvent, type Listeners } from "./events";
import type { Answer } from "./idempotency";
import { visibleTo } from "./visibility";

/**
 * The budget ledger: a reservation before a run starts, its actual cost after, against a daily
 * limit per scope (`shared/hub/protocol.ts`, "THE BUDGET LEDGER").
 *
 * THE LAST DOLLAR GOES TO ONE RUN. Every reservation reads what its scopes have used today and
 * inserts its own row — two statements, and between them another VM's reservation could read the
 * same total and both would fit. So every reservation and every settle takes one transaction-scoped
 * advisory lock first (`BUDGET_LOCK`). The second VM waits for the first to commit; under READ
 * COMMITTED its next statement reads afresh, sees the first's row, and is refused if the day no
 * longer has room. One lock rather than one per scope: the workspace is in every reservation, so a
 * lock per scope would serialize on the workspace's anyway, and with one there is no order of
 * taking two locks to get wrong. A reservation is a few small reads and one insert; a company's
 * runs start at people's pace.
 *
 * WHAT COUNTS. A row counts `actual` once settled and `reserved` otherwise. A reservation older
 * than `HUB_BUDGET_RESERVATION_MS` is marked expired by the sweep and still counts at the amount
 * reserved: its VM went quiet, but it may have spent that money before it did, and its settle
 * comes through an outbox that outlives the network being down. Releasing it instead would let a
 * day go over by every run whose VM died mid-turn; keeping it costs at most one reservation's
 * worth of a day for a run that in fact spent nothing, until midnight.
 *
 * THE HUB SEES TWO NUMBERS. The trail and the table hold a run id, scope names and dollars —
 * never what the run was asked or did.
 */

/**
 * One key for every budget write. Arbitrary, fixed, and used for nothing else — the hub's other
 * keys are 7_200_001 (events), 7_200_002 (skills), 7_200_003 (memory) and 7_200_010 (the files'
 * quota). Two features on one key would make every skill write wait on every reservation.
 */
const BUDGET_LOCK = 7_200_004;

const RUN_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;
const SCOPE_SHAPE = /^(workspace|(job|task):[A-Za-z0-9_-]{1,80})$/;

export class Invalid extends Error {
  constructor(readonly field: string) {
    super(field);
  }
}

export const invalid = (field: string): Answer => ({
  status: 400,
  body: { ok: false, code: "laf:request_invalid", field },
});

export const forbidden: Answer = {
  status: 403,
  body: { ok: false, code: HUB_FACTS.forbidden },
};

export const notFound: Answer = {
  status: 404,
  body: { ok: false, code: HUB_FACTS.notFound },
};

export const isManager = (member: AuthedMember) =>
  member.role === "owner" || member.role === "admin";

export async function readJson(
  context: Context,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await context.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const limited = bodyLimit({
  maxSize: 64 * 1024,
  onError: (context) =>
    context.json({ ok: false, code: "laf:request_invalid" }, 413),
});

/**
 * Dollars as Postgres reads them: a finite number in range, written to six places. Every sum and
 * comparison is then `numeric`, so 0.2 five times is exactly 1.
 */
export function dollars(
  value: unknown,
  field: string,
  range: { min: number; max: number; zero: boolean },
): string {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Invalid(field);
  if (value < range.min || value > range.max) throw new Invalid(field);
  if (value === 0 && !range.zero) throw new Invalid(field);
  const written = value.toFixed(6);
  // Under half a microdollar `toFixed` writes zero, which every limit admits: a positive amount
  // is written as the smallest one instead, so a reservation meets the gate and a spend is counted.
  return value > 0 && Number(written) === 0 ? "0.000001" : written;
}

/** A `numeric` as the wire carries it. */
const usd = (value: string | null | undefined): number => Number(value ?? 0);

function runOf(value: unknown, header: string | undefined): string {
  const run = value ?? header;
  if (typeof run !== "string" || !RUN_SHAPE.test(run))
    throw new Invalid("runId");
  return run;
}

/** The scopes a reservation counts against: the workspace first and always, then as asked. */
function scopesOf(value: unknown): HubBudgetScope[] {
  if (value === undefined || value === null) return ["workspace"];
  if (!Array.isArray(value)) throw new Invalid("scopes");
  for (const scope of value) {
    if (typeof scope !== "string" || !SCOPE_SHAPE.test(scope))
      throw new Invalid("scopes");
  }
  const scopes = [
    ...new Set(["workspace", ...(value as string[])]),
  ] as HubBudgetScope[];
  if (scopes.length > HUB_BUDGET_LIMITS.scopes) throw new Invalid("scopes");
  return scopes;
}

/** `job:abc` → `["job", "abc"]`; the workspace's id is ''. */
function splitScope(scope: HubBudgetScope): [string, string] {
  if (scope === "workspace") return ["workspace", ""];
  const at = scope.indexOf(":");
  return [scope.slice(0, at), scope.slice(at + 1)];
}

const scopeName = (kind: string, id: string): HubBudgetScope =>
  (kind === "workspace" ? "workspace" : `${kind}:${id}`) as HubBudgetScope;

/** Today in Seoul, from the database's clock, never a VM's. */
const today = sql`(now() at time zone ${HUB_BUDGET_TIME_ZONE})::date`;

/** What a row counts against its scopes. */
const counted = sql`case when ${hubBudgetEntries.state} = 'settled' then ${hubBudgetEntries.actual} else ${hubBudgetEntries.reserved} end`;

type EntryRow = typeof hubBudgetEntries.$inferSelect;

function entryView(row: EntryRow): HubBudgetEntry {
  return {
    runId: row.runId,
    scopes: row.scopes as HubBudgetScope[],
    reserved: usd(row.reserved),
    actual: row.actual === null ? null : usd(row.actual),
    state: row.state as HubBudgetEntryState,
    day: row.day,
  };
}

async function entryOf(
  tx: HubTransaction,
  member: string,
  runId: string,
): Promise<EntryRow | undefined> {
  const [row] = await tx
    .select()
    .from(hubBudgetEntries)
    .where(
      and(
        eq(hubBudgetEntries.member, member),
        eq(hubBudgetEntries.runId, runId),
      ),
    )
    .for("update");
  return row;
}

/** The workspace's limit: an admin's, or the active seats × $0.6. */
async function workspaceLimit(
  database: HubDatabase | HubTransaction,
): Promise<{ limit: string; seats: number; set: boolean }> {
  const [row] = await database.execute<{
    set_usd: string | null;
    seats: number;
  }>(sql`
    select (select daily_usd::text from hub_budget_limits
             where scope_kind = 'workspace' and scope_id = '') as set_usd,
           (select count(*)::int from hub_members where state = 'active') as seats
  `);
  const seats = Number(row?.seats ?? 0);
  if (row?.set_usd != null) return { limit: row.set_usd, seats, set: true };
  // Multiplied in Postgres for the same reason the sums are: 3 × 0.6 is 1.8, not 1.7999….
  const [product] = await database.execute<{ limit: string }>(
    sql`select (${seats}::numeric * ${String(HUB_BUDGET_SEAT_DAILY_USD)}::numeric)::text as limit`,
  );
  return { limit: product?.limit ?? "0", seats, set: false };
}

/** Each scope's limit, or null where none is set (a job or task held only by the workspace's). */
async function limitsOf(
  database: HubDatabase | HubTransaction,
  scopes: HubBudgetScope[],
): Promise<Map<HubBudgetScope, string | null>> {
  const limits = new Map<HubBudgetScope, string | null>();
  for (const scope of scopes) limits.set(scope, null);
  const named = scopes.filter((scope) => scope !== "workspace");
  if (named.length > 0) {
    const rows = await database
      .select({
        kind: hubBudgetLimits.scopeKind,
        id: hubBudgetLimits.scopeId,
        usd: hubBudgetLimits.dailyUsd,
      })
      .from(hubBudgetLimits)
      .where(
        inArray(
          sql`${hubBudgetLimits.scopeKind} || ':' || ${hubBudgetLimits.scopeId}`,
          named,
        ),
      );
    for (const row of rows) limits.set(scopeName(row.kind, row.id), row.usd);
  }
  if (limits.has("workspace")) {
    limits.set("workspace", (await workspaceLimit(database)).limit);
  }
  return limits;
}

/**
 * Whether `amount` more fits in `scope` today, compared in `numeric`. Run under `BUDGET_LOCK`, so
 * the rows it sums are every reservation committed before this one.
 */
async function fits(
  tx: HubTransaction,
  scope: HubBudgetScope,
  limit: string,
  amount: string,
): Promise<boolean> {
  const [row] = await tx.execute<{ over: boolean }>(sql`
    select coalesce(sum(${counted}), 0) + ${amount}::numeric > ${limit}::numeric as over
      from ${hubBudgetEntries}
     where ${hubBudgetEntries.day} = ${today}
       and ${scope} = any(${hubBudgetEntries.scopes})
  `);
  return row?.over === false;
}

/** The active owners and admins. */
async function managers(tx: HubTransaction): Promise<string[]> {
  const rows = await tx
    .select({ id: hubMembers.id })
    .from(hubMembers)
    .where(
      and(
        eq(hubMembers.state, "active"),
        inArray(hubMembers.role, ["owner", "admin"]),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Says `budget.reached` for a scope once a day, and again after its limit changes: a VM that was
 * told stops starting runs, and telling it again on every refused run would be a line of events
 * per attempt.
 */
async function emitReached(
  tx: HubTransaction,
  scope: HubBudgetScope,
  member: string,
): Promise<boolean> {
  const [kind, id] = splitScope(scope);
  const [said] = await tx.execute<{ said: boolean }>(sql`
    select exists (
      select 1 from hub_events
       where type = 'budget.reached'
         and ref_id = ${scope}
         and at >= greatest(
           ${today}::timestamp at time zone ${HUB_BUDGET_TIME_ZONE},
           coalesce((select updated_at from hub_budget_limits
                      where scope_kind = ${kind} and scope_id = ${id}), '-infinity')
         )
    ) as said
  `);
  if (said?.said) return false;
  let audience: string[] | null = null;
  if (scope !== "workspace") {
    const people = new Set([...(await managers(tx)), member]);
    if (kind === "job") {
      const [job] = await tx
        .select({ owner: hubJobs.owner, runner: hubJobs.runner })
        .from(hubJobs)
        .where(eq(hubJobs.id, id));
      if (job) {
        people.add(job.owner);
        people.add(job.runner);
      }
    }
    audience = [...people];
  }
  await emitEvent(tx, {
    type: "budget.reached",
    refId: scope,
    actor: member,
    visibleTo: audience,
  });
  return true;
}

/**
 * The scopes this member may not count a run against: a job this member's VM does not run, a task
 * this member cannot see. Otherwise one member's runs could spend another's job or task down to
 * nothing, and the job's or task's own runs would then be refused for the rest of the day.
 */
async function scopesRefused(
  tx: HubTransaction,
  self: AuthedMember,
  scopes: HubBudgetScope[],
): Promise<HubBudgetScope[]> {
  const refused: HubBudgetScope[] = [];
  const jobs = scopes
    .filter((scope) => scope.startsWith("job:"))
    .map((scope) => scope.slice(4));
  if (jobs.length > 0) {
    const rows = await tx
      .select({ id: hubJobs.id })
      .from(hubJobs)
      .where(and(inArray(hubJobs.id, jobs), eq(hubJobs.runner, self.id)));
    const runs = new Set(rows.map((row) => row.id));
    for (const id of jobs) if (!runs.has(id)) refused.push(`job:${id}`);
  }
  const tasks = scopes
    .filter((scope) => scope.startsWith("task:"))
    .map((scope) => scope.slice(5));
  if (tasks.length > 0) {
    const rows = await tx
      .select({ id: hubTasks.id })
      .from(hubTasks)
      .where(
        and(
          inArray(hubTasks.id, tasks),
          visibleTo(hubTasks.visibility, self.id),
        ),
      );
    const seen = new Set(rows.map((row) => row.id));
    for (const id of tasks) if (!seen.has(id)) refused.push(`task:${id}`);
  }
  return refused;
}

/** A reservation naming a refused scope is refused whole: a job's 403 before a task's 404. */
async function scopesAllowed(
  tx: HubTransaction,
  self: AuthedMember,
  scopes: HubBudgetScope[],
): Promise<Answer | null> {
  const refused = await scopesRefused(tx, self, scopes);
  if (refused.some((scope) => scope.startsWith("job:"))) return forbidden;
  if (refused.length > 0) return notFound;
  return null;
}

export type ReserveInput = {
  runId: string;
  scopes: HubBudgetScope[];
  /** Dollars to six places (`dollars`). */
  amount: string;
};

/**
 * Sets `amount` aside for one run, or refuses with the first scope that has no room. The same run
 * asking again gets its reservation back rather than a second one.
 */
export async function reserve(
  tx: HubTransaction,
  self: AuthedMember,
  input: ReserveInput,
  emitted: () => void,
): Promise<Answer> {
  await tx.execute(sql`select pg_advisory_xact_lock(${BUDGET_LOCK})`);
  const existing = await entryOf(tx, self.id, input.runId);
  if (existing) {
    return {
      status: 200,
      body: { ok: true, entry: entryView(existing), replayed: true },
    };
  }
  const refusedScope = await scopesAllowed(tx, self, input.scopes);
  if (refusedScope) return refusedScope;
  const limits = await limitsOf(tx, input.scopes);
  for (const scope of input.scopes) {
    const limit = limits.get(scope);
    if (limit === null || limit === undefined) continue;
    if (await fits(tx, scope, limit, input.amount)) continue;
    if (await emitReached(tx, scope, self.id)) emitted();
    await recordAudit(tx, {
      action: "budget.reserved",
      member: self.id,
      vmOrigin: self.vmOrigin,
      target: scope,
      runId: input.runId,
      outcome: HUB_BUDGET_FACTS.reached,
      payload: { amount: usd(input.amount), scopes: input.scopes },
    });
    const body: HubBudgetReached = {
      ok: false,
      code: HUB_BUDGET_FACTS.reached,
      scope,
    };
    return { status: 409, body };
  }
  const [row] = await tx
    .insert(hubBudgetEntries)
    .values({
      member: self.id,
      runId: input.runId,
      scopes: input.scopes,
      reserved: input.amount,
      state: "reserved",
      day: sql`${today}`,
    })
    .returning();
  if (!row) throw new Error("hub_budget_entries insert returned nothing");
  await recordAudit(tx, {
    action: "budget.reserved",
    member: self.id,
    vmOrigin: self.vmOrigin,
    runId: input.runId,
    outcome: "ok",
    payload: { amount: usd(input.amount), scopes: input.scopes },
  });
  return { status: 200, body: { ok: true, entry: entryView(row) } };
}

export type SettleInput = {
  runId: string;
  /** Dollars to six places. */
  actual: string;
  /** Used only when the run was never reserved. */
  scopes: HubBudgetScope[];
};

/**
 * Writes what a run cost. Once: a settle sent again answers with the first and changes nothing. A
 * run never reserved (its reserve did not reach the hub) is still written, against the workspace
 * and the scopes the settle names, because the money was spent whether or not the hub was asked;
 * a ledger that refused it would be a ledger that is short. The scopes it names pass the same check
 * a reservation's do (`scopesRefused`): one this member may not name is left off the row, not the
 * whole settle refused — the run still counts against the workspace, and nobody's settle can spend
 * another member's job or task down to nothing.
 */
export async function settle(
  tx: HubTransaction,
  self: AuthedMember,
  input: SettleInput,
): Promise<Answer> {
  await tx.execute(sql`select pg_advisory_xact_lock(${BUDGET_LOCK})`);
  const existing = await entryOf(tx, self.id, input.runId);
  if (existing?.state === "settled") {
    return {
      status: 200,
      body: { ok: true, entry: entryView(existing), replayed: true },
    };
  }
  if (!existing) {
    const refused = await scopesRefused(tx, self, input.scopes);
    const scopes = input.scopes.filter((scope) => !refused.includes(scope));
    const [row] = await tx
      .insert(hubBudgetEntries)
      .values({
        member: self.id,
        runId: input.runId,
        scopes,
        reserved: "0",
        actual: input.actual,
        state: "settled",
        day: sql`${today}`,
        settledAt: sql`now()`,
      })
      .returning();
    if (!row) throw new Error("hub_budget_entries insert returned nothing");
    await recordAudit(tx, {
      action: "budget.settled",
      member: self.id,
      vmOrigin: self.vmOrigin,
      runId: input.runId,
      outcome: "unreserved",
      payload: {
        reserved: 0,
        actual: usd(input.actual),
        scopes,
        ...(refused.length > 0 ? { refused } : {}),
      },
    });
    return { status: 200, body: { ok: true, entry: entryView(row) } };
  }
  const [row] = await tx
    .update(hubBudgetEntries)
    .set({ state: "settled", actual: input.actual, settledAt: sql`now()` })
    .where(
      and(
        eq(hubBudgetEntries.member, self.id),
        eq(hubBudgetEntries.runId, input.runId),
      ),
    )
    .returning();
  if (!row) throw new Error("hub_budget_entries update returned nothing");
  await recordAudit(tx, {
    action: "budget.settled",
    member: self.id,
    vmOrigin: self.vmOrigin,
    runId: input.runId,
    // A settle after the sweep marked the reservation is late, not wrong: the outbox delivered it.
    outcome: existing.state === "expired" ? "late" : "ok",
    payload: { reserved: usd(existing.reserved), actual: usd(input.actual) },
  });
  return { status: 200, body: { ok: true, entry: entryView(row) } };
}

/** Today's spent and reserved, summed in Postgres, under `where`. */
const sums = sql`
  coalesce(sum(case when e.state = 'settled' then e.actual
                    when e.state = 'expired' then e.reserved
                    else 0 end), 0)::text as spent,
  coalesce(sum(case when e.state = 'reserved' then e.reserved else 0 end), 0)::text as reserved`;

/**
 * `GET /budget`: the workspace's total for everybody; every member and scope for an owner or admin;
 * only the asking member's own runs for anybody else — one member's spend is not another's to read.
 */
export async function budgetFor(
  database: HubDatabase,
  self: AuthedMember,
): Promise<HubBudget> {
  const mine: SQL = isManager(self) ? sql`true` : sql`e.member = ${self.id}`;
  const [day] = await database.execute<{ day: string }>(
    sql`select ${today}::text as day`,
  );
  const [total] = await database.execute<{ spent: string; reserved: string }>(
    sql`select ${sums} from hub_budget_entries e
         where e.day = ${today} and 'workspace' = any(e.scopes)`,
  );
  const members = await database.execute<{
    member: string;
    spent: string;
    reserved: string;
  }>(sql`
    select e.member, ${sums} from hub_budget_entries e
     where e.day = ${today} and 'workspace' = any(e.scopes) and ${mine}
     group by e.member order by e.member
  `);
  const scoped = await database.execute<{
    scope: HubBudgetScope;
    spent: string;
    reserved: string;
  }>(sql`
    select s.scope, ${sums}
      from hub_budget_entries e, unnest(e.scopes) as s(scope)
     where e.day = ${today} and s.scope <> 'workspace' and ${mine}
     group by s.scope order by s.scope
  `);
  const lines = new Map<HubBudgetScope, Omit<HubBudgetLine, "limit">>();
  for (const row of scoped) {
    lines.set(row.scope, {
      spent: usd(row.spent),
      reserved: usd(row.reserved),
    });
  }
  // An owner or admin sees every scope with a limit, spent or not; a member the ones they spent in.
  if (isManager(self)) {
    const rows = await database
      .select({ kind: hubBudgetLimits.scopeKind, id: hubBudgetLimits.scopeId })
      .from(hubBudgetLimits);
    for (const row of rows) {
      const scope = scopeName(row.kind, row.id);
      if (scope !== "workspace" && !lines.has(scope)) {
        lines.set(scope, { spent: 0, reserved: 0 });
      }
    }
  }
  const scopes = [...lines.keys()].sort();
  const limits = await limitsOf(database, scopes);
  const workspace = await workspaceLimit(database);
  return {
    ok: true,
    day: day?.day ?? "",
    workspace: {
      limit: usd(workspace.limit),
      seats: workspace.seats,
      spent: usd(total?.spent),
      reserved: usd(total?.reserved),
    },
    members: members.map((row) => ({
      member: row.member,
      spent: usd(row.spent),
      reserved: usd(row.reserved),
    })),
    scopes: scopes.map((scope) => {
      const limit = limits.get(scope);
      return {
        scope,
        limit: limit === null || limit === undefined ? null : usd(limit),
        ...(lines.get(scope) ?? { spent: 0, reserved: 0 }),
      };
    }),
  };
}

/** Sets (or, with null, clears) one scope's daily limit. Inside the caller's transaction. */
export async function setLimit(
  tx: HubTransaction,
  self: AuthedMember,
  scope: HubBudgetScope,
  dailyUsd: string | null,
): Promise<void> {
  const [kind, id] = splitScope(scope);
  if (dailyUsd === null) {
    await tx
      .delete(hubBudgetLimits)
      .where(
        and(
          eq(hubBudgetLimits.scopeKind, kind),
          eq(hubBudgetLimits.scopeId, id),
        ),
      );
  } else {
    await tx
      .insert(hubBudgetLimits)
      .values({ scopeKind: kind, scopeId: id, dailyUsd, updatedBy: self.id })
      .onConflictDoUpdate({
        target: [hubBudgetLimits.scopeKind, hubBudgetLimits.scopeId],
        set: { dailyUsd, updatedBy: self.id, updatedAt: sql`now()` },
      });
  }
  await recordAudit(tx, {
    action: "budget.limit_set",
    member: self.id,
    vmOrigin: self.vmOrigin,
    target: scope,
    outcome: "ok",
    payload: { dailyUsd: dailyUsd === null ? null : usd(dailyUsd) },
  });
}

/**
 * A write route's body: reads and checks the JSON before any transaction opens, so a refused field
 * writes nothing; then runs `work` in one transaction and pokes listeners after the commit, never
 * inside it.
 */
export function writer(database: HubDatabase, listeners: Listeners) {
  return async <T>(
    context: Context<{ Variables: MemberVariables }>,
    parse: (body: Record<string, unknown>) => T,
    work: (
      tx: HubTransaction,
      input: T,
      emitted: () => void,
    ) => Promise<Answer>,
  ) => {
    const body = await readJson(context);
    if (!body) return context.json(invalid("body").body as object, 400);
    let input: T;
    try {
      input = parse(body);
    } catch (error) {
      if (error instanceof Invalid)
        return context.json(invalid(error.field).body as object, 400);
      throw error;
    }
    let poke = false;
    let answer: Answer;
    try {
      answer = await database.transaction((tx) =>
        work(tx, input, () => {
          poke = true;
        }),
      );
    } catch (error) {
      // A field found wrong once the transaction had begun (a member who is not active) rolls the
      // whole write back: nothing it did before the check is left behind.
      if (error instanceof Invalid)
        return context.json(invalid(error.field).body as object, 400);
      throw error;
    }
    if (poke) listeners.pokeAll();
    return context.json(
      answer.body as Record<string, unknown>,
      answer.status as 200,
    );
  };
}

export type BudgetRouteOptions = {
  database: HubDatabase;
  listeners: Listeners;
  member: MiddlewareHandler<{ Variables: MemberVariables }>;
};

export function budgetRoutes(options: BudgetRouteOptions) {
  const { database, listeners } = options;
  const route = new Hono<{ Variables: MemberVariables }>();
  route.use(options.member);

  const write = writer(database, listeners);

  route.get("/", async (context) =>
    context.json(await budgetFor(database, context.get("member"))),
  );

  route.post("/reserve", limited, (context) =>
    write(
      context,
      (body): ReserveInput => ({
        runId: runOf(body.runId, context.req.header(HUB_HEADERS.run)),
        scopes: scopesOf(body.scopes),
        amount: dollars(body.amount, "amount", {
          min: 0,
          max: HUB_BUDGET_LIMITS.reserve,
          zero: false,
        }),
      }),
      (tx, input, emitted) =>
        reserve(tx, context.get("member"), input, emitted),
    ),
  );

  route.post("/settle", limited, (context) =>
    write(
      context,
      (body): SettleInput => ({
        runId: runOf(body.runId, context.req.header(HUB_HEADERS.run)),
        actual: dollars(body.actual, "actual", {
          min: 0,
          max: HUB_BUDGET_LIMITS.actual,
          zero: true,
        }),
        scopes: scopesOf(body.scopes),
      }),
      (tx, input) => settle(tx, context.get("member"), input),
    ),
  );

  /** `{ limits: [{ scope, dailyUsd }] }`, owners and admins only; `dailyUsd: null` clears one. */
  route.put("/limits", limited, (context) => {
    const self = context.get("member");
    if (!isManager(self))
      return context.json(forbidden.body as object, forbidden.status as 403);
    return write(
      context,
      (body) => {
        const limits = body.limits;
        if (
          !Array.isArray(limits) ||
          limits.length === 0 ||
          limits.length > HUB_BUDGET_LIMITS.limits
        )
          throw new Invalid("limits");
        const seen = new Set<string>();
        return limits.map((item: unknown) => {
          if (!item || typeof item !== "object") throw new Invalid("limits");
          const { scope, dailyUsd } = item as Record<string, unknown>;
          if (
            typeof scope !== "string" ||
            !SCOPE_SHAPE.test(scope) ||
            seen.has(scope)
          )
            throw new Invalid("limits.scope");
          seen.add(scope);
          return {
            scope: scope as HubBudgetScope,
            dailyUsd:
              dailyUsd === null
                ? null
                : dollars(dailyUsd, "limits.dailyUsd", {
                    min: 0,
                    max: HUB_BUDGET_LIMITS.daily,
                    zero: true,
                  }),
          };
        });
      },
      async (tx, wanted) => {
        for (const { scope, dailyUsd } of wanted) {
          await setLimit(tx, self, scope, dailyUsd);
        }
        return { status: 200, body: { ok: true } };
      },
    );
  });

  return route;
}

/** How many reservations one sweep marks at most; the next minute takes the rest. */
const SWEEP_BATCH = 500;

/**
 * Marks the reservations nobody settled within `HUB_BUDGET_RESERVATION_MS` as expired. They keep
 * counting at the amount reserved (the comment at the top of this file says why); what changes is
 * that the ledger no longer shows them as runs still going, and a settle that arrives later is
 * written down as late. `skip locked`: a row a settle holds is being settled right now.
 */
export async function sweepExpiredReservations(
  database: HubDatabase,
): Promise<number> {
  return database.transaction(async (tx) => {
    const swept = await tx.execute<{
      member: string;
      run_id: string;
      reserved: string;
    }>(sql`
      with stale as (
        select member, run_id
          from hub_budget_entries
         where state = 'reserved'
           and reserved_at < now() - make_interval(secs => ${HUB_BUDGET_RESERVATION_MS / 1000})
         order by reserved_at
         limit ${SWEEP_BATCH}
           for update skip locked
      )
      update hub_budget_entries e
         set state = 'expired', expired_at = now()
        from stale s
       where e.member = s.member and e.run_id = s.run_id
      returning e.member, e.run_id, e.reserved::text as reserved
    `);
    for (const row of swept) {
      await recordAudit(tx, {
        action: "budget.expired",
        member: row.member,
        runId: row.run_id,
        outcome: "swept",
        payload: { reserved: usd(row.reserved) },
      });
    }
    return swept.length;
  });
}

/**
 * The sweep, every minute, in this process. Nothing escapes the timer, and a tick that finds the
 * last one running skips — the task sweep's rules, for the same reasons (`task-sweeper.ts`).
 */
export function startBudgetSweeper(input: {
  database: HubDatabase;
  log: Logger;
  everyMs?: number;
}): { stop(): void; sweep(): Promise<void> } {
  let running: Promise<void> | null = null;
  const sweep = (): Promise<void> => {
    if (running) return running;
    running = sweepExpiredReservations(input.database)
      .then((expired) => {
        if (expired > 0) input.log.info("budget_swept", { expired });
      })
      .catch((error: unknown) => {
        input.log.warn("budget_sweep_failed", { error });
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const tick = setInterval(() => {
    try {
      void sweep();
    } catch (error) {
      input.log.warn("budget_sweep_failed", { error });
    }
  }, input.everyMs ?? HUB_BUDGET_SWEEP_MS);
  return { stop: () => clearInterval(tick), sweep };
}
