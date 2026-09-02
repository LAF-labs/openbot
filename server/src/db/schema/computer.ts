/**
 * Computer tables: agent computers, sessions, computer-use audit.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or coworker.ts to do it.
 */
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
  /**
   * Whether an asked action may be settled without a person seeing it. See `settleWithoutAsking`.
   *
   * A COLUMN, because the live policy is held in memory and a restart returns to whatever this row
   * says. Left out of the row, a deployment that switched it off would come back up with it on and
   * nothing anywhere would mention it — a governance switch that quietly un-switches itself is
   * worse than one that was never offered.
   *
   * Nullable, and null reads as allowed: a row written before this column existed means what it
   * meant.
   */
  settleWithoutAsking: text("settle_without_asking"),
  /** Who last changed it, for the Admin page and the trail. */
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The questions a person decided not to be asked again, and what each answer covers.
 *
 * A pending approval (`server/src/computer/approvals.ts`, in memory) is one yes for one action, ten
 * minutes wide and bound to a hash. That is
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
