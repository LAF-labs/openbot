/**
 * A person leaving, and everything that has to be true afterwards.
 *
 * THE HARD-DELETE PATH THE FOREIGN KEYS WERE WRITTEN FOR. Normal deletion in this product is soft:
 * a Bot gets `agent_profiles.deleted_at` and stays in the database (`agents/profile-store.ts`), and
 * several of the cascades added over the last month carry comments saying "this fires only on the
 * hard-delete path, which nothing in `src` takes today". This is that path. It is the first caller
 * those cascades have ever had, which is exactly why the order below is written out rather than
 * left to the database to work out.
 *
 * WHAT THE DATABASE DOES ON ITS OWN when `users` goes, and what it does NOT:
 *
 *   cascade  sessions.user_id, accounts.user_id, user_roles.user_id,
 *            channel_memberships.user_id, channel_threads.user_id,
 *            agent_preferences.user_id, agent_memories.owner_user_id,
 *            mcp_user_credentials.user_id, skills.owner_user_id,
 *            laf_notifications.user_id  ← the outbox is addressed to a person and is worth
 *                                         nothing without them (migration 0029)
 *            laf_feedback.user_id       ← what they wrote to the operator is theirs (migration 0037)
 *   SET NULL agent_profiles.owner_user_id  ← a Bot would survive its owner, unowned and running
 *            laf_routines.created_by_id    ← deliberate: a routine outlives its author (see laf.ts)
 *
 * and when a Bot (`agents`) goes:
 *
 *   cascade  agent_profiles, agent_preferences, agent_memories, channel_agents, plugin_grants,
 *            component_exclusions, computer_standing_approvals, laf_routines
 *            (and laf_routine_runs behind laf_routines)
 *   SET NULL laf_thread_runs.agent_id, channels.last_message_agent_id
 *
 * NO FOREIGN KEY AT ALL, so this module is the only thing that will ever remove them:
 *
 *   - `laf_thread_messages` — `thread_id` is an id this deployment mints, not a row. Deleting the
 *     person deletes `channel_threads`, and the messages behind those threads would be left as what
 *     §3.5 of the redesign note calls "주소 없는 전문": a full transcript with nobody's name on it
 *     and nothing left that could ever say whose it was.
 *   - `channels` — membership is the only relationship a channel has to a person. A channel with no
 *     members left is removed here; one that still has another member is not.
 *   - `laf_thread_runs.user_id` — plain text, no key.
 *   - `audit_events.actor_user_id` — no key on purpose (the trail is append-only, so a cascade
 *     would be an UPDATE the trigger refuses and nobody who had ever acted could be deleted).
 *     Pseudonymised rather than deleted; see `pseudonym.ts` and migration 0028.
 *   - `credentials.key_id` for an `mcp_user_token` — the vault holds the person's id there, and
 *     `retireConnectionsFor` revokes on that basis. The rows themselves are removed here, after the
 *     join rows that reference them are gone.
 *   - every `*_by` column on a deployment-level row — `mcp_servers.added_by`, `skills.installed_by`,
 *     `components.updated_by`, `component_exclusions.withheld_by`, `component_functions.granted_by`,
 *     `sandboxed_components.authored_by`, `plugin_grants.granted_by`,
 *     `action_policy.updated_by`, `computer_standing_approvals.granted_by`/`revoked_by`. Most of
 *     these hold an EMAIL ADDRESS, not an id, which is the reason they are here at all: deleting the
 *     `users` row would otherwise leave the person's address written across a dozen rows that
 *     nothing cascades from. They are overwritten with the same pseudonym the trail gets.
 *
 * WHAT DELIBERATELY REMAINS: the audit rows themselves, under `deleted-<hash>`, and any address of
 * theirs written INSIDE an audit payload before they left. The payload is not editable — migration
 * 0028's exit permits `actor_user_id` and refuses every other column, which is the property that
 * keeps the trail worth having — so those age out with the retention job instead, within a year.
 * `docs/laf/data-lifecycle.md` says so in the person's own language rather than implying otherwise.
 */
import { type AnyColumn, and, eq, inArray, or, sql } from "drizzle-orm";
import { recordAuditEvent } from "../audit";
import type { ComputerClient } from "../computer/client";
import type { Database } from "../db/client";
import {
  accounts,
  actionPolicy,
  agentMemories,
  agentPreferences,
  agentProfiles,
  agents,
  auditEvents,
  channelMemberships,
  channels,
  channelThreads,
  componentExclusions,
  componentFunctions,
  components,
  computerStandingApprovals,
  credentials,
  lafRoutineRuns,
  lafRoutines,
  lafThreadMessages,
  lafThreadRuns,
  mcpServers,
  pluginGrants,
  sandboxedComponents,
  sessions,
  skills,
  userRoles,
  users,
} from "../db/schema";
import { describeFailure } from "../failure-text";
import { countAccounts, type FleetNotifier } from "../fleet/notify";
import { pseudonymFor } from "./pseudonym";

