/**
 * EVERY TABLE IN THE DATABASE, AND WHAT A PERSON'S EXPORT AND DELETION DO WITH IT.
 *
 * The decision for each, written once, where a test can hold the database to it. The review of
 * 2026-10-11 walked the schema table by table and found eight that had arrived since `export.ts`
 * and `docs/laf/data-lifecycle.md` were written and had no decision anywhere: they were cascaded
 * away by a foreign key, which is fine for what they hold, and absent from the download, which is
 * not — "everything this deployment holds about you" has to be true of the file. A table added
 * next month lands here or fails `account-lifecycle.integration.test.ts` ("every table in the
 * database has a decision here"), the way a column that names a conversation without a key fails
 * `NAMES_A_CONVERSATION` (`channels/deleting.ts`).
 *
 * `exported`: the section of the export document the table's rows go into, or `null` with a
 *   reason. A section is named here so the test can check it is actually a key of the file.
 * `deletion`:
 *   `deleted`       — removed by name in `deletion.ts`, counted under `counted` in the trail.
 *   `cascade`       — removed by a foreign key as the person, their Bots, their conversations,
 *                     routines or goals go. The test reads `pg_constraint` and fails when the
 *                     cascade is not actually there: a schema file can say `onDelete: "cascade"`
 *                     and the migration can have forgotten it.
 *   `pseudonymised` — the row stays and the column naming them is re-pointed at the pseudonym.
 *   `deployment`    — the row is the deployment's, holds nothing of the person, and stays.
 *   `transient`     — expires on its own and holds nothing that names a person.
 */
export type TableLifecycle = {
  exported: string | null;
  deletion:
    | "deleted"
    | "cascade"
    | "pseudonymised"
    | "deployment"
    | "transient";
  /** The key of `DeletionResult.counts` the trail carries, for a `deleted` table. */
  counted?: string;
  why?: string;
};

