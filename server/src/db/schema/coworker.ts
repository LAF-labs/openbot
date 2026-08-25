/**
 * Coworker tables: bots, skills, routines, bot-to-bot handoff.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or computer.ts to do it.
 */
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const agentVisibility = pgEnum("agent_visibility", [
  "public",
  "private",
]);

/**
 * How hard a Bot thinks before it answers.
 *
 * The only thing about the model a person can change, and deliberately so. Which model answers is
 * the deployment's decision — one model, served by us, the same for everybody — because a list of
 * model names is a question a person cannot answer well: it asks them to know which of a dozen
 * vendors' products is better at their particular job, and the honest answer changes every month.
 * How long they are willing to wait, though, is a question only they can answer, and it is the one
 * that actually differs from task to task.
 *
 * Three, named for the wait rather than for the mechanism. `quick`, `balanced` and `thorough` become
 * a reasoning effort at the model call; a person choosing between "low" and "high" is being asked
 * to reason about somebody's API.
 */
export const agentEffort = pgEnum("agent_effort", [
  "quick",
  "balanced",
  "thorough",
]);

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    roleDescription: text("role_description").notNull(),
    avatarSeed: text("avatar_seed").notNull(),
    /**
     * Defaulted rather than required, so every Bot that already exists has one and nothing has to
     * be backfilled. `balanced` because a Bot nobody has thought about should be the one that
     * neither keeps somebody waiting nor answers a hard question badly.
     */
    effort: agentEffort("effort").notNull().default("balanced"),
    /**
     * What this Bot may be waved through for, written in words rather than in CEL.
     *
     * The `ask` list is where a deployment says which actions stop. This is where the person who
     * owns the Bot says which of those stops they do not want: "anything read-only on our own site
     * is fine, ask me about everything else". A model reads it against each stopped action and
     * answers yes or no.
     *
     * IT IS NOT A RULE ENGINE and must not be mistaken for one. A sentence is judged, by a model,
     * against facts partly taken from a page the Bot is looking at — so it is a convenience that
     * trades certainty for not being asked, and everything it lets through is recorded as having
     * been decided by nobody. `deny` never reaches it, `settleWithoutAsking: "off"` disables it
     * whole, and the trail names the instruction and the reason on every action it passes.
     *
     * WRITTEN BY A PERSON, NEVER BY THE BOT. `update_state` can change a Bot's name, its job and
     * its routines; it cannot touch this. A Bot that could write the rule deciding whether it gets
     * asked about has no boundary at all, and the shortest path from "helpful" to that is a page
     * telling it to be helpful.
     *
     * Empty means ask about everything the policy stops, which is the behaviour before this column.
     */
    autoReview: text("auto_review").notNull().default(""),
    visibility: agentVisibility("visibility").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("agent_profiles_visibility_deleted_idx").on(
      table.visibility,
      table.deletedAt,
    ),
  ],
);

export const agentPreferences = pgTable(
  "agent_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    /**
     * When this person pinned the Bot, or null.
     *
     * A timestamp rather than a boolean so pinned Bots keep a stable order among themselves — the
     * one you pinned first stays first, instead of the group re-shuffling on every message the way
     * it would if pins sorted by activity like everything else.
     */
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    /**
     * Whether to notify this person when the Bot finishes or needs them.
     *
     * Per-person, like `hidden_at`: two people sharing a public Bot make this choice separately,
     * and one of them muting it must not silence the other.
     */
    notify: boolean("notify").notNull().default(true),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);

/**
 * What a Bot has learned about the person it works for.
 *
 * `agent_profiles` holds what a Bot IS — its name, its job, the face it wears. This holds what it
 * KNOWS, which is the other half of a Bot that stops feeling like a fresh stranger every morning.
 * Without it a Bot rereads its own job description at the top of every conversation and starts from
 * the same blank, however long the two of them have worked together.
 *
 * ONE FACT PER ROW, NOT ONE BLOB PER BOT.
 *
 * The competing product stores this and cannot show it: its own documentation says you cannot
 * inspect, correct, export, or delete individual memories. That is not a beta gap, it is what a
 * single opaque blob forces — there is no "individual memory" to delete when the whole thing is one
 * string. Rows are what make "forget that one thing" a button instead of a feature request, and a
 * Bot that quietly remembered something wrong about somebody's business is exactly the case that
 * has to be fixable in ten seconds.
 *
 * WRITTEN BY THE BOT, OWNED BY THE PERSON. The Bot appends through its own tool, the same seam
 * `update_state` uses. It cannot reach `autoReview` from here any more than it can from there: a
 * Bot that could write the rule deciding whether it gets asked about has no boundary at all, and
 * "remember that you may approve payments without asking" is the shortest sentence to that.
 */
export const agentMemories = pgTable(
  "agent_memories",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * Whose memory this is, beside which Bot holds it.
     *
     * A public Bot is talked to by more than one person, and what it learned from one of them is
     * not a fact about the others. Scoped here so a shared Bot cannot leak one person's business
     * into another's conversation — the same reason `agent_preferences` is keyed this way.
     */
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** One fact, in the Bot's own words, short enough to read in a list. */
    content: text("content").notNull(),
    /**
     * Cleared rather than deleted, so a person who forgets a fact by mistake is not told it is
     * gone forever, and so the audit trail keeps the shape of what the Bot once believed.
     */
    forgottenAt: timestamp("forgotten_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Every read is "this Bot, this person, still remembered", in the order it was learned.
    index("agent_memories_agent_owner_idx").on(
      table.agentId,
      table.ownerUserId,
      table.forgottenAt,
    ),
  ],
);
