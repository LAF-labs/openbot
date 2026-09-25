/**
 * Coworker tables: bots, skills, routines.
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

/*
 * THERE IS NO `agent_visibility` ANY MORE, and there was never a use for one.
 *
 * A Bot belonged to the account that made it and carried a `public`/`private` choice beside that,
 * which is two answers to one question. The owner's words, 2026-09-16: "모든 봇은 해당 계정 소유인
 * 거고 다른 계정이랑은 전혀 관계없는건데? 남이 만든 봇을 다른 계정이 볼 수 있는 구조라는거 자체가
 * 잘못된 거임." So the column and its enum are gone (migration 0042) and the one rule left is
 * ownership: `agent_profiles.owner_user_id`. A null owner is the deployment's own Bot — one a
 * package shipped — and stays everybody's, which is the rule `auth/guards.ts` already used.
 */

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
    /*
     * NO `title` SINCE MIGRATION 0047 (2026-09-24). A Bot's profile is its name and its face; the
     * job title went with the presets and the card that wrote it, and a column nobody can see or
     * change must not go on telling the Bot what it is. `role_description` stays: it is where the
     * Bot writes down, with `update_profile`, a standing job somebody handed it in chat.
     */
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
     * WRITTEN BY A PERSON, NEVER BY THE BOT. `update_profile` can change a Bot's name, its job and
     * its routines; it cannot touch this. A Bot that could write the rule deciding whether it gets
     * asked about has no boundary at all, and the shortest path from "helpful" to that is a page
     * telling it to be helpful.
     *
     * Empty means ask about everything the policy stops, which is the behaviour before this column.
     */
    autoReview: text("auto_review").notNull().default(""),
    /*
     * NO `preset_id` SINCE MIGRATION 0047. It recorded which of the ready-made kinds of work a
     * person pressed when making a Bot, for the fleet's count of which kinds people pick; the
     * presets were removed on 2026-09-24 and nothing has written it since.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // The index every roster read uses, now that whose it is decides who may see it. It replaced
    // one on (visibility, deleted_at), which indexed a column that no longer exists.
    index("agent_profiles_owner_deleted_idx").on(
      table.ownerUserId,
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
    /*
     * NO `pinned_at` SINCE MIGRATION 0047. Pinning ordered a roster of several Bots; a person has
     * one Bot since 2026-09-24, nothing could pin one after that, and nothing read the column.
     */
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
 * `update_profile` uses. It cannot reach `autoReview` from here any more than it can from there: a
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
     * A deployment serves one person — one VM each, see docs/laf/deployment-model.md — so on a
     * correct one this column has a single value and never does any work. It is here as defence
     * in depth: SIGN_IN_ALLOWED_EMAILS (auth/allowlist.ts) is the door now, but a deployment that
     * leaves it unset is open, and this column is what keeps that mistake survivable.
     *
     * And because narrowing is the direction you cannot take later. A row written without an owner
     * cannot be given one afterwards — there is nobody left to ask which person it belonged to —
     * so the column costs a text field now or costs the data later.
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
    /**
     * Who wrote the words: `bot` through `remember` in a conversation, `owner` on 수첩.
     *
     * Decided by the route, never by the body: the Bot's tool posts to `/memories` and 수첩 to
     * `/notebook`, and no tool handler reaches the second (`app/tests/notebook-boundary.test.ts`).
     * Every row older than the column was the Bot's, which is what the default says.
     */
    source: text("source").notNull().default("bot"),
    /**
     * When the person said a Bot's memory is right. An owner's own line is confirmed by being
     * theirs and leaves this null. Confirmed lines are drawn under their own heading in the
     * prompt and are carried first when the memory is over its cap (`shared/notebook.ts`).
     */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /**
     * The line that replaced this one, when it was edited on 수첩 rather than forgotten.
     *
     * An edit is soft — this row is forgotten and a new one written — so the audit keeps what the
     * Bot once believed. The link is what tells the harness it was a correction and not a
     * forgetting: a correction reaches a conversation as a reminder, where a forgetting has to
     * redraw the frozen layer (`server/src/context/conversations.ts`).
     */
    replacedBy: text("replaced_by"),
    /**
     * One of the shop's named lines on 수첩 — `shop_name`, `hours`, `offer` — or null for an
     * ordinary memory. At most one live row per slot (the store replaces, never appends).
     */
    slot: text("slot"),
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
