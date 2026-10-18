/**
 * The hub's tables. Every name starts `hub_`, so a dump of a hub can never be mistaken for a
 * person's VM database, nor restored over one.
 *
 * The registry, the event log, the idempotency ledger, the trail, the task board, and the budget
 * ledger with the sub-Bot register and its one-time handoffs. Files,
 * skills, memory, rooms and the vault arrive with the changes that build them, each with its own
 * migration.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * The company, one row. `one` is how "one row" is a constraint and not a habit: it is true, and
 * unique, so a second insert is a conflict the upsert resolves rather than a second company.
 */
export const hubWorkspace = pgTable(
  "hub_workspace",
  {
    id: text("id").primaryKey(),
    one: boolean("one").notNull().default(true).unique(),
    name: text("name").notNull(),
    plan: text("plan"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("hub_workspace_one", sql`${table.one}`)],
);

/**
 * The members, as laf-control's registry pushes them. A member is a person and their one VM: the
 * pass that VM holds is the person (`shared/hub/protocol.ts`).
 *
 * `vm_key_hash` is the SHA-256 of that pass. The previous hash stays valid until
 * `prev_key_until`, for the requests already in flight when a pass is rotated; a member who left
 * holds neither.
 */
export const hubMembers = pgTable(
  "hub_members",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    role: text("role").notNull(),
    name: text("name"),
    vmOrigin: text("vm_origin").unique(),
    vmKeyHash: text("vm_key_hash").unique(),
    prevKeyHash: text("prev_key_hash"),
    prevKeyUntil: timestamp("prev_key_until", { withTimezone: true }),
    state: text("state").notNull().default("active"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "hub_members_role",
      sql`${table.role} in ('owner', 'admin', 'member')`,
    ),
    check("hub_members_state", sql`${table.state} in ('active', 'left')`),
    index("hub_members_prev_key_hash").on(table.prevKeyHash),
  ],
);

/**
 * Every change, numbered. `seq` survives a restart because it is the row's own sequence; what is
 * in memory (who is listening) is rebuilt by the VMs reconnecting.
 *
 * `visible_to` null is everybody; otherwise the member ids that may see the event at all. The
 * event carries only what changed and never the thing itself, but even "a task you cannot see
 * changed" says something, so it is filtered in the query, not after it.
 */
export const hubEvents = pgTable(
  "hub_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    refId: text("ref_id"),
    actor: text("actor").references(() => hubMembers.id),
    visibleTo: text("visible_to").array(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A refused reservation asks whether its scope's `budget.reached` was already said today
    // (`hub/src/budget.ts`); without this it would read the whole log to find out.
    index("hub_events_budget_reached")
      .on(table.refId, table.at)
      .where(sql`${table.type} = 'budget.reached'`),
  ],
);

/**
 * One answer per (member, key), kept a day: a write sent again with the same key gets this back
 * instead of being done twice. `member` is a member id, or `fleet` for the registry's own writes.
 */
export const hubIdempotency = pgTable(
  "hub_idempotency",
  {
    member: text("member").notNull(),
    key: text("key").notNull(),
    status: integer("status").notNull(),
    body: jsonb("body"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.member, table.key] }),
    index("hub_idempotency_at").on(table.at),
  ],
);

/**
 * What was done, by whom, from which VM and in which run — never the content. Append-only: the
 * migration puts a trigger in front of UPDATE, DELETE and TRUNCATE.
 */
export const hubAudit = pgTable(
  "hub_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    member: text("member"),
    vmOrigin: text("vm_origin"),
    action: text("action").notNull(),
    target: text("target"),
    runId: text("run_id"),
    outcome: text("outcome"),
    payload: jsonb("payload"),
  },
  (table) => [index("hub_audit_at").on(table.at)],
);

