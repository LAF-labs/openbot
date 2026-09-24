import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
// NOT drizzle's `jsonb`: that one serialises, and so does the driver, so every object landed as a
// JSON string and nothing in this database could be queried by a JSON field. See ./json.ts.
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const role = pgEnum("role", ["admin", "user"]);
export const agentType = pgEnum("agent_type", ["built_in", "remote_ag_ui"]);
export const credentialKind = pgEnum("credential_kind", [
  "model",
  "connector",
  // A customer's own agent behind a key. Its own kind so "what does this deployment hold" stays true.
  "agent",
  // A token for an MCP server. Same vault and same revocation as everything else, so the server row
  // holds a pointer and never the secret.
  "mcp",
  /*
   * A deployment's OAuth client for an MCP server: the id and the secret this deployment registered
   * with the vendor, whether an administrator pasted it in or the deployment registered itself.
   *
   * Its own kind rather than another `mcp`, because it is a different thing with different reach. A
   * client identifies this deployment to a vendor and can read nobody's data on its own; it is the
   * thing you must have before anybody can consent, and the thing you rotate when it leaks.
   */
  "mcp_oauth_client",
  /*
   * One person's refresh token for one MCP server.
   *
   * The far end of the same flow and the opposite risk: this reaches everything that person can see.
   * Distinct from the client so that "what does this deployment hold" stays answerable — one row
   * that speaks for the deployment, and one row per person that speaks for them.
   */
  "mcp_user_token",
]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  image: text("image"),
  emailVerified: boolean("email_verified").notNull().default(false),
  groups: text("groups").array().notNull().default([]),
  /**
   * When this person finished making their first Bot, or null if they have not.
   *
   * Onboarding runs once and is the only place the product asks anybody to set something up, so
   * "have they done it" has to survive a reload and a new device — which rules out the browser. It
   * is a timestamp rather than a boolean because the day somebody asks "when did they join", this
   * is the honest answer and a boolean would have thrown it away.
   */
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  /**
   * When this person agreed to the terms and the privacy policy, and which version they agreed to.
   *
   * Stamped by the same call that marks onboarding, because the first screen of the product is the
   * one that says "continuing means you agree" — there is no separate consent form, and a stamp
   * written by a different call could record consent from somebody who never saw that screen.
   * The version is the one printed at the head of `app/src/legal/*.md` (`LEGAL_VERSION` in
   * `account/consent.ts`), so that when the text changes it is answerable which text somebody
   * actually agreed to. Both null for anybody who joined before the text existed.
   */
  consentedAt: timestamp("consented_at", { withTimezone: true }),
  consentVersion: text("consent_version"),
  /**
   * What kind of business this person runs, and the places they work in every day.
   *
   * The two questions the first run asks between the agreement and the first Bot, changed later on
   * Settings → 내 가게 (`account/shop.ts`). On the person because they are the person's: one account
   * per deployment, and every Bot in it reads the same answer before every run
   * (`agents/shop-context.ts`). No tool a Bot holds writes them.
   *
   * Catalogue keys, not words (`shared/shop/catalogue.ts`), and plain text rather than an enum: the
   * catalogue will grow, and a key it has since dropped is skipped on read rather than failing the
   * read every run makes. Null and empty are "not answered" — skipped, or an account older than the
   * question — and nothing is backfilled, because an answer nobody gave would be told to every Bot.
   */
  businessKind: text("business_kind"),
  dailyPlaces: text("daily_places").array().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("accounts_provider_account_idx").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const userRoles = pgTable(
  "user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: role("role").notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.role] })],
);

export const deploymentPackages = pgTable("deployment_packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull().unique(),
  sourcePath: text("source_path").notNull(),
  checksum: text("checksum").notNull(),
  loadedAt: timestamp("loaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: agentType("type").notNull(),
  configuration: jsonb("configuration").notNull(),
  packageId: uuid("package_id").references(() => deploymentPackages.id, {
    onDelete: "set null",
  }),
  override: jsonb("override"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  suggestedPrompts: text("suggested_prompts").array().notNull().default([]),
  allowedGroups: text("allowed_groups").array().notNull().default([]),
  packageId: uuid("package_id").references(() => deploymentPackages.id, {
    onDelete: "set null",
  }),
  override: jsonb("override"),
  /*
   * `last_message`, `last_message_at` and `last_message_agent_id` USED TO BE HERE, at channel
   * grain, on the reasoning that what was said last is a property of the conversation. It is
   * not: every person in a channel has a thread of their own (`channel_threads`, keyed on
   * person and channel), so two people in one channel hold two conversations, and one preview
   * shared between them was the owner's last sentence on a member of staff's roster — measured
   * on the audit of 2026-09-10, where a leaver's last words stayed on the survivor's row. The
   * preview lives on `channel_threads` since migration 0038, beside the thread it previews.
   */
  /**
   * Which room turn is current, counted up by every message a person posts into the room.
   *
   * NOTHING READS OR WRITES IT SINCE 2026-09-24, when rooms were removed. It keeps the numbers the
   * rooms left; dropping it is a migration somebody decides on.
   *
   * A ROOM TURN CAN OUTLIVE ITS QUESTION. Several Bots answering in rounds takes a minute, and in
   * that minute the person can say something else — at which point everything still running is
   * answering a question that has been superseded. Every checkpoint in the turn compares this
   * number against the one it started with, so a newer message ends the older turn wherever it had
   * got to. A column rather than a counter in memory because two server processes must not each
   * believe their own turn is the current one.
   */
  roomTurnEpoch: bigint("room_turn_epoch", { mode: "number" })
    .notNull()
    .default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const channelMemberships = pgTable(
  "channel_memberships",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * When this person last had this conversation open, or null for one they have never opened.
     *
     * The home the comment on `channels.last_message` already named: what was said last is a
     * property of the room, what has been SEEN is a property of a person in it. A time rather than
     * a flag, so "mark unread" is just moving it back rather than a second column that can disagree
     * with the first.
     */
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.userId] })],
);