/** How many rows each part of the deletion actually removed. Written into the trail as it stands. */
export type DeletionCounts = Record<string, number>;

export type DeletionResult = {
  deleted: boolean;
  /** The name in the trail from here on. */
  pseudonym: string;
  counts: DeletionCounts;
  /** Which Bots' browser profiles were wiped, and whether the computer could be reached at all. */
  computers: { reset: string[]; failed: string[]; configured: boolean };
};

export type AccountDeletionDependencies = {
  database: Database;
  /** Absent on a deployment with no plugin store: nothing to retire, and the trail says so. */
  retireConnectionsFor?: (
    userId: string,
    by: string,
  ) => Promise<{ retired: number }>;
  /**
   * The partner registrations, retired the same way and for a sharper reason.
   *
   * `laf_partner_connections` cascades on the user row, so a completed deletion removes it either
   * way. This is here for the case the cascade does not cover: a withdrawal that stops short — a VM
   * that outlives the person for a billing cycle, a deletion that fails halfway — leaves a row this
   * deployment would go on sending 알림톡 with, as their channel. "We removed their access" has to
   * be true of the thing that matters, and here that is the 발신프로필 rather than the person row.
   *
   * Absent on a deployment with no partner runtime, which is most of them.
   */
  retirePartnersFor?: (
    userId: string,
    by: string,
  ) => Promise<{ retired: number }>;
  /**
   * The Bot's browser. Absent means no computer is configured, which is recorded rather than
   * silently treated as "nothing to wipe" — the profile volume may still exist on a host that has
   * simply lost its configuration, and an audit row claiming a clean wipe would be a lie.
   */
  computerClient?: ComputerClient;
  /**
   * The fleet tool, which is the only thing that can destroy the machine this runs on.
   *
   * Absent on a deployment that was never told where the fleet is — a laptop, or a VM whose `.env`
   * has no `LAF_FLEET_WEBHOOK_URL`. There the withdrawal is complete here and nowhere else, which
   * is why the absence gets a line at boot instead of being silent (see `fleet/notify.ts`).
   */
  fleet?: FleetNotifier;
};

export type AccountDeletion = {
  delete: (input: {
    userId: string;
    /** Who pressed it: the person themselves, or an administrator. */
    by: string;
  }) => Promise<DeletionResult>;
};

