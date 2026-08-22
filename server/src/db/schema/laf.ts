import { sql } from "drizzle-orm";
import {
  boolean,
  index,
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
export const lafThreadRuns = pgTable(
  "laf_thread_runs",
  {
    runId: text("run_id").primaryKey(),
    /**
     * Nullable, because not every run belongs to a conversation.
     *
     * A routine firing at 6am is a run with no thread: nobody typed it, and its answer goes to the
     * routine's own history rather than into a transcript. It was `notNull` while chat was the only
     * writer, and that is exactly why scheduled work — the case where "is this Bot busy?" matters
     * most — had no in-flight record anywhere.
     */
    threadId: text("thread_id"),
    agentId: text("agent_id"),
    /**
     * Whose run it is, so "which of my Bots are working" is one indexed read.
     *
     * Nullable for runs that predate this column and for anything the system starts on nobody's
     * behalf; a run with no owner is simply invisible to the roster rather than visible to everyone.
     */
    userId: text("user_id"),
    /** What it is doing, in the person's own words where there are any — a routine's name. */
    label: text("label"),
    /**
     * `running` | `done` | `error` | `unknown`. A run still `running` when a new
     * process boots cannot still be running — this build is one process — so
     * boot reconciles it to `unknown`: the crash suspect the digest names.
     */
    status: text("status").notNull(),
    /** What started it: `chat` for a person's turn, `wake` for the watcher. */
    origin: text("origin").notNull().default("chat"),
    /**
     * Machine-initiated runs carry one; a second run with the same key must not
     * happen. Webhook redeliveries and watcher re-polls are the reason — a
     * duplicate wake that sends a message twice is the bug this column exists
     * to make impossible. Null for human turns: a person repeating themselves
     * is not a duplicate.
     */
    dedupeKey: text("dedupe_key").unique(),
    error: text("error"),
    eventCount: integer("event_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    /*
     * The roster asks "what is running for me" on a timer, so it gets an index rather than a scan
     * of every run this deployment has ever recorded. Partial on the one status that is ever
     * queried: finished runs outnumber live ones by orders of magnitude within a day, and there is
     * no question anybody asks that wants them in this index.
     */
    index("laf_thread_runs_live_idx")
      .on(table.userId, table.startedAt)
      .where(sql`${table.status} = 'running'`),
  ],
);

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

/**
 * A routine: one instruction, one Bot, run on a clock instead of on a keystroke.
 *
 * The Grok Bot field review (2026-08) put routines as the one capability their community leans on
 * that this product lacked. Ours is a sentence, deliberately: "check the smartstore reviews and
 * summarize the new ones" is a routine somebody can write, read back, and edit, where a recorded
 * screen session is a routine only its recorder understands. The Bot runs it server-side with no
 * tools in the room (coworker-call.ts), so a routine can think and write, and cannot yet click —
 * the browser-driving version arrives when tool execution moves off the browser (pivot P2).
 *
 * `nextRunAt` is the whole scheduler. A tick claims a due routine by advancing `nextRunAt` in one
 * conditional UPDATE, so two server processes ticking over the same table cannot both run it: one
 * moves the clock and wins, the other finds nothing due. The claim happens before the run, which
 * means a crash mid-run costs one execution rather than repeating one — for a digest, the right
 * side to fail on.
 *
 * The creator is snapshotted (`createdById`, `createdByRole`) because the run needs an actor long
 * after the request that made the routine is gone: the Bot roster is loaded with the creator's own
 * visibility, so a routine cannot see a private coworker its author could not.
 */
export const lafRoutines = pgTable("laf_routines", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  name: text("name").notNull(),
  /** What to do, in words. Sent to the Bot verbatim as the run's one user message. */
  instruction: text("instruction").notNull(),
  /** `interval` runs every N minutes; `daily` runs once a day at `dailyUtc`. */
  scheduleKind: text("schedule_kind").notNull(),
  intervalMinutes: integer("interval_minutes"),
  /** "HH:MM", UTC. Stored as text because it is a time-of-day, not a moment. */
  dailyUtc: text("daily_utc"),
  /**
   * The zone the daily time is written in, IANA. Null means the row predates zones and is UTC.
   *
   * Stored as the zone rather than as a fixed offset because an offset is wrong twice a year
   * wherever daylight saving exists: "every weekday at 9am" has to stay 9am, not drift to 8.
   */
  dailyTimeZone: text("daily_time_zone"),
  /**
   * Which weekdays it may run on, 0 = Sunday. Empty or null means every day.
   *
   * The reason a shop owner needs this is not tidiness: without it, "Monday morning open-up
   * checklist" also fires on Sunday, and a routine that cries wolf on a day off gets switched off.
   */
  dailyDays: integer("daily_days").array(),
  enabled: boolean("enabled").notNull().default(true),
  createdById: text("created_by_id").notNull(),
  createdByRole: text("created_by_role").notNull(),
  /**
   * SHA-256 of the trigger token, for the webhook path.
   *
   * The token itself is shown once, at creation, and kept nowhere: a webhook URL is a capability,
   * and a table that holds capabilities in the clear is a table one SELECT away from handing out
   * every routine in the deployment. Hashing costs one line and removes the shelf.
   */
  triggerTokenHash: text("trigger_token_hash"),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * What happened the last twenty times a routine ran.
 *
 * Twenty, pruned on write, matching what an operator actually reads: "is it working, and what did
 * it say this morning". The full history of record is `audit_events` — every run files a
 * `routine.ran` row there — so pruning here loses convenience, never evidence.
 */
export const lafRoutineRuns = pgTable("laf_routine_runs", {
  id: text("id").primaryKey(),
  routineId: text("routine_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  ok: boolean("ok"),
  /** The Bot's answer, which for a digest-shaped routine IS the product. */
  answer: text("answer"),
  error: text("error"),
  /**
   * The turns the run took: how many, how long each, which tools each asked for and whether they
   * went through. An operator reading "Failed: the Bot stopped before it finished" wants to know
   * how far it got; the answer alone cannot say. Null on rows written before this existed.
   */
  steps:
    jsonb("steps").$type<
      Array<{
        ms: number;
        text: number;
        calls: Array<{ name: string; ok: boolean }>;
      }>
    >(),
});
