import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
// NOT drizzle's `jsonb`: that one serialises and so does the driver, so a value written through it
// lands as a JSON *string* that no SQL operator can read. See ./json.ts.
import { jsonb } from "./json";

/**
 * Durable conversation history, kept here instead of in CopilotKit Intelligence.
 *
 * This fork's rule is that the only external dependencies are the model API and the machines it
 * runs on, so the thing Intelligence held — what was said in every thread — lives in the same
 * Postgres as everything else.
 *
 * ONE ROW PER MESSAGE, APPEND-ONLY. It was one row per thread holding the whole list, on the
 * reasoning that AG-UI carries the full conversation into every run anyway — and three writers grew
 * on it with two different disciplines. The runner rewrote the array from its own in-memory mirror
 * merged with the client's copy; the room and the routine delivery appended with `jsonb || jsonb`.
 * An append landing between the runner's read and its overwrite was gone, and the mirror the
 * overwrite was built from had to be glued back into step by hand after every append. A turn also
 * cost a rewrite of the whole conversation, and boot read every thread's full history into memory.
 *
 * `seq` is per thread and assigned under a per-thread advisory lock, so two transactions appending
 * at the same instant cannot claim one number or lose each other's message. `at` is when the row
 * was written; the transcript's own separators still come from the message's `lafAt` stamp, because
 * a row written by the 0026 backfill knows only when its snapshot was last saved and a separator
 * drawn from that would be a time this product invented. `run_id` is the run that produced it,
 * where one did — a routine delivery and a person's own message have none.
 *
 * There is no foreign key on `thread_id`: a thread is an id this deployment mints
 * (`channels/thread-identity.ts`), not a row.
 */
export const lafThreadMessages = pgTable(
  "laf_thread_messages",
  {
    threadId: text("thread_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    /** One AG-UI `Message`, plus the `lafAt`/`lafAgentId` stamps. See `runner/thread-store.ts`. */
    message: jsonb("message").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** The run that wrote it, when a run did. Null for a delivery and for a person's own message. */
    runId: text("run_id"),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.seq] }),
    /*
     * A message id appears at most once in a thread, enforced rather than hoped for.
     *
     * Every run hands the WHOLE history back as its input, so the append path sees each message
     * again on every turn; identity is what makes writing it twice impossible rather than merely
     * unlikely. It is also what lets a later, richer copy of the same message — an assistant turn
     * whose tool calls only arrive with the next run's input — update its row in place instead of
     * arriving as a second message.
     */
    uniqueIndex("laf_thread_messages_message_id_idx").on(
      table.threadId,
      sql`(${table.message} ->> 'id')`,
    ),
  ],
);

/** What started a run. A pg enum, so a client that invents one is refused rather than recorded. */
export const runOrigin = pgEnum("laf_run_origin", [
  "chat",
  "routine",
  "wake",
  "handoff",
  "room",
]);

/**
 * How a run ended, or that it has not.
 *
 * `unknown` is boot's verdict on a run whose process died mid-turn; `stopped` is a person pressing
 * Stop, which is not an error. Both existed as free text before this enum and both are written by
 * `runner/laf-runner.ts`; nothing writes any other value.
 */
export const runStatus = pgEnum("laf_run_status", [
  "running",
  "done",
  "error",
  "stopped",
  "unknown",
]);

/** `interval` runs every N minutes; `daily` runs once a day at `dailyLocal` in `dailyTimeZone`. */
export const routineScheduleKind = pgEnum("laf_routine_schedule_kind", [
  "interval",
  "daily",
]);

