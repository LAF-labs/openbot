import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { type RegisteredAgent, registeredAgentFromRow } from "../copilot";
import type { CredentialSecretReader } from "../credentials";
import type { Database } from "../db/client";
import {
  agentMemories,
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
} from "../db/schema";
import { agentAuthHeaders, authFromConfiguration } from "./auth-header";
import { MAX_MEMORIES_CARRIED } from "./memory-store";
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
    const remembered = await selectMemories(
      database,
      actor,
      active.map((row) => row.id),
    );

    // A row whose configuration cannot be understood is skipped rather than mounted as a broken
    // agent. Tombstones are appended after, and never overwrite a live agent of the same id.
    const registered = new Map<string, RegisteredAgent>();
    for (const row of active) {
      const agent = registeredAgentFromRow({
        ...row,
        memories: remembered.get(row.id) ?? [],
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
): Promise<Map<string, string[]>> {
  const byAgent = new Map<string, string[]>();
  if (agentIds.length === 0) return byAgent;

  const rows = await database
    .select({
      agentId: agentMemories.agentId,
      content: agentMemories.content,
    })
    .from(agentMemories)
    .where(
      and(
        inArray(agentMemories.agentId, agentIds),
        eq(agentMemories.ownerUserId, actor.id),
        isNull(agentMemories.forgottenAt),
      ),
    )
    .orderBy(asc(agentMemories.createdAt));

  for (const row of rows) {
    const carried = byAgent.get(row.agentId) ?? [];
    // Bounded per Bot, not across the account: one talkative coworker must not spend another's
    // budget. Oldest kept, because the cap drops what is least likely to still be true.
    if (carried.length >= MAX_MEMORIES_CARRIED) continue;
    carried.push(row.content);
    byAgent.set(row.agentId, carried);
  }
  return byAgent;
}

function selectActiveAgents(database: Database, actor: AgentActor) {
  return database
    .select({
      id: agents.id,
      name: agents.name,
      type: agents.type,
      configuration: agents.configuration,
      title: agentProfiles.title,
      roleDescription: agentProfiles.roleDescription,
      // The one model setting a Bot carries into its own run. See RegisteredBuiltInAgent.effort.
      effort: agentProfiles.effort,
    })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .where(
      and(
        isNull(agentProfiles.deletedAt),
        actor.role === "admin"
          ? undefined
          : or(
              eq(agentProfiles.visibility, "public"),
              eq(agentProfiles.ownerUserId, actor.id),
            ),
      ),
    );
}

/**
 * Deleted coworkers the caller still has history with.
 *
 * Registered so the runtime can restore the thread the person is reading. Membership of a channel
 * the agent worked in is what authorizes this, not the profile's visibility, which is why deleting
 * a coworker leaves its conversations readable instead of erasing them.
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
