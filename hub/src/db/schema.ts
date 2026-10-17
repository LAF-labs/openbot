/**
 * The hub's tables. Every name starts `hub_`, so a dump of a hub can never be mistaken for a
 * person's VM database, nor restored over one.
 *
 * Only what the registry, the event log, the idempotency ledger and the trail need. Files, skills,
 * memory, rooms, tasks and the vault arrive with the changes that build them, each with its own
 * migration.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
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
export const hubEvents = pgTable("hub_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  type: text("type").notNull(),
  refId: text("ref_id"),
  actor: text("actor").references(() => hubMembers.id),
  visibleTo: text("visible_to").array(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

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