/**
 * One row per run: when it started, how it ended, and how big it was.
 *
 * Deliberately not the full event stream — a streaming turn can be arbitrarily large and
 * the messages already land in `laf_thread_messages`. This is the skeleton the real Run ledger
 * (states like `claimed` and `unknown`, budgets, approvals) will grow on; until then it
 * answers the operational question a restart raises: which runs never finished.
 *
 * Every row is written by `runner/run-ledger.ts` and by nothing else.
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
    /**
     * Which Bot ran, as a real reference at last.
     *
     * `set null` rather than `cascade`: this is the operational record of what the machine did, and
     * a Bot being torn out of the deployment does not un-happen the afternoon it worked. The column
     * was already nullable and the roster already ignores a run with no Bot (`runner/working.ts`),
     * so a hard-deleted Bot leaves history that reads as "somebody's, no longer named" rather than
     * a hole. Bots are soft-deleted in normal use (`agents/profile-store.ts`), so this fires only
     * on the hard-delete path, which nothing in `src` takes today.
     */
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
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
     * A run still `running` when a new process boots cannot still be running — this build is one
     * process — so boot reconciles it to `unknown`: the crash suspect the digest names.
     */
    status: runStatus("status").notNull(),
    /** What started it: `chat` for a person's turn, `routine` for one on a clock. */
    origin: runOrigin("origin").notNull().default("chat"),
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
    /*
     * And the same table read the other way: "what ran between these two times", which is what an
     * operator and the digest ask and what the partial index above deliberately cannot answer —
     * it holds only live runs. A seq scan of every run the deployment has recorded is fine on the
     * first day and is exactly the query that gets slower every day after it.
     */
    index("laf_thread_runs_started_at_idx").on(table.startedAt),
  ],
);

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
  /**
   * Cascade, because a routine with no Bot is not dormant — it is claimed on every tick.
   *
   * `agent_id` was plain text, so deleting a Bot left its routines `enabled`, due, and failing
   * with "the Bot is no longer in the roster" once a minute for as long as the deployment lives.
   * Normal deletion is soft (`agents/profile-store.ts`), so this fires only on the hard-delete
   * path; it is the one that used to leave the wreckage.
   */
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** What to do, in words. Sent to the Bot verbatim as the run's one user message. */
  instruction: text("instruction").notNull(),
  scheduleKind: routineScheduleKind("schedule_kind").notNull(),
  intervalMinutes: integer("interval_minutes"),
  /**
   * "HH:MM" in `dailyTimeZone`, not in UTC. Text because it is a time-of-day, not a moment.
   *
   * It was called `daily_utc` and has held zone-local time since `daily_time_zone` arrived beside
   * it — a column whose name asserted the one thing it was not. Renamed in migration 0026.
   */
  dailyLocal: text("daily_local"),
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
  /**
   * Who typed it, and nullable because a routine outlives them.
   *
   * The ownership rule is already written down in `routines/service.ts`: a routine is yours if you
   * wrote it OR if the Bot it drives is yours, because staff leave and a shop owner must not be
   * locked out of the routines running on their own Bot. `set null` is that rule at the column —
   * the author's account going away takes the author, not the routine.
   */
  createdById: text("created_by_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdByRole: text("created_by_role").notNull(),
  /**
   * Which catalogue suggestion this routine was made from, or null for one somebody wrote.
   *
   * The dedup key, in Hermes Agent's word for it. A suggestion is offered until a routine carrying
   * its key exists and again once that routine is gone — so the column is on the routine and not in
   * a ledger of acceptances, because "do you already have this" is a question about the routines,
   * and a ledger would go on answering yes after the person deleted the thing it referred to.
   * Text, not a reference: the catalogue is code, and dropping an entry must not orphan a routine.
   */
  suggestionKey: text("suggestion_key"),
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
  /** Cascade: a run is a page of one routine's history and has no meaning without it. */
  routineId: text("routine_id")
    .notNull()
    .references(() => lafRoutines.id, { onDelete: "cascade" }),
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
   *
   * Written through drizzle's own `jsonb()` until 0026, which is the double-encoding trap: every
   * one of the 22 rows this deployment had held a jsonb *string*, and `steps.reduce` on the
   * Routines page would have thrown on the first one it drew. The custom type sends an array as an
   * array; the migration repairs the rows already written.
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

/**
 * Suggestions this person said 다음에 to, latched.
 *
 * A suggestion is a card the routines page offers from a curated catalogue — never a routine made
 * on anybody's behalf — and 다음에 is meant literally as "not this one": pressed once, the card does
 * not come back. Without the latch every visit re-offers what was declined, which is the nag wall
 * the cap of five and this table together exist to prevent. Per person, because the catalogue is
 * the same for everybody and the decision is not.
 *
 * NOTHING HERE OUTLIVES THE PERSON: the key is a catalogue word and the row cascades with the user.
 * There is no row for an acceptance — the routine that was made carries `suggestion_key` itself.
 */
export const lafRoutineSuggestionDismissals = pgTable(
  "laf_routine_suggestion_dismissals",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** A key from `routines/suggestion-catalog.ts`. Text, so a catalogue edit is not a migration. */
    suggestionKey: text("suggestion_key").notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.suggestionKey] })],
);

