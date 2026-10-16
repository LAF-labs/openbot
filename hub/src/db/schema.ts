/**
 * The hub's tables. Every name starts `hub_`, so a dump of a hub can never be mistaken for a
 * person's VM database, nor restored over one.
 *
 * The registry, the event log, the idempotency ledger and the trail (0000); the team rooms (0001);
 * the team's files and what search reads of them (0002); team skills and team memory (0003); the
 * task board (0004); the login vault (0005). Each later piece arrives with its own migration.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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
 * A group chat of the company's. Who may read it is who is in `hub_room_members`, and nobody
 * else — an admin included: a room is the people in it.
 *
 * `last_seq` is the room's own counter. A message takes its number by bumping it, which locks the
 * room's row until the post commits, so two posts to one room are numbered one after the other and
 * a reader paging by `seq` never meets a gap that fills in later (the reason `hub_events` takes a
 * lock, scoped to one room here).
 */
export const hubRooms = pgTable("hub_rooms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdBy: text("created_by").references(() => hubMembers.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
});

export const hubRoomMembers = pgTable(
  "hub_room_members",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => hubRooms.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => hubMembers.id),
    addedBy: text("added_by").references(() => hubMembers.id),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.memberId] }),
    // "Which rooms am I in" is the question every `GET /rooms` asks.
    index("hub_room_members_member").on(table.memberId),
  ],
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
 * of the two migrations runs second finds it made (`hub/drizzle/0004_hub_tasks.sql`).
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
 * One message, numbered within its room. `by` is `m:<member id>` for what a person wrote and
 * `bot:<member id>` for what that person's 라피 wrote, so a reader can tell the two apart without
 * a second table. `mentions` holds member ids and `lafi`; `files` holds hub file ids.
 */
export const hubMessages = pgTable(
  "hub_messages",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => hubRooms.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    by: text("by").notNull(),
    text: text("text").notNull(),
    mentions: text("mentions").array().notNull().default(sql`'{}'::text[]`),
    runId: text("run_id"),
    files: text("files").array().notNull().default(sql`'{}'::text[]`),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.seq] }),
    check("hub_messages_by", sql`${table.by} ~ '^(m|bot):.+$'`),
  ],
);

/**
 * The bytes, once per content: a file's versions point here by SHA-256, and the bytes live on the
 * hub's volume at `<HUB_FILES_DIR>/ab/cd/<sha256>`. Two members uploading the same file make one
 * blob. `refs` counts the versions of files not deleted that point here; a blob at 0 is what a
 * later sweep removes. `mirrored_at` is for the copy to the bucket, which a later change makes.
 */
export const hubBlobs = pgTable("hub_blobs", {
  sha256: text("sha256").primaryKey(),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
  refs: integer("refs").notNull().default(0),
  storedAt: timestamp("stored_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  mirroredAt: timestamp("mirrored_at", { withTimezone: true }),
});

/**
 * A team file: where it sits, who may see it, and which version is its newest. Deleting sets
 * `deleted_at`; from then on no query a member can reach returns it.
 */
export const hubFiles = pgTable(
  "hub_files",
  {
    id: text("id").primaryKey(),
    folder: text("folder").notNull().default("/"),
    name: text("name").notNull(),
    visibility: text("visibility").notNull().default("company"),
    /** The task of a `task:<id>` file, for ranking a run's own task first. */
    taskId: text("task_id"),
    version: integer("version").notNull().default(0),
    createdBy: text("created_by").references(() => hubMembers.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "hub_files_visibility",
      sql`${table.visibility} = 'company' or ${table.visibility} like 'me:_%' or ${table.visibility} like 'task:_%'`,
    ),
    index("hub_files_folder_name").on(table.folder, table.name, table.id),
  ],
);

/** Every version of a file: who wrote it, its bytes, and the words the uploading VM read out. */
export const hubFileVersions = pgTable(
  "hub_file_versions",
  {
    id: text("id").primaryKey(),
    fileId: text("file_id")
      .notNull()
      .references(() => hubFiles.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    sha256: text("sha256")
      .notNull()
      .references(() => hubBlobs.sha256),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    mime: text("mime"),
    text: text("text"),
    textChars: integer("text_chars"),
    by: text("by").references(() => hubMembers.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("hub_file_versions_file_version").on(table.fileId, table.version),
  ],
);

/**
 * What search reads: a file's newest text cut into overlapping pieces, each carrying its source's
 * visibility so the permission is decided in the same query as the match. `source_kind` is `file`
 * now; skills, tasks, rooms and memory add theirs. A new version replaces its file's chunks in
 * the transaction that writes it, and a deleted file's go with it — there is nothing to sweep.
 *
 * The trigram index is the migration's (0002), as the product's 0065 is: an operator class and
 * its statistics target are not drizzle's to describe.
 */
export const hubChunks = pgTable(
  "hub_chunks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    title: text("title"),
    visibility: text("visibility").notNull(),
    taskId: text("task_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  // By source id alone, never led by `source_kind`: with no statistics on a young table the planner
  // took an index on `source_kind = 'file'` — every row — over the trigram index, and a search
  // for a rare word read all 10,000 chunks (measured: 88 ms where the trigram index takes 1 ms).
  // Ids are unique across kinds (`f_…`), so the id finds a source's chunks by itself.
  (table) => [index("hub_chunks_source").on(table.sourceId, table.ordinal)],
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