export const channelAgents = pgTable(
  "channel_agents",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.agentId] })],
);

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: credentialKind("kind").notNull(),
    provider: text("provider").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    keyId: text("key_id").notNull(),
    metadata: jsonb("metadata").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // At most one live credential per (kind, provider, key_id). Revoked rows are
    // excluded so history is preserved, and two writers racing to rotate the
    // same secret cannot both insert a live row.
    uniqueIndex("credentials_active_key_idx")
      .on(table.kind, table.provider, table.keyId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Who did it, as an id rather than a reference. No foreign key: the trail is append-only, so any
     * cascade the database wanted to run against it would be an update the trigger refuses, and a
     * user who had done anything could never be deleted.
     */
    actorUserId: text("actor_user_id"),
    eventType: text("event_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_events_created_at_idx").on(table.createdAt),
    /*
     * The two filters the reader actually offers, each paired with the ordering it is read in.
     *
     * `audit_events_created_at_idx` alone serves "the last N rows" and nothing else, and the trail
     * page is never read that way: it is read as "what did this person do" and "show me every
     * `computer.denied`", both narrowed and then sorted by time. On a table that only ever grows
     * and is never pruned, those were both a scan of everything the deployment has ever recorded.
     */
    index("audit_events_type_created_at_idx").on(
      table.eventType,
      table.createdAt,
    ),
    index("audit_events_actor_created_at_idx").on(
      table.actorUserId,
      table.createdAt,
    ),
  ],
);

/**
 * Which thread a person is having with a channel.
 *
 * It was `intelligence_channel_mappings`, after a service this fork does not use: threads once
 * lived in CopilotKit Intelligence and this table pointed at them there. They live in
 * `laf_thread_messages` now and nothing here reaches a hosted service, so migration 0026 renames
 * the table to what it is.
 */
export const channelThreads = pgTable(
  "channel_threads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    /**
     * The last thing said in THIS person's conversation with the channel, for their roster.
     *
     * Here and not on `channels`, because this row is the conversation: a channel with two people
     * in it holds two threads, and a preview stored once per channel showed each of them the
     * other's last sentence. Written by the three things that append a message — the browser's
     * report of a chat turn, a room turn, a routine's delivery — always for the thread the message
     * went into, and read by the roster through the same join it already makes on this table.
     * What has been SEEN stays on the membership, beside it.
     */
    lastMessage: text("last_message"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /** Which Bot spoke, so a room with several can show the right one. Null for a person. */
    lastMessageAgentId: text("last_message_agent_id").references(
      () => agents.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.channelId] }),
    uniqueIndex("channel_threads_thread_idx").on(table.threadId),
    /**
     * The order one person's roster is drawn in: their threads, newest activity first.
     *
     * Declared here rather than only in a migration, because an index the schema does not know
     * about is one the next generated migration silently drops.
     */
    index("channel_threads_recent_idx").on(table.userId, table.lastMessageAt),
  ],
);