/**
 * One outbox for "somebody has to be told", whatever is going to tell them.
 *
 * THE PROBLEM IT SOLVES is that a Bot blocked on a person reached that person through whichever
 * surface happened to be open. The buzz webhook fired from inside the approval registry and
 * remembered nothing, so nobody could answer "did that question ever reach anybody"; the page
 * worked out "a Bot is waiting" from its own tab, so a question raised while nobody was looking
 * reached nothing at all; and the number this product is judged by — how long a person takes to
 * answer, at night — had no row to be counted from. One row per thing worth interrupting somebody
 * about, written once, then offered to every door in turn.
 *
 * IT IS A QUEUE, NOT THE TRAIL. `audit_events` is the record of what happened and refuses to be
 * edited; these rows are marked as they are delivered and seen, and are deleted after thirty days
 * by the retention tick. Nothing here is evidence of anything — the approval's own `approval.*`
 * rows are, which is why the KPI in `notifications/approval-metrics.ts` is computed from those and
 * never from this table.
 *
 * `kind` IS TEXT AND NOT AN ENUM, deliberately. It is a product word — the list of things worth
 * interrupting somebody about — and adding one should be a line of TypeScript rather than a
 * migration. Nothing in SQL branches on it; `NotificationKind` in `notifications/outbox.ts` is the
 * list, and the door and the adapters are what read it.
 *
 * NO FOREIGN KEY ON `bot_id`, one on `user_id`. A notification that cannot be written is a person
 * who is never told, so the Bot's id is carried as text the way `laf_thread_messages.thread_id` is:
 * an id, not a row, and a Bot deleted between the question and the sweep must not turn the insert
 * on the path that was trying to reach somebody into an exception. The person is the opposite case
 * — the rows are addressed to them, they are worth nothing once the account is gone, and the
 * cascade is what stops a departure leaving a queue behind that nobody owns.
 */
