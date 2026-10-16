/**
 * The hub's tables. Every name starts `hub_`, so a dump of a hub can never be mistaken for a
 * person's VM database, nor restored over one.
 *
 * Only what the registry, the event log, the idempotency ledger, the trail and the login vault need.
 * Files, skills, memory, rooms and tasks arrive with the changes that build them, each with its own
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
  uniqueIndex,
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

/**
 * A company login: what an admin stored once for the members to use. Nothing in it is a value.
 *
 * Sealed by the same envelope as a person's saved logins (`shared/login-seal.ts`): a key of the
 * row's own seals the name and the password, and that key is wrapped under the hub's
 * `HUB_KEY_ENCRYPTION_KEY`, which is not in this database. `kek_id` says which hub key wrapped it.
 */
export const hubVaultLogins = pgTable("hub_vault_logins", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  site: text("site"),
  origins: text("origins").array().notNull(),
  wrappedKey: text("wrapped_key").notNull(),
  kekId: text("kek_id").notNull(),
  sealedUsername: text("sealed_username").notNull(),
  sealedPassword: text("sealed_password").notNull(),
  concurrent: boolean("concurrent").notNull().default(false),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  changedBy: text("changed_by"),
  changedAt: timestamp("changed_at", { withTimezone: true }),
});

/** Who may use a login. Dropped with the login, and with the member's leaving (`fleet.ts`). */
export const hubVaultGrants = pgTable(
  "hub_vault_grants",
  {
    loginId: text("login_id")
      .notNull()
      .references(() => hubVaultLogins.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => hubMembers.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.loginId, table.memberId] }),
    index("hub_vault_grants_member").on(table.memberId),
  ],
);

/**
 * A VM's hold on a login. `id` is the SHA-256 of the lease the VM was given, so the table never
 * holds a lease that opens anything. `opened_at` is set by the one `open` a lease allows.
 *
 * At most one exclusive lease per login, held in the lease route under the login row's lock; the
 * partial unique index is the floor under that. A concurrent login's leases are not exclusive and
 * any number of VMs hold one at once.
 */
export const hubVaultLeases = pgTable(
  "hub_vault_leases",
  {
    id: text("id").primaryKey(),
    loginId: text("login_id")
      .notNull()
      .references(() => hubVaultLogins.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => hubMembers.id, { onDelete: "cascade" }),
    vmOrigin: text("vm_origin"),
    runId: text("run_id"),
    origin: text("origin").notNull(),
    exclusive: boolean("exclusive").notNull(),
    until: timestamp("until", { withTimezone: true }).notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("hub_vault_leases_login").on(table.loginId),
    uniqueIndex("hub_vault_leases_one_exclusive")
      .on(table.loginId)
      .where(sql`${table.exclusive}`),
  ],
);

/** The VMs that verified themselves as a device on a login's site: "인증된 VM 3/5". */
export const hubVaultDevices = pgTable(
  "hub_vault_devices",
  {
    loginId: text("login_id")
      .notNull()
      .references(() => hubVaultLogins.id, { onDelete: "cascade" }),
    vmOrigin: text("vm_origin").notNull(),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.loginId, table.vmOrigin] })],
);
