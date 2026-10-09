import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
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
 * Where the Bots a person made are dialled. Two answers, and a loader is not built without one.
 *
 * NO DEFAULT, ON PURPOSE (the independent read of #121). This was an optional argument, and left
 * out it meant the open setting: each Bot dialled where its row says, with its key. The agent routes
 * default shut (`routes.ts`); a second caller of the loader that forgot the argument would have
 * reopened the door for every row from before the upgrade. The compiler asks each caller now, and
 * a caller that gets past the compiler is refused when the loader is made.
 */
export type BotsRunAt =
  /** A hosted deployment: every Bot at the deployment's own agent, whatever its row holds. */
  | { home: URL }
  /** A developer's stack: each Bot where its row says, with the key stored for it. */
  | "where each row says";

/**
 * Read the agents one person may run, on every request.
 *
 * The filtering is in the query, not in JavaScript afterwards: a private coworker must never be
 * read into the process for an actor who cannot see it, and "we fetched it but did not show it" is
 * the shape most accidental disclosures take.
 */
export function createRuntimeAgentLoader(
  database: Database,
  /**
   * `{ home }` on a HOSTED deployment, and only there: the deployment's own agent
   * (`config.managedAgentAgUiUrl`), where every Bot is then dialled whatever its row holds.
   *
   * A hosted deployment takes no endpoint of a person's own for a Bot (the owner, 2026-10-06;
   * `agents/routes.ts` refuses one). That alone leaves every Bot pointed elsewhere BEFORE the
   * upgrade exactly where it was — answered by a server this deployment does not run, whose usage
   * and whose endings it files as fact — with the screen that could point it back no longer drawn.
   * This is the one place a row's address and key become the agent a run dials, so this is where
   * such a Bot comes home. The row is not rewritten: it still says what somebody once set, and a
   * boot says how many do (`botsHeldElsewhere`).
   *
   * WHATEVER THE ROW HOLDS, NOTHING INCLUDED. A configuration is an address and a key's reference
   * and nothing else, and neither is read to dial a Bot — so a row whose configuration names
   * nothing a run could dial, which a developer's stack skips, is a Bot that runs at home like
   * any other. There is no screen left on a hosted deployment that could repair one. (The one
   * reader of a row's address there is the boot's count, which compares it in SQL:
   * `botsHeldElsewhere`.)
   *
   * AND NO STORED KEY GOES WITH IT. The key in the vault is a person's bearer token for THEIR
   * server; sent to ours it would be a credential delivered to a service it was never meant for.
   * It is not read at all.
   *
   * `"where each row says"` — a developer's stack, where the private-host opt-in is set — and a
   * Bot is dialled where its row says, with its key, as it always was.
   */
  botsRunAt: BotsRunAt,
  /** Resolves a customer agent's key at load time. Absent means no agent can carry one. */
  vault?: { reader: CredentialSecretReader; encryptionKey: string },
) {
  const hosted = botsRunAt === "where each row says" ? undefined : botsRunAt;
  // Anything that is neither answer is no answer, and no answer is not the open one.
  if (botsRunAt !== "where each row says" && !(hosted?.home instanceof URL)) {
    throw new TypeError(
      'createRuntimeAgentLoader must be told where Bots run: { home } on a hosted deployment, or "where each row says" on a developer\'s stack.',
    );
  }
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
        // Home, on a hosted deployment, in place of whatever the row holds: who the Bot is comes
        // from the row, and where it runs does not.
        ...(hosted && row.type === "remote_ag_ui"
          ? { configuration: { endpoint: hosted.home.toString() } }
          : {}),
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
      // credential then takes effect on the next run rather than on the next restart. Never on a
      // hosted deployment: the row's key is for the row's address, which is not where this goes.
      if (agent.type === "remote_ag_ui" && vault && !hosted) {
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
 * The Bots whose rows hold an address other than the deployment's own agent — the ones a hosted
 * deployment dials at home all the same (`createRuntimeAgentLoader`). By id: a boot says how many
 * (`sayBooted`), and the address itself is said nowhere.
 *
 * LIVE BOTS ONLY, since a deleted one is dialled nowhere. And "other" is the row's string against
 * this deployment's address as `create` writes it, so a Bot left on an address this deployment
 * USED to answer at — a port that moved, a path that changed — is counted too: it is equally a
 * Bot whose row no longer says where it runs. A row holding no address is not one that holds
 * another.
 */
export async function botsHeldElsewhere(
  database: Database,
  home: URL,
): Promise<string[]> {
  const rows = await database
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .where(
      and(
        isNull(agentProfiles.deletedAt),
        sql`${agents.configuration}->>'endpoint' <> ${home.toString()}`,
      ),
    );
  return rows.map((row) => row.id);
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
        // Not `effort`: how hard a Bot thinks is the deployment's now (`FIXED_EFFORT`, copilot.ts).
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
 * the agent worked in is what authorizes this, not whose the Bot is, which is why deleting a
 * coworker leaves its conversations readable instead of erasing them. It does not widen anything:
 * a channel is only ever somebody's own, so the only deleted Bots this reaches are ones they
 * already talked to.
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
