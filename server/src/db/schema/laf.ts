import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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

/**
 * What the watcher polls: a `laf.watch` endpoint and how often.
 *
 * The watcher is pure code by design — the cost rule of an always-on product is that
 * nothing wakes a model on a schedule. A source is polled, its signals are normalized
 * and diffed against `lastSignals`, and only a *transition* becomes an event (and, when
 * `wakeAgentId` is set, a run). A value wobbling inside the same status is not news.
 */
export const lafWatchSources = pgTable("laf_watch_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** `http` fetches the URL and expects `{signals:[…]}`; `mcp` calls the `laf.watch` tool. */
  kind: text("kind").notNull(),
  url: text("url").notNull(),
  intervalSeconds: integer("interval_seconds").notNull().default(60),
  enabled: boolean("enabled").notNull().default(true),
  /** When set, a detected change also runs this agent with a change report. */
  wakeAgentId: text("wake_agent_id"),
  /** Normalized signal list from the last poll — the diff's left-hand side. */
  lastSignals: jsonb("last_signals"),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** One row per signal transition — what the digest reads and the wake delivers. */
export const lafWatchEvents = pgTable("laf_watch_events", {
  id: text("id").primaryKey(),
  sourceId: text("source_id")
    .notNull()
    .references(() => lafWatchSources.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  /** Null when the signal appeared for the first time. */
  prevStatus: text("prev_status"),
  /** Null when the signal disappeared. */
  nextStatus: text("next_status"),
  detail: text("detail"),
  observedAt: timestamp("observed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Set when a wake run carried this event to a bot. */
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
});

/**
 * One row per digest actually composed — the "we were watching" receipt.
 *
 * `forDate` is the day in the deployment's reporting timezone, and the pair
 * (forDate, ok) is what the scheduler checks so a restart at 09:00 does not
 * send a second morning card. The body is kept because a digest is a claim
 * about what happened overnight; a claim you cannot re-read is not evidence.
 */
export const lafDigestLog = pgTable("laf_digest_log", {
  id: text("id").primaryKey(),
  forDate: text("for_date").notNull(),
  channel: text("channel").notNull(),
  ok: boolean("ok").notNull(),
  error: text("error"),
  headline: text("headline").notNull(),
  body: text("body").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});
