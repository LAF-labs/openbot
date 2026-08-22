/**
 * Computer tables: agent computers, sessions, computer-use audit.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or coworker.ts to do it.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * The boundary this deployment is enforcing, kept where a restart cannot lose it.
 *
 * This table keeps policy across restarts. The policy can be changed while running, and a restart
 * must not silently return to the default.
 *
 * One row, by construction. A deployment has one boundary, so the primary key is a constant and every
 * write is an upsert onto it. A table that can hold two policies is a table that will eventually hold
 * two and have to decide between them, and "which of these is in force" is not a question this should
 * ever be able to ask.
 *
 * Memory is still the cache. The gateway asks for the policy on every action, so it reads from
 * memory; this is the record that survives a restart, not something on the path of a click.
 */
export const actionPolicy = pgTable("action_policy", {
  /** Always `current`. See the note above on there being exactly one. */
  id: text("id").primaryKey(),
  /** `enforce` or `dry-run`. Not an enum: the policy module owns that vocabulary. */
  mode: text("mode").notNull(),
  deny: text("deny").array().notNull(),
  /**
   * The rules that stop and ask a person, rather than deciding on their own.
   *
   * Defaulted to empty rather than left nullable, so a deployment whose row was written before this
   * list existed comes back up meaning what it meant: no questions, same two answers. A nullable
   * column would put the same reasoning in every reader instead, and one of them would eventually
   * read null as something other than "asks nobody anything".
   */
  ask: text("ask").array().notNull().default([]),
  allow: text("allow").array().notNull(),
  /** Who last changed it, for the Admin page and the trail. */
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The questions a Bot is waiting on a person to answer, where every process can see them.
 *
 * These lived in a Map in the process that raised them, on the argument that a restart takes the
 * browser session, the open page and the mid-flight model run with it, so an approval that came back
 * from storage would be a grant for an action nobody could still perform. The argument is right about
 * restarts and wrong about processes. A deployment serving a company runs several servers behind a
 * load balancer, and the person who answers arrives on whichever one the balancer picked: a question
 * raised on one and answered on another is reported as "no longer open", which reads exactly like an
 * expiry, and the Bot waits out its ten minutes for an answer that was already given. Nothing logs a
 * failure, because from each process's point of view nothing failed.
 *
 * What kept a restart honest was never the Map; it is `expiresAt` and the fingerprint. An approval is
 * good for ten minutes and for one action, compared by hash at the moment it is spent, so the worst a
 * surviving row can buy is the very action a person approved, within minutes of approving it. That is
 * consent, not a stale grant. Rows are swept on read rather than by a timer, for the same reason the
 * Map was: nothing here matters until somebody looks, and everything that looks sweeps first.
 *
 * `granted` null means unanswered. Answering is `UPDATE ... WHERE granted IS NULL` and spending is
 * `DELETE ... RETURNING`, so two tabs racing to answer, or two processes racing to spend, resolve in
 * the database rather than in whichever copy of the Map replied first.
 */
export const computerApprovals = pgTable("computer_approvals", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull(),
  /** Who was driving the Bot when it met the rule. Not necessarily who answers. */
  actor: text("actor").notNull(),
  /** The expression that asked. Null when the floor asked rather than a written rule. */
  rule: text("rule"),
  /** What is about to happen, in one sentence, as the policy phrased it. */
  question: text("question").notNull(),
  /** The action this approval is good for, and only this one. Compared at consumption. */
  fingerprint: text("fingerprint").notNull(),
  /**
   * What a standing allowance granted from this question would cover. See `allowanceFor`.
   *
   * Decided here, where the action is still known, and never taken from the request that presses the
   * button: a client that could name its own scope could be shown "always allow wttr.in" and grant
   * itself every host. The surface reads it back off the approval to write the sentence on the
   * button, so what a person is offered and what pressing it does are the same fact.
   *
   * Nullable, and an approval without one simply does not offer the button. That is the honest
   * reading of a row written before this column existed, and it fails in the safe direction.
   */
  scopeKind: text("scope_kind"),
  scopeValue: text("scope_value"),
  /** What the trail files this under, carried so an answer lands against the same thing the action will. */
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** The only thing standing between a survived row and a stale grant. Swept on every read. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Null until somebody answers. False is an answer, and a final one. */
  granted: boolean("granted"),
  /** Who answered, so the audit row credits a person rather than a Bot. */
  answeredBy: text("answered_by"),
});

/**
 * Every counted call a Bot has made inside the repetition window, one row each.
 *
 * The counts lived in a nested Map, and a deployment behind a load balancer split them: a Bot
 * clicking the same button forty times across four processes was ten repetitions to each of them, so
 * a rule written as `repeat.count >= 25` never fired and the trail recorded a Bot behaving itself.
 * A boundary that stops enforcing without saying so is the failure mode this whole area is built
 * against, so the counts moved to where every process does the same arithmetic.
 *
 * A row per call rather than an array per key, because the question asked of this table is "how many
 * in the last three minutes", which SQL answers by counting rows; keeping an array would mean reading
 * it, editing it and writing it back, and two processes doing that at once lose one of the calls.
 * The window is enforced by deleting on read, so what is in here is the recent past and nothing else.
 * The per-Bot and per-key caps the Map needed are gone with it: they bounded memory, and rows that
 * delete themselves at three minutes bound nothing that needs bounding.
 */
export const computerRepeatCalls = pgTable(
  "computer_repeat_calls",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id").notNull(),
    /** The call, as the detector fingerprints it: tool, ref, key, path. */
    fingerprint: text("fingerprint").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("computer_repeat_calls_lookup").on(
      table.botId,
      table.fingerprint,
      table.at,
    ),
  ],
);

