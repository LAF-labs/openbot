import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { type RegisteredAgent, registeredAgentFromRow } from "../copilot";
import type { CredentialSecretReader } from "../credentials";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
} from "../db/schema";
import { agentAuthHeaders, authFromConfiguration } from "./auth-header";
import { selectGuidance } from "./guidance-store";
import {
  type CarriedMemories,
  carriedMemoriesOf,
  type MemoryRow,
  selectNotebookRows,
} from "./memory-store";
import { visibleToActor } from "./profile-policy";
import type { AgentActor } from "./profile-types";

/**
 * Read the agents one person may run, on every request.
 *
 * The filtering is in the query, not in JavaScript afterwards: a private coworker must never be
 * read into the process for an actor who cannot see it, and "we fetched it but did not show it" is
 * the shape most accidental disclosures take.
 */
export function createRuntimeAgentLoader(
  database: Database,
  /** Resolves a customer agent's key at load time. Absent means no agent can carry one. */
  vault?: { reader: CredentialSecretReader; encryptionKey: string },
) {
  return async (actor: AgentActor): Promise<RegisteredAgent[]> => {
    const [active, tombstones] = await Promise.all([
      selectActiveAgents(database, actor),
      selectTombstoneAgents(database, actor),
    ]);

    // One query for every Bot rather than one per Bot: this runs on every single turn, and a
    // round trip per coworker is a cost the person pays as latency before anything is answered.
    const [remembered, guidance] = await Promise.all([
      selectMemories(
        database,
        actor,
        active.map((row) => row.id),
      ),
      // How the owner likes to work: drawn in the frozen layer only (`agents/dream.ts`).
      selectGuidance(
        database,
        active.map((row) => row.id),
        actor.id,
      ),
    ]);

    // A row whose configuration cannot be understood is skipped rather than mounted as a broken
    // agent. Tombstones are appended after, and never overwrite a live agent of the same id.
    const registered = new Map<string, RegisteredAgent>();
    for (const row of active) {
      const carried = remembered.get(row.id);
      const agent = registeredAgentFromRow({
        ...row,
        memories: carried?.memories ?? [],
        // Only for a Bot holding lines: one that holds none carries nothing to tell apart.
        ...(carried
          ? {
              confirmedMemories: carried.confirmed,
              supersededMemories: carried.superseded,
              retiredMemories: carried.retired,
            }
          : {}),
        // Only for a Bot the dream or the owner gave lines: none draws nothing, as before.
        ...(guidance.get(row.id)?.length
          ? { guidance: guidance.get(row.id) }
          : {}),
      });
      if (!agent) continue;
      // The key is resolved per load, rather than being cached on the row: revoking a
      // credential then takes effect on the next run rather than on the next restart.
      if (agent.type === "remote_ag_ui" && vault) {
        const headers = await agentAuthHeaders({
          reader: vault.reader,
          encryptionKey: vault.encryptionKey,
          auth: authFromConfiguration(row.configuration),
        });
        if (headers) agent.headers = headers;
      }
      registered.set(agent.id, agent);
    }
    for (const row of tombstones) {
      if (registered.has(row.id)) continue;
      registered.set(row.id, {
        id: row.id,
        name: row.name,
        type: "unavailable",
        reason: `${row.name} has been deleted and can no longer run. Its conversations remain readable.`,
      });
    }

    return [...registered.values()];
  };
}

/**
 * What each of this person's Bots has learned about them.
 *
 * Scoped by owner as well as by Bot. On a correct deployment that is one person and the clause does
 * nothing; it is here because nothing yet enforces one person, and because a read written without
 * it is the kind that nobody notices is wrong until there is a second account.
 */
async function selectMemories(
  database: Database,
  actor: AgentActor,
  agentIds: string[],
): Promise<Map<string, CarriedMemories>> {
  const rows = await selectNotebookRows(database, agentIds, actor.id);
  const byAgent = new Map<string, MemoryRow[]>();
  for (const row of rows) {
    byAgent.set(row.agentId, [...(byAgent.get(row.agentId) ?? []), row]);
  }
  /*
   * Bounded per Bot, not across the account, and by characters rather than by a count: the count
   * of forty kept the oldest rows and dropped the newest, so a Bot with forty-one short lines saved
   * the last one and never read it (`shared/notebook.ts`, `carriedLines`).
   */
  return new Map(
    [...byAgent].map(([agentId, held]) => [agentId, carriedMemoriesOf(held)]),
  );
}

function selectActiveAgents(database: Database, actor: AgentActor) {
  return (
    database
      .select({
        id: agents.id,
        name: agents.name,
        type: agents.type,
        configuration: agents.configuration,
        roleDescription: agentProfiles.roleDescription,
        // The one model setting a Bot carries into its own run. See RegisteredRemoteAgent.effort.
        effort: agentProfiles.effort,
      })
      .from(agents)
      .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
      /*
       * The rule from profile-policy.ts, not a second copy of it.
       *
       * It WAS a second copy — the same `or(...)` written out again, with its own `admin` bypass
       * beside it — and two copies of an access rule are two things to remember to change. This
       * one mounts every Bot it returns as a runnable AG-UI agent for the turn, so an administrator
       * whose roster was unfiltered here could ask, run and brief a private Bot somebody else made.
       */
      .where(and(isNull(agentProfiles.deletedAt), visibleToActor(actor)))
  );
}

/**
 * Deleted coworkers the caller still has history with.
 *
 * Registered so the runtime can restore the thread the person is reading. Membership of a channel
 * the agent worked in is what authorizes this, not whose the Bot is. It does not widen anything:
 * a channel is only ever somebody's own, so the only deleted Bots this reaches are ones they
 * already talked to.
 *
 * ONLY BOTS DELETED BEFORE 2026-09-26. Deletion set `deleted_at` and left the conversation until
 * then; it removes the Bot, its row and its conversation now (`bot-deletion.ts`), so a Bot deleted
 * since has no history and no row for this to find. The old rows are still in deployed databases,
 * and purging them is the owner's call.
 */
function selectTombstoneAgents(database: Database, actor: AgentActor) {
  return database
    .selectDistinct({ id: agents.id, name: agents.name })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .innerJoin(channelAgents, eq(channelAgents.agentId, agents.id))
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channelAgents.channelId),
        eq(channelMemberships.userId, actor.id),
      ),
    )
    .where(isNotNull(agentProfiles.deletedAt));
}