export const lafNotifications = pgTable(
  "laf_notifications",
  {
    id: text("id").primaryKey(),
    /** One of `NotificationKind`. See the note above on why this is not an enum. */
    kind: text("kind").notNull(),
    botId: text("bot_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The question this is about, for the rows that are about one. */
    approvalId: text("approval_id"),
    /** The room it happened in, for the rows that happened in one. */
    channelId: text("channel_id"),
    /**
     * What the action was, in facts — the same `AskSubject` the approval card is drawn from.
     *
     * Carried so a door can say what is waiting without going back to a registry that lives in
     * another process's memory and has already forgotten. The words are still the surface's: the
     * server sends facts, here as everywhere else.
     */
    subject: jsonb("subject"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Which doors took it. Appended to, never replaced, so a row says every way it went out.
     *
     * An array rather than a boolean because there are several doors and they fail independently:
     * "the webhook took it and nobody was connected" and "the page had it the whole time" are
     * different mornings, and one `delivered` flag cannot tell them apart.
     */
    deliveredVia: text("delivered_via")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** When the FIRST door took it. Null means nothing has managed to deliver it yet. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** When the person actually looked. Set by the in-app door, or by answering the question. */
    seenAt: timestamp("seen_at", { withTimezone: true }),
  },
  (table) => [
    // The door's own read: this person's rows, newest first.
    index("laf_notifications_user_created_at_idx").on(
      table.userId,
      table.createdAt,
    ),
    // Answering a question marks its rows seen, and arrives holding only the approval's id.
    index("laf_notifications_approval_idx").on(table.approvalId),
    // The thirty-day sweep, which is a range over this column and nothing else.
    index("laf_notifications_created_at_idx").on(table.createdAt),
  ],
);

/**
 * Which sites this person has signed into on a Bot's browser, and when it was last seen working.
 *
 * WHAT IT IS NOT: a credential store. Nothing here is a secret, because the session itself is not
 * here — it is a cookie in the Chromium profile on this person's own VM
 * (`agent-computer/src/profiles.ts`), which is durable and never leaves the machine. These four
 * facts are only what the 사이트 연결 card needs in order to stop guessing: whether the person has
 * ever done the handoff, when, on which Bot's browser, and whether the last time anything looked at
 * that site it was still logged in.
 *
 * ONE ROW PER PERSON PER SITE. `bot_id` is which browser the session was last seen in rather than
 * part of the identity: a person signs in once and the card is about the site, not about the
 * profile directory it happened to land in — but the card still names the Bot, because a browser
 * profile is per Bot and a card that did not say which one would be quietly claiming more than it
 * knows.
 *
 * NO FOREIGN KEY ON `bot_id`, one on `user_id`, for the reason `laf_notifications` gives: the write
 * happens on the success path of a navigation, and a Bot deleted between the login and this
 * morning's routine must not turn a bookkeeping write into an exception on the path that was doing
 * somebody's work. The person is the opposite: these rows are theirs and are worth nothing once the
 * account is gone.
 */
export const lafSiteConnections = pgTable(
  "laf_site_connections",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** An id from `shared/sites/catalogue.ts`. Text, so adding a site is not a migration. */
    siteId: text("site_id").notNull(),
    /** Whose browser the session was last seen in. */
    botId: text("bot_id").notNull(),
    /** The first time the handoff finished with the page reading as signed in. */
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** The last time anything — a person, a chat, a routine — saw that page still signed in. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * The last look found the login wall instead.
     *
     * Kept rather than deleting the row, because "you signed in here in March and it has expired"
     * is a different thing to tell somebody than "you have never connected this", and it is the one
     * that explains why this morning's routine came back empty.
     */
    needsLogin: boolean("needs_login").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.siteId] }),
    // The card list's own read: this person's rows, all of them, once per screen.
    index("laf_site_connections_user_idx").on(table.userId),
  ],
);

/**
 * What a person wrote to the people who run this product, from the 문의·의견 box.
 *
 * ITS OWN TABLE, NOT AN OUTBOX ROW. The outbox is a queue the retention tick empties after thirty
 * days, and it is not the trail (see `laf_notifications`); a person's words to the operator are
 * neither a thing to be delivered and forgotten nor a fact about a Bot. The row here is the
 * message. The outbox row that goes with it is only the telling — which door carried it to the
 * fleet's alert webhook, if any did — and may be gone long before this is.
 *
 * TWO FACTS ABOUT THE SCREEN, AND NOTHING ELSE. `route` and `failure_code` are filled only when the
 * person ticked 지금 화면을 같이 보냄, and they are what that phrase means: the path of the screen
 * they were on, and the code of the last failed turn it had drawn. Never a screenshot, never a
 * message from the conversation, never what was typed to a Bot — the same rule as the audit
 * payload, because a box that says "send what is on screen" and quietly sends a transcript is a
 * box nobody would tick twice.
 *
 * CASCADES WITH THE PERSON. The words are theirs; a departure takes them. The operator who needed
 * them has had them on the webhook already.
 */
export const lafFeedback = pgTable(
  "laf_feedback",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** What they wrote, at most `FEEDBACK_MAX_LENGTH` characters (`support/feedback.ts`). */
    text: text("text").notNull(),
    /** The app path they were looking at, when they chose to say so: `/channel/…`, `/routines`. */
    route: text("route"),
    /** The last turn-failure code that screen had drawn, when they chose to say so. */
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The operator's read, newest first — from the fleet, or by hand.
    index("laf_feedback_created_at_idx").on(table.createdAt),
  ],
);