export const TABLE_LIFECYCLE: Readonly<Record<string, TableLifecycle>> = {
  // ---- core ----
  users: { exported: "profile", deletion: "deleted", counted: "user" },
  user_roles: { exported: "profile", deletion: "deleted", counted: "roles" },
  sessions: {
    exported: null,
    deletion: "deleted",
    counted: "sessions",
    why: "a session token is a key to the account, never something to put in a file",
  },
  accounts: {
    exported: null,
    deletion: "deleted",
    counted: "authAccounts",
    why: "the sign-in provider's tokens and password hash",
  },
  verifications: {
    exported: null,
    deletion: "transient",
    why: "better-auth's OAuth state for a sign-in in progress: a random identifier, minutes long",
  },
  deployment_packages: { exported: null, deletion: "deployment" },
  agents: { exported: "bots", deletion: "deleted", counted: "bots" },
  channels: { exported: "channels", deletion: "deleted", counted: "channels" },
  channel_memberships: {
    exported: "channels",
    deletion: "deleted",
    counted: "channelMemberships",
  },
  channel_agents: { exported: "channels", deletion: "cascade" },
  channel_threads: {
    exported: "conversations",
    deletion: "deleted",
    counted: "threads",
  },
  credentials: {
    exported: null,
    deletion: "deleted",
    counted: "vaultTokens",
    why: "the vault: a person's `mcp_user_token` rows go by name; the deployment's own keys stay",
  },
  audit_events: {
    exported: "auditEvents",
    deletion: "pseudonymised",
    why: "append-only by trigger; `actor_user_id` is re-pointed, the rows stay a year",
  },
  // ---- the Bot's notebook ----
  agent_profiles: { exported: "bots", deletion: "cascade" },
  agent_preferences: {
    exported: "botPreferences",
    deletion: "deleted",
    counted: "botPreferences",
  },
  agent_memories: {
    exported: "memories",
    deletion: "deleted",
    counted: "memories",
  },
  agent_guidance: { exported: "guidance", deletion: "cascade" },
  agent_memory_receipts: { exported: "memoryReceipts", deletion: "cascade" },
  // ---- conversations and what ran ----
  laf_thread_messages: {
    exported: "conversations",
    deletion: "deleted",
    counted: "threadMessages",
  },
  laf_conversation_contexts: {
    exported: null,
    deletion: "deleted",
    counted: "conversationContexts",
    why: "a frozen copy of what the conversation was told, assembled from the memories and messages that are in the file already",
  },
  laf_thread_runs: { exported: "runs", deletion: "deleted", counted: "runs" },
  laf_attachments: {
    exported: "attachments",
    deletion: "deleted",
    counted: "attachments",
  },
  laf_answer_ratings: {
    exported: "answerRatings",
    deletion: "deleted",
    counted: "answerRatings",
  },
  // ---- routines, 소식, 목표 ----
  laf_routines: {
    exported: "routines",
    deletion: "deleted",
    counted: "routines",
  },
  laf_routine_runs: {
    exported: "routineRuns",
    deletion: "deleted",
    counted: "routineRuns",
  },
  laf_routine_notepads: { exported: "routineNotepads", deletion: "cascade" },
  laf_routine_suggestion_dismissals: {
    exported: "suggestionDismissals",
    deletion: "cascade",
  },
  laf_feed_posts: {
    exported: "feedPosts",
    deletion: "deleted",
    counted: "feedPosts",
  },
  laf_goals: { exported: "goals", deletion: "deleted", counted: "goals" },
  laf_goal_entries: { exported: "goalEntries", deletion: "cascade" },
  // ---- what reached them, and what they told us ----
  laf_notifications: { exported: "notifications", deletion: "cascade" },
  laf_site_connections: { exported: "siteConnections", deletion: "cascade" },
  laf_feedback: { exported: "feedback", deletion: "cascade" },
  laf_saved_logins: {
    exported: "savedLogins",
    deletion: "deleted",
    counted: "savedLogins",
  },
  // ---- connected services ----
  mcp_user_credentials: { exported: "connectedAccounts", deletion: "cascade" },
  laf_partner_connections: {
    exported: "partnerConnections",
    deletion: "cascade",
  },
  laf_alimtalk_templates: {
    exported: "alimtalkTemplates",
    deletion: "cascade",
  },
  // ---- the person's own instructions and allowances ----
  skills: { exported: "skills", deletion: "deleted", counted: "skills" },
  computer_standing_approvals: {
    exported: "standingApprovals",
    deletion: "deleted",
    counted: "standingApprovals",
  },
  plugin_grants: {
    exported: null,
    deletion: "cascade",
    why: "a Bot's hold on a plugin: nothing of the person but `granted_by`, which is pseudonymised",
  },
  component_exclusions: {
    exported: null,
    deletion: "cascade",
    why: "a Bot's rule; `withheld_by` is pseudonymised",
  },
  // ---- the deployment's own rows, where a `*_by` column held the address ----
  action_policy: { exported: null, deletion: "pseudonymised" },
  components: { exported: null, deletion: "pseudonymised" },
  component_functions: { exported: null, deletion: "pseudonymised" },
  mcp_servers: { exported: null, deletion: "pseudonymised" },
  mcp_tools: { exported: null, deletion: "deployment" },
  sandboxed_components: { exported: null, deletion: "pseudonymised" },
};

/**
 * The tables a cascade may hang off: the person's row and what the deletion removes by name.
 * A `cascade` entry must reach one of these through `ON DELETE CASCADE` keys, possibly through
 * another `cascade` table (`laf_goal_entries` → `laf_goals`).
 */
export function cascadeAnchors(): Set<string> {
  const anchors = new Set<string>(["users"]);
  for (const [table, lifecycle] of Object.entries(TABLE_LIFECYCLE)) {
    if (lifecycle.deletion === "deleted") anchors.add(table);
  }
  return anchors;
}
