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
