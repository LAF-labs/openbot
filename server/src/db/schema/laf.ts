import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Durable conversation history, kept here instead of in CopilotKit Intelligence.
 *
 * This fork's rule is that the only external dependencies are the model API and the
 * machines it runs on, so the thing Intelligence held — what was said in every thread —
 * lives in the same Postgres as everything else. One row per thread, the whole message
 * list as it stood after the last completed run. A snapshot rather than an append-only
 * log because AG-UI carries the full conversation into every run anyway; the log of
 * record for *actions* is `audit_events`, not this table.
 */
export const lafThreadSnapshots = pgTable("laf_thread_snapshots", {
  threadId: text("thread_id").primaryKey(),
  /** The agent the thread belongs to, when the run said so. */
  agentId: text("agent_id"),
  /** AG-UI `Message[]`, verbatim. */
  messages: jsonb("messages").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * One row per run: when it started, how it ended, and how big it was.
 *
 * Deliberately not the full event stream — a streaming turn can be arbitrarily large and
 * the messages already land in the snapshot. This is the skeleton the real Run ledger
 * (states like `claimed` and `unknown`, budgets, approvals) will grow on; until then it
 * answers the operational question a restart raises: which runs never finished.
 */
export const lafThreadRuns = pgTable("laf_thread_runs", {
  runId: text("run_id").primaryKey(),
  threadId: text("thread_id").notNull(),
  agentId: text("agent_id"),
  /** `running` | `done` | `error` — a run found `running` after a restart is a crash. */
  status: text("status").notNull(),
  error: text("error"),
  eventCount: integer("event_count").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