/**
 * The task board. A task is one piece of the company's work: who has it (`assignee`), where it
 * stands (`stage`), and — while a 라피 is working on it — which run holds it and until when.
 *
 * THE CLAIM IS THREE COLUMNS AND ONE UPDATE. `checkout_run_id`, `checkout_by` and
 * `lock_expires_at` are set together by a single conditional UPDATE (`hub/src/tasks.ts`), so two
 * runs asking at once cannot both be told yes: Postgres makes the second wait on the first's row
 * lock and then re-reads the row, which no longer matches. The claim runs out unless its run beats
 * (`HUB_TASK_LOCK_MS`), and the hub's sweep frees what ran out, so a VM that died mid-task does
 * not hold the task forever.
 *
 * `version` is what a person's edit is checked against: a board that read the task before a run
 * moved it is told so (`laf:task_stale`) instead of writing over what the run did.
 */
export const hubTasks = pgTable(
  "hub_tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    stage: text("stage").notNull().default("todo"),
    visibility: text("visibility").notNull().default("company"),
    assignee: text("assignee"),
    assignedBy: text("assigned_by").references(() => hubMembers.id),
    createdBy: text("created_by").references(() => hubMembers.id),
    checkoutRunId: text("checkout_run_id"),
    checkoutBy: text("checkout_by").references(() => hubMembers.id),
    lockExpiresAt: timestamp("lock_expires_at", { withTimezone: true }),
    /**
     * The member whose 라피 run moved it to `blocked`, while it stays there: who may say yes for it
     * (`POST /tasks/:id/approvals`), and the only one. Null for one a person blocked.
     */
    blockedBy: text("blocked_by").references(() => hubMembers.id),
    version: integer("version").notNull().default(1),
    rank: doublePrecision("rank").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    doneAt: timestamp("done_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "hub_tasks_stage",
      sql`${table.stage} in ('todo', 'doing', 'review', 'blocked', 'done')`,
    ),
    check(
      "hub_tasks_visibility",
      sql`${table.visibility} = 'company' or ${table.visibility} like 'me:_%' or ${table.visibility} like 'task:_%'`,
    ),
    check(
      "hub_tasks_assignee",
      sql`${table.assignee} is null or ${table.assignee} like 'm:_%' or ${table.assignee} like 'bot:_%' or ${table.assignee} like 'job:_%'`,
    ),
    // A claim is all three columns or none: a run id with no expiry would never be swept.
    check(
      "hub_tasks_checkout",
      sql`(${table.checkoutRunId} is null) = (${table.lockExpiresAt} is null) and (${table.checkoutRunId} is null) = (${table.checkoutBy} is null)`,
    ),
    index("hub_tasks_created").on(table.createdAt, table.id),
    // What the sweep reads every minute: only the claimed rows, by when they run out.
    index("hub_tasks_lock")
      .on(table.lockExpiresAt)
      .where(sql`${table.checkoutRunId} is not null`),
  ],
);

/**
 * A task's notes, oldest first. A 라피's note is one line of fact or link (`HUB_TASK_LIMITS`); what a
 * run met that a person has to allow is written as its topic only, never the values it saw.
 */
export const hubTaskNotes = pgTable(
  "hub_task_notes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => hubTasks.id, { onDelete: "cascade" }),
    by: text("by").notNull(),
    text: text("text").notNull(),
    runId: text("run_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("hub_task_notes_task").on(table.taskId, table.id)],
);

/**
 * Who is on a task. A task whose visibility is `task:<id>` is seen by these members, and so is
 * every file put under it. The same table the files change reads for `task:` visibility; whichever
 * of the two migrations runs second finds it made (`hub/drizzle/0001_hub_tasks.sql`).
 */
export const hubTaskMembers = pgTable(
  "hub_task_members",
  {
    taskId: text("task_id").notNull(),
    memberId: text("member_id")
      .notNull()
      .references(() => hubMembers.id),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.memberId] }),
    index("hub_task_members_member").on(table.memberId),
  ],
);

/**
 * A daily limit in dollars, per scope: the workspace (`scope_id` ''), a sub-Bot (`job`, its id) or a
 * task (`task`, its id). The workspace with no row is held to its seats × $0.6
 * (`HUB_BUDGET_SEAT_DAILY_USD`); a job or task with no row is held only by the workspace's.
 *
 * Dollars are `numeric`, never a float: five reservations of 0.2 against a limit of 1 must fit
 * exactly, and in binary floating point they add up to just over 1 and the fifth is refused.
 */