export function createAccountDeletion(
  dependencies: AccountDeletionDependencies,
): AccountDeletion {
  const {
    database,
    retireConnectionsFor,
    retirePartnersFor,
    computerClient,
    fleet,
  } = dependencies;

  return {
    async delete({ userId, by }) {
      const pseudonym = pseudonymFor(userId);

      const [person] = await database
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!person) {
        return {
          deleted: false,
          pseudonym,
          counts: {},
          computers: {
            reset: [],
            failed: [],
            configured: Boolean(computerClient),
          },
        };
      }

      const ownedBots = await database
        .select({ agentId: agentProfiles.agentId })
        .from(agentProfiles)
        .where(eq(agentProfiles.ownerUserId, userId));
      const botIds = ownedBots.map((row) => row.agentId);

      /*
       * THE COOKIES ON DISK, BEFORE THE ROWS THAT NAME THEM.
       *
       * A Bot's Chromium profile lives in the `agent-profiles` volume under the Bot's id and holds
       * the person's logins to their bank, their marketplace and their tax office. No amount of
       * deleting rows touches it. `computers/reset` is the call that does, and it is addressed
       * per Bot through `forBot`, which sets `x-openbot-bot-id` — a query string would silently
       * reset the DEFAULT profile, which is somebody else's or nobody's (CLAUDE.md).
       *
       * First, because after the rows are gone there is no list of Bot ids left to reset.
       */
      const reset: string[] = [];
      const failed: string[] = [];
      if (computerClient) {
        for (const botId of botIds) {
          try {
            await computerClient.forBot(botId).resetComputer();
            reset.push(botId);
          } catch {
            // Recorded, not thrown. A computer that is down must not leave the account half-deleted
            // — the rows still have to go, and the trail has to say the profile did not.
            failed.push(botId);
          }
        }
      }

      /*
       * The vault, through the store that owns it. `retireConnectionsFor` revokes each
       * `mcp_user_token` and removes the join rows; it is NOT reimplemented here, because it also
       * writes the `mcp.account_disconnected` rows and knows the one thing that is easy to get
       * wrong — the credential is found through `credentials.key_id`, not through the join table,
       * which cascades away the moment the user row does.
       *
       * Under the pseudonym, so the disconnection rows it writes do not name somebody who is in the
       * middle of ceasing to exist.
       */
      const retired = retireConnectionsFor
        ? await retireConnectionsFor(userId, pseudonym)
        : { retired: 0 };

      /*
       * And the partner registrations, before the row they hang off is deleted.
       *
       * Ahead of the cascade rather than instead of it: what this adds is the audit row saying the
       * 카카오톡 채널 stopped being reachable from here, and — for a withdrawal that does not finish
       * — that it stopped at all. See the field's own note.
       */
      const partnersRetired = retirePartnersFor
        ? await retirePartnersFor(userId, pseudonym)
        : { retired: 0 };

      const counts = await database.transaction(async (transaction) => {
        const tally: DeletionCounts = {};
        const record = (name: string, rows: { length: number }) => {
          tally[name] = rows.length;
        };

        // The threads this person holds, and the messages behind them. Read before the rows that
        // name them go; `laf_thread_messages` has no key back to anything.
        const heldThreads = await transaction
          .select({ threadId: channelThreads.threadId })
          .from(channelThreads)
          .where(eq(channelThreads.userId, userId));
        const threadIds = heldThreads.map((row) => row.threadId);

        /*
         * Deleted here rather than through `runner/thread-store.ts`. That module is the one WRITER
         * and the one reader, and it has no deleter — adding one would put a "remove every message"
         * function next to the append path, which is a bigger hazard than this one narrowed
         * statement. The narrowing is the safety: an explicit list of thread ids belonging to one
         * person, never a predicate.
         */
        record(
          "threadMessages",
          threadIds.length
            ? await transaction
                .delete(lafThreadMessages)
                .where(inArray(lafThreadMessages.threadId, threadIds))
                .returning({ seq: lafThreadMessages.seq })
            : [],
        );

        const memberOf = await transaction
          .select({ channelId: channelMemberships.channelId })
          .from(channelMemberships)
          .where(eq(channelMemberships.userId, userId));
        const channelIds = memberOf.map((row) => row.channelId);

        record(
          "threads",
          await transaction
            .delete(channelThreads)
            .where(eq(channelThreads.userId, userId))
            .returning({ threadId: channelThreads.threadId }),
        );
        record(
          "channelMemberships",
          await transaction
            .delete(channelMemberships)
            .where(eq(channelMemberships.userId, userId))
            .returning({ channelId: channelMemberships.channelId }),
        );

        /*
         * A channel is removed only once nobody is left in it.
         *
         * There is no owner column, so "their channel" is "a channel they were in". On this
         * deployment shape that is every channel — one VM, one person — but the rule is written the
         * careful way round, because the failure of the careless one is deleting a conversation out
         * from under somebody who is still using it.
         */
        const stillHeld = channelIds.length
          ? await transaction
              .select({ channelId: channelMemberships.channelId })
              .from(channelMemberships)
              .where(inArray(channelMemberships.channelId, channelIds))
          : [];
        const kept = new Set(stillHeld.map((row) => row.channelId));
        const emptied = channelIds.filter((id) => !kept.has(id));
        record(
          "channels",
          emptied.length
            ? await transaction
                .delete(channels)
                .where(inArray(channels.id, emptied))
                .returning({ id: channels.id })
            : [],
        );

        // Theirs by authorship OR by the Bot it drives, the same rule `routines/service.ts` reads.
        const ownedRoutines = await transaction
          .select({ id: lafRoutines.id })
          .from(lafRoutines)
          .where(
            botIds.length
              ? or(
                  eq(lafRoutines.createdById, userId),
                  inArray(lafRoutines.agentId, botIds),
                )
              : eq(lafRoutines.createdById, userId),
          );
        const routineIds = ownedRoutines.map((row) => row.id);
        record(
          "routineRuns",
          routineIds.length
            ? await transaction
                .delete(lafRoutineRuns)
                .where(inArray(lafRoutineRuns.routineId, routineIds))
                .returning({ id: lafRoutineRuns.id })
            : [],
        );
        record(
          "routines",
          routineIds.length
            ? await transaction
                .delete(lafRoutines)
                .where(inArray(lafRoutines.id, routineIds))
                .returning({ id: lafRoutines.id })
            : [],
        );

        record(
          "runs",
          await transaction
            .delete(lafThreadRuns)
            .where(eq(lafThreadRuns.userId, userId))
            .returning({ runId: lafThreadRuns.runId }),
        );
        record(
          "skills",
          await transaction
            .delete(skills)
            .where(eq(skills.ownerUserId, userId))
            .returning({ id: skills.id }),
        );
        record(
          "standingApprovals",
          botIds.length
            ? await transaction
                .delete(computerStandingApprovals)
                .where(inArray(computerStandingApprovals.botId, botIds))
                .returning({ id: computerStandingApprovals.id })
            : [],
        );
        record(
          "memories",
          await transaction
            .delete(agentMemories)
            .where(eq(agentMemories.ownerUserId, userId))
            .returning({ id: agentMemories.id }),
        );
        record(
          "botPreferences",
          await transaction
            .delete(agentPreferences)
            .where(eq(agentPreferences.userId, userId))
            .returning({ agentId: agentPreferences.agentId }),
        );
        // And the Bots themselves, which takes their profiles, grants and exclusions with them.
        record(
          "bots",
          botIds.length
            ? await transaction
                .delete(agents)
                .where(inArray(agents.id, botIds))
                .returning({ id: agents.id })
            : [],
        );

        /*
         * The trail, through the one exit migration 0028 opened. An ordinary UPDATE here is refused
         * by `audit_events_append_only`, which is the point: the trail can be re-pointed at a
         * pseudonym and cannot be rewritten.
         */
        const [moved] = [
          ...(await transaction.execute<{ moved: string | number }>(
            sql`select audit_pseudonymise_actor(${userId}, ${pseudonym}) as moved`,
          )),
        ];
        tally.auditEventsPseudonymised = Number(moved?.moved ?? 0);

        /*
         * The columns that hold an address rather than an id, on rows nothing cascades from.
         *
         * Both spellings are matched — the id and the email — because these columns were filled by
         * different callers at different times and there is no single answer to "what does `*_by`
         * hold". Overwritten with the same pseudonym the trail carries, so a reader can still see
         * that one person did all of it.
         */
        const wasThem = (column: AnyColumn) =>
          or(eq(column, userId), eq(column, person.email));
        const scrub = async (
          name: string,
          run: () => Promise<{ length: number }>,
        ) => {
          tally[name] = (await run()).length;
        };
        await scrub("mcpServersAddedBy", () =>
          transaction
            .update(mcpServers)
            .set({ addedBy: pseudonym })
            .where(wasThem(mcpServers.addedBy))
            .returning({ id: mcpServers.id }),
        );
        await scrub("skillsInstalledBy", () =>
          transaction
            .update(skills)
            .set({ installedBy: pseudonym })
            .where(wasThem(skills.installedBy))
            .returning({ id: skills.id }),
        );
        await scrub("pluginGrantsGrantedBy", () =>
          transaction
            .update(pluginGrants)
            .set({ grantedBy: pseudonym })
            .where(wasThem(pluginGrants.grantedBy))
            .returning({ ref: pluginGrants.ref }),
        );
        await scrub("componentsUpdatedBy", () =>
          transaction
            .update(components)
            .set({ updatedBy: pseudonym })
            .where(wasThem(components.updatedBy))
            .returning({ name: components.name }),
        );
        await scrub("componentExclusionsWithheldBy", () =>
          transaction
            .update(componentExclusions)
            .set({ withheldBy: pseudonym })
            .where(wasThem(componentExclusions.withheldBy))
            .returning({ agentId: componentExclusions.agentId }),
        );
        await scrub("componentFunctionsGrantedBy", () =>
          transaction
            .update(componentFunctions)
            .set({ grantedBy: pseudonym })
            .where(wasThem(componentFunctions.grantedBy))
            .returning({ functionName: componentFunctions.functionName }),
        );
        await scrub("sandboxedComponentsBy", () =>
          transaction
            .update(sandboxedComponents)
            .set({ authoredBy: pseudonym })
            .where(wasThem(sandboxedComponents.authoredBy))
            .returning({ name: sandboxedComponents.name }),
        );
        await scrub("actionPolicyUpdatedBy", () =>
          transaction
            .update(actionPolicy)
            .set({ updatedBy: pseudonym })
            .where(wasThem(actionPolicy.updatedBy))
            .returning({ id: actionPolicy.id }),
        );
        await scrub("standingApprovalsGrantedBy", () =>
          transaction
            .update(computerStandingApprovals)
            .set({ grantedBy: pseudonym })
            .where(wasThem(computerStandingApprovals.grantedBy))
            .returning({ id: computerStandingApprovals.id }),
        );
        await scrub("standingApprovalsRevokedBy", () =>
          transaction
            .update(computerStandingApprovals)
            .set({ revokedBy: pseudonym })
            .where(wasThem(computerStandingApprovals.revokedBy))
            .returning({ id: computerStandingApprovals.id }),
        );

        /*
         * The vault rows themselves, now that `retireConnectionsFor` has revoked them and removed
         * the `mcp_user_credentials` rows that referenced them. `mcp_servers.credential_id` is
         * `restrict` and points at the deployment's OAuth CLIENT, never at a person's token, so
         * nothing here can pull a server's credential out from under it.
         */
        record(
          /*
           * NOT called `credentials`. `redactAuditPayload` replaces any key that normalises to
           * `credential`, `credentials`, `token` or `tokens` with `[REDACTED]`, which is right for a
           * payload carrying a secret and wrong for one carrying a count — the row would say this
           * deployment removed `[REDACTED]` vault rows, which is not a fact anybody can use.
           */
          "vaultTokens",
          await transaction
            .delete(credentials)
            .where(
              and(
                eq(credentials.kind, "mcp_user_token"),
                eq(credentials.keyId, userId),
              ),
            )
            .returning({ id: credentials.id }),
        );

        record(
          "sessions",
          await transaction
            .delete(sessions)
            .where(eq(sessions.userId, userId))
            .returning({ id: sessions.id }),
        );
        record(
          "authAccounts",
          await transaction
            .delete(accounts)
            .where(eq(accounts.userId, userId))
            .returning({ id: accounts.id }),
        );
        record(
          "roles",
          await transaction
            .delete(userRoles)
            .where(eq(userRoles.userId, userId))
            .returning({ role: userRoles.role }),
        );

        tally.connectionsRetired = retired.retired;
        tally.partnersRetired = partnersRetired.retired;

        /*
         * THE ROW THAT SAYS IT HAPPENED, WRITTEN BEFORE THE PERSON IS GONE AND UNDER THEIR
         * PSEUDONYM.
         *
         * Under the pseudonym rather than under their id, because the id is about to stop referring
         * to anybody and a row written under it would be the one row the pseudonymisation above
         * just missed — it did not exist when that statement ran. Same string, so the deletion row
         * sits in the trail alongside everything else they ever did.
         *
         * Before the `users` row, so the fact and the deletion commit together: a crash between the
         * two is a transaction that rolls back whole, not an account that vanished silently.
         */
        await recordAuditEvent(
          // Written on the TRANSACTION, not through the pooled audit store: a row written on the
          // pool would land outside this transaction and survive a rollback — a deployment
          // claiming it deleted an account that is still there.
          { insert: (event) => transaction.insert(auditEvents).values(event) },
          {
            eventType: "account.deleted",
            targetType: "user",
            targetId: pseudonym,
            actorUserId: pseudonym,
            payload: {
              by: by === userId ? "themselves" : pseudonymFor(by),
              counts: tally,
              computers: {
                configured: Boolean(computerClient),
                reset: reset.length,
                failed: failed.length,
                // Said out loud: a deployment with no computer configured did not wipe a profile
                // volume that may still be sitting on the host.
                note: computerClient
                  ? failed.length === 0
                    ? "every profile wiped"
                    : "some profiles could not be wiped"
                  : "no computer configured, no profile wiped",
              },
            },
          },
        );

        record(
          "user",
          await transaction
            .delete(users)
            .where(eq(users.id, userId))
            .returning({ id: users.id }),
        );

        return tally;
      });

      /*
       * THE FLEET, TOLD AFTER THE COMMIT AND NEVER BEFORE.
       *
       * A VM is destroyed when the last person on it withdraws, and the thing that destroys it is
       * somewhere else. `remainingAccounts` is counted here — after the transaction, so the row
       * just deleted is genuinely gone from the count — because zero is what tells the fleet this
       * machine has nobody left, and a count taken a moment earlier says one.
       *
       * Wrapped even though the notifier's own contract is never to throw. What is being protected
       * is the person, not the notifier: everything above has already committed, so an exception
       * raised from here would answer a completed withdrawal with a 500 and leave somebody
       * believing their account is still there.
       */
      if (fleet) {
        try {
          await fleet.notify({
            event: "account.deleted",
            actor: pseudonym,
            remainingAccounts: await countAccounts(database),
          });
        } catch (error) {
          console.error(
            "[fleet] a withdrawal could not be reported:",
            describeFailure(error),
          );
        }
      }

      return {
        deleted: true,
        pseudonym,
        counts,
        computers: { reset, failed, configured: Boolean(computerClient) },
      };
    },
  };
}
