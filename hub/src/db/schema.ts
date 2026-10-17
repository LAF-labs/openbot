/**
 * The hub's tables. Every name starts `hub_`, so a dump of a hub can never be mistaken for a
 * person's VM database, nor restored over one.
 *
 * The registry, the event log, the idempotency ledger and the trail (0000); the team's files and
 * what search reads of them (0001); team documents, their blocks and their snapshots (0002). Skills, memory, rooms, tasks and the vault arrive with the
 * changes that build them, each with its own migration.
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
  unique,
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
 * Who is on a task, for `task:<id>` visibility. Only the membership: the task itself (its title,
 * its stage, its notes) arrives with the change that builds tasks, which adds the foreign key. It
 * is here now because a file can already be a task's, and the rule that says who sees it
 * (`hub_visible_to`, migration 0001) has to read something that exists.
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
 * The trigram index is the migration's (0001), as the product's 0065 is: an operator class and
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
 * A team document: its title, where it sits, who may see it (the three values files take). Its
 * content is its blocks. `rev` counts accepted changes; every batch of block changes takes this row
 * `for update` first, so changes to one document are applied one batch at a time and a version or
 * hash checked in a batch cannot change under it. Deleting sets `deleted_at`.
 */
export const hubDocs = pgTable(
  "hub_docs",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    folder: text("folder").notNull().default("/"),
    visibility: text("visibility").notNull().default("company"),
    taskId: text("task_id"),
    rev: integer("rev").notNull().default(0),
    createdBy: text("created_by").references(() => hubMembers.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by").references(() => hubMembers.id),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "hub_docs_visibility",
      sql`${table.visibility} = 'company' or ${table.visibility} like 'me:_%' or ${table.visibility} like 'task:_%'`,
    ),
    index("hub_docs_updated").on(table.updatedAt, table.id),
  ],
);

/**
 * One block, one row. Ordered by `rank` (`src/docs/rank.ts`), compared byte by byte. `version`
 * counts content changes and `hash` digests the content (`src/docs/blocks.ts`), the two checks a
 * writer's change names. No unique index on (doc, rank): batches on one document are serialised by
 * its row, and a renumbering rewrites every rank in one statement, which a unique index would refuse
 * halfway through.
 */
export const hubDocBlocks = pgTable(
  "hub_doc_blocks",
  {
    docId: text("doc_id")
      .notNull()
      .references(() => hubDocs.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    rank: text("rank").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull().default(""),
    attrs: jsonb("attrs").notNull().default({}),
    version: integer("version").notNull().default(1),
    hash: text("hash").notNull(),
    updatedBy: text("updated_by").references(() => hubMembers.id),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.docId, table.id] }),
    check(
      "hub_doc_blocks_kind",
      sql`${table.kind} in ('paragraph', 'heading1', 'heading2', 'heading3', 'list', 'check', 'quote', 'code', 'divider', 'table', 'file', 'task-link')`,
    ),
  ],
);

/** A snapshot: the document's block list as it was when somebody saved a version, to look back at. */
export const hubDocVersions = pgTable(
  "hub_doc_versions",
  {
    docId: text("doc_id")
      .notNull()
      .references(() => hubDocs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    blocks: jsonb("blocks").notNull(),
    by: text("by").references(() => hubMembers.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.docId, table.version] })],
);
