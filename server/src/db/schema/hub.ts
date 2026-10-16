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
// NOT drizzle's `jsonb`; see ./json.ts.
import { jsonb } from "./json";

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
