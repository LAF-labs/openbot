import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { AskSubject } from "../../computer/approvals";
import { agents } from "./core";
// NOT drizzle's `jsonb`; see ./json.ts.
import { jsonb } from "./json";
import { lafRoutines } from "./laf";

/**
 * How far this VM has read the company hub's events (`server/src/hub/link.ts`). One row.
 *
 * In Postgres because it must outlive a restart: a VM that forgot its place would either replay the
 * hub's whole history at the next boot or, starting at the newest event, silently skip whatever
 * happened while it was down. `hub` is the origin the number belongs to — the numbers are one hub's
 * sequence, so a VM moved to another hub starts that hub's from its newest event instead of reading
 * the old hub's number as a place in the new one.
 */
export const hubCursor = pgTable(
  "hub_cursor",
  {
    /** Always true: the primary key that makes this table one row. */
    one: boolean("one").primaryKey().default(true),
    hub: text("hub").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("hub_cursor_one", sql`${table.one}`)],
);

/**
 * Writes to the company hub, kept here first and sent from here (`server/src/hub/outbox.ts`).
 *
 * A write is a row before it is a request, so a hub that is down, or a process that dies between
 * the two, loses nothing: the row is offered again every five minutes, at boot and when the hub
 * comes back. `id` is the `Idempotency-Key` every attempt carries, so the hub answers a repeat with
 * the first answer and never writes twice.
 *
 * Reads never come through here. A read that cannot be answered now is `laf:hub_unreachable` now.
 */
export const hubOutbox = pgTable(
  "hub_outbox",
  {
    id: text("id").primaryKey(),
    method: text("method").notNull(),
    /** Under `HUB_PREFIX`, e.g. `/rooms/r_1/messages`. */
    path: text("path").notNull(),
    body: jsonb("body"),
    /** `x-laf-origin`: chat, room, job or person. */
    origin: text("origin").notNull(),
    /** `x-laf-run`, when a run wrote it. */
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastTriedAt: timestamp("last_tried_at", { withTimezone: true }),
    /** The last failure's fact (`laf:hub_unreachable`, …), or null. */
    lastCode: text("last_code"),
    /** The hub took it. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /**
     * The hub answered and refused it (a 4xx). Never sent again: the same bytes get the same answer.
     */
    refusedAt: timestamp("refused_at", { withTimezone: true }),
    /** The status the hub answered with, once it answered. */
    status: integer("status"),
  },
  (table) => [
    index("hub_outbox_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.deliveredAt} is null and ${table.refusedAt} is null`),
  ],
);

/**
 * The last stop of a board task's run for a person's yes (`server/src/hub/task-asks.ts`): what kind
 * of action, where, and the rule and scope that stopped it — what "이 일감에서는 해도 돼" is an answer
 * to. One row per task, replaced by the task's next stop.
 *
 * In Postgres because the answer comes when the person next looks, which may be the next morning
 * and after a restart; and on the VM, because the approval is judged here and nowhere else — the
 * hub's board holds only the topic. The button's grant is made from this row, never from a request:
 * a body that named a rule or a scope could widen the boundary past what the person was shown.
 */
export const hubTaskAsks = pgTable("hub_task_asks", {
  /** The hub's task id. */
  taskId: text("task_id").primaryKey(),
  /** The run that stopped, as the ledger and the task's note name it. */
  runId: text("run_id").notNull(),
  /** Cascade: an allowance for a Bot that is gone has nobody to answer for. */
  botId: text("bot_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  /** The expression that asked; empty where a floor asked. */
  rule: text("rule").notNull(),
  scopeKind: text("scope_kind").notNull(),
  scopeValue: text("scope_value").notNull(),
  /** What the Bot was about to do, in facts — the subject an allowance keeps. */
  subject: jsonb("subject").$type<AskSubject>(),
  /** Kind of action and where (`computer/ask-topic.ts`): what the note said, what the yes covers. */
  topic: text("topic").notNull(),
  askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
  /** When the person answered, and who. Null while it waits. */
  grantedAt: timestamp("granted_at", { withTimezone: true }),
  grantedBy: text("granted_by"),
});

/**
 * Which routine on this VM is a sub-Bot on the company hub, and under which job id
 * (`server/src/hub/jobs.ts`). The hub's register holds the name, the two members and the schedule
 * line; what the routine is told stays here, in `laf_routines`.
 *
 * In Postgres because the job's own day is counted on every run (`job:<id>` on the ledger), and a
 * restart must not quietly run a sub-Bot as a plain routine. Cascade: a routine deleted here is no
 * sub-Bot of this VM's any more.
 */
export const hubJobRoutines = pgTable("hub_job_routines", {
  jobId: text("job_id").primaryKey(),
  routineId: text("routine_id")
    .notNull()
    .unique()
    .references(() => lafRoutines.id, { onDelete: "cascade" }),
  registeredAt: timestamp("registered_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
