/**
 * The hub's tables. Every name starts `hub_`, so a dump of a hub can never be mistaken for a
 * person's VM database, nor restored over one.
 *
 * The registry, the event log, the idempotency ledger and the trail came first (0000); team skills
 * and team memory with the change that built them (0001). Files, rooms, tasks and the vault arrive
 * with the changes that build them, each with its own migration.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
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
  /**
   * The collection's version after this change (`hub_versions`), on `skill.changed` and
   * `memory.changed`; null on the rest. A VM holding that version already has nothing to fetch.
   */
  version: bigint("version", { mode: "number" }),
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

/**
 * One number per collection a VM caches — `skills`, `memory` — raised in the transaction that
 * changes what that collection answers. `/me` reports them, and the change's event carries the new
 * one, so a VM that missed nothing compares one number instead of fetching the list again.
 */
export const hubVersions = pgTable(
  "hub_versions",
  {
    kind: text("kind").primaryKey(),
    version: bigint("version", { mode: "number" }).notNull(),
  },
  (table) => [
    check("hub_versions_kind", sql`${table.kind} in ('skills', 'memory')`),
  ],
);

/**
 * The company's taught skills: how-to instructions every member's Bot can read. The slug follows the
 * VM's own rule (`shared/tools/skills.ts`), so a team skill is called the way a person's is.
 *
 * `profile`, `shipped_version` and `shipped_hash` are an industry pack's: which pack put the skill
 * here, which release of it, and the SHA-256 of the instructions as shipped. A row whose
 * instructions no longer hash to `shipped_hash` is one the team has edited, which a later release
 * must not silently overwrite. Null on a skill the team wrote itself.
 *
 * TODO(hub_chunks): index title, summary and instructions for search once the files change
 * (`laf/hub-files`) has created `hub_chunks`; this change does not create that table.
 */
export const hubSkills = pgTable("hub_skills", {
  slug: text("slug").primaryKey(),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  instructions: text("instructions").notNull(),
  version: integer("version").notNull().default(1),
  createdBy: text("created_by").references(() => hubMembers.id),
  updatedBy: text("updated_by").references(() => hubMembers.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  profile: text("profile"),
  shippedVersion: text("shipped_version"),
  shippedHash: text("shipped_hash"),
});

/**
 * Team memory: short facts that enter every member's prompt — but only once an admin has confirmed
 * them. Anyone's Bot may propose a line; a proposal is read by nobody's Bot.
 *
 * A line is never deleted. `retired` is an admin saying it is wrong, and the same words proposed
 * again are refused. `pushed_out_at` is the team's 1,500 characters running out: the oldest
 * confirmed lines stop being carried, and stay here, confirmed, for the record.
 *
 * `evidence` is where the proposing Bot learned it — `{ kind, id, excerpt }`, the excerpt at most
 * 200 characters — so the admin confirming it can see what it rests on.
 */
export const hubMemory = pgTable(
  "hub_memory",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    /** `content` with its whitespace collapsed, NFC: what "the same words" is compared on. */
    flat: text("flat").notNull(),
    state: text("state").notNull().default("proposed"),
    proposedBy: text("proposed_by")
      .notNull()
      .references(() => hubMembers.id),
    proposedRun: text("proposed_run"),
    proposedAt: timestamp("proposed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    evidence: jsonb("evidence").notNull(),
    confirmedBy: text("confirmed_by").references(() => hubMembers.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    retiredBy: text("retired_by").references(() => hubMembers.id),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    pushedOutAt: timestamp("pushed_out_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "hub_memory_state",
      sql`${table.state} in ('proposed', 'confirmed', 'retired')`,
    ),
    check("hub_memory_content", sql`char_length(${table.content}) <= 400`),
    index("hub_memory_state_flat").on(table.state, table.flat),
  ],
);