export const hubBudgetLimits = pgTable(
  "hub_budget_limits",
  {
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull().default(""),
    dailyUsd: numeric("daily_usd", { precision: 14, scale: 6 }).notNull(),
    updatedBy: text("updated_by").references(() => hubMembers.id),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.scopeKind, table.scopeId] }),
    check(
      "hub_budget_limits_kind",
      sql`${table.scopeKind} in ('workspace', 'job', 'task')`,
    ),
    check(
      "hub_budget_limits_id",
      sql`(${table.scopeKind} = 'workspace') = (${table.scopeId} = '')`,
    ),
    check("hub_budget_limits_usd", sql`${table.dailyUsd} >= 0`),
  ],
);

/**
 * One run's two numbers: what its VM set aside before it started (`reserved`) and what it cost
 * (`actual`, once settled). Keyed by the member and the VM's own run id, so a reserve or a settle
 * sent twice finds its row instead of writing a second.
 *
 * `scopes` are the ledger's scope names (`workspace`, `job:<id>`, `task:<id>`), the workspace always
 * among them. `day` is the Seoul calendar day the run counts against, fixed when the row is made, so
 * a settle that arrives after midnight lands on the day the money was set aside.
 *
 * What a row counts against its scopes: `actual` once settled, `reserved` otherwise — an expired
 * reservation included (`HUB_BUDGET_RESERVATION_MS` says why).
 */
export const hubBudgetEntries = pgTable(
  "hub_budget_entries",
  {
    member: text("member")
      .notNull()
      .references(() => hubMembers.id),
    runId: text("run_id").notNull(),
    scopes: text("scopes").array().notNull(),
    reserved: numeric("reserved", { precision: 14, scale: 6 }).notNull(),
    actual: numeric("actual", { precision: 14, scale: 6 }),
    state: text("state").notNull(),
    day: date("day").notNull(),
    reservedAt: timestamp("reserved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.member, table.runId] }),
    check(
      "hub_budget_entries_state",
      sql`${table.state} in ('reserved', 'settled', 'expired')`,
    ),
    check(
      "hub_budget_entries_settled",
      sql`(${table.state} = 'settled') = (${table.actual} is not null)`,
    ),
    check(
      "hub_budget_entries_amounts",
      sql`${table.reserved} >= 0 and (${table.actual} is null or ${table.actual} >= 0)`,
    ),
    // What a reservation and `GET /budget` read: one day's rows.
    index("hub_budget_entries_day").on(table.day),
    // What the sweep reads every minute: only the open reservations, oldest first.
    index("hub_budget_entries_open")
      .on(table.reservedAt)
      .where(sql`${table.state} = 'reserved'`),
  ],
);

/**
 * The sub-Bot register: a named, scheduled job on one member's VM. Who owns it, whose VM runs it,
 * when — and nothing it is told or finds; the prompt and the results stay on the VM. Its daily
 * limit is the ledger's (`hub_budget_limits`, kind `job`), not a column here, so there is one place
 * a reservation reads it from.
 */
export const hubJobs = pgTable(
  "hub_jobs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    owner: text("owner")
      .notNull()
      .references(() => hubMembers.id),
    runner: text("runner")
      .notNull()
      .references(() => hubMembers.id),
    schedule: text("schedule"),
    createdBy: text("created_by").references(() => hubMembers.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("hub_jobs_runner").on(table.runner)],
);

/**
 * A sub-Bot's definition on its way from the VM the job moved away from to the one it moved to: one
 * slot per job, made empty (`body` null) when the job moves and filled by the old runner's VM. The
 * register holds no content, and this is not part of it — it is taken and cleared by the new runner,
 * and the sweep drops one nobody came for after `expires_at`. `body` is kept as it came and never
 * read, logged or audited by the hub. Going with its job.
 */
export const hubJobHandoffs = pgTable(
  "hub_job_handoffs",
  {
    jobId: text("job_id")
      .primaryKey()
      .references(() => hubJobs.id, { onDelete: "cascade" }),
    fromMember: text("from_member")
      .notNull()
      .references(() => hubMembers.id),
    toMember: text("to_member")
      .notNull()
      .references(() => hubMembers.id),
    body: jsonb("body"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("hub_job_handoffs_expires").on(table.expiresAt)],
);