/**
 * Which thresholds a run of repetition has already reported, so it is reported once.
 *
 * The Map kept this in a Set per key, which meant once *per process*: four processes crossing the
 * same threshold filed four rows for one incident, and an operator reading the trail counted four
 * incidents. The primary key does that job here, and `ON CONFLICT DO NOTHING ... RETURNING` decides
 * which process gets to be the one that reports — exactly one row comes back, whoever raced.
 *
 * A run ends when the window empties. The sweep deletes the rows here whose call rows are all gone,
 * which is what the Map did by clearing the Set, and is why a Bot that got stuck, recovered, and got
 * stuck again an hour later files two incidents rather than one.
 */
export const computerRepeatReports = pgTable(
  "computer_repeat_reports",
  {
    botId: text("bot_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    threshold: integer("threshold").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.botId, table.fingerprint, table.threshold] }),
  ],
);

/**
 * The questions a person decided not to be asked again, and what each answer covers.
 *
 * `computer_approvals` above is one yes for one action, ten minutes wide and bound to a hash. That is
 * the right shape for consent and the wrong shape for a Bot that works all day: a person who has told
 * the same Bot four times that it may read the weather site is not consenting on the fourth press,
 * they are clearing an obstacle, and a boundary that produces reflexive pressing has stopped being a
 * boundary. So a person can answer the wider question once.
 *
 * IN THE DATABASE, UNLIKE A PENDING QUESTION, and for the same reason: this one is meant to outlive
 * the turn. A pending approval is about a live browser session and a model mid-run, so a restart is
 * an honest withdrawal of it; a standing allowance is a decision about how this Bot should be
 * treated from now on, and losing it at a deploy would silently return everybody to being asked,
 * which is the failure mode this table exists to prevent.
 *
 * WHAT IT IS NOT is a fingerprint. Binding this to the exact action would make it worthless — a ref
 * belongs to one snapshot and a page renders a new one every time — so the scope is the coarser
 * thing a person can actually hold in their head: this host, this file, or this tool. That is a real
 * widening, and the three things that keep it honest are that the surface prints the scope on the
 * button before it is pressed, that the row records who granted it and the question they were shown,
 * and that `deny` never reaches here. Only `ask` can be answered this way.
 *
 * The rule is part of the key. A deployment that rewrites the boundary gets asked again, because a
 * different rule stopping the same action is a different question, and consent given to one is not
 * consent to the other.
 *
 * Revoked rather than deleted: withdrawing an allowance is itself a decision about a boundary, and a
 * row that disappears takes the record of ever having been granted with it.
 */
export const computerStandingApprovals = pgTable(
  "computer_standing_approvals",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id").notNull(),
    /** The expression that asked. Empty string when the floor asked rather than a written rule. */
    rule: text("rule").notNull(),
    /** What the answer covers, as `host=…`, `file=…` or `tool=…`. See `allowanceOf`. */
    scope: text("scope").notNull(),
    /** The same scope split for display, so the list can be read without parsing it back apart. */
    scopeKind: text("scope_kind").notNull(),
    scopeValue: text("scope_value").notNull(),
    /** The sentence the person was looking at when they pressed it. */
    question: text("question").notNull(),
    grantedBy: text("granted_by").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Null while it still stands. Set rather than deleted, so the grant stays on the record. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
  },
  (table) => [
    /**
     * One live allowance per Bot, rule and scope, enforced here rather than hoped for.
     *
     * `grant` looks before it inserts, and two tabs pressing the same button at the same moment both
     * look and both find nothing. Without this the loser's row is a duplicate that revoking the
     * first one does not remove, so an allowance a person believes they have withdrawn keeps
     * standing — and the list they withdrew it from shows one entry, because it looked the same way.
     *
     * Partial, so revoked rows accumulate freely: the same allowance can be granted, withdrawn and
     * granted again, and every one of those decisions stays on the record.
     */
    uniqueIndex("computer_standing_approvals_live_idx")
      .on(table.botId, table.rule, table.scope)
      .where(sql`${table.revokedAt} is null`),
  ],
);
