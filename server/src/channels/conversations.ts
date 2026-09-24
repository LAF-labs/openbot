/**
 * Starting a conversation: the one a Bot already has, or a new channel with its own thread.
 */
import {
  AgentNotFoundError,
  type AgentProfileStore,
} from "../agents/profile-store";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
} from "../db/schema";
import type { Executor } from "../runner/thread-store";
import { soloConversationOf } from "./solo-channel";
import type { ThreadIdentity } from "./thread-identity";
import type { AgentChannel } from "./types";

const PRIVATE_AGENT_CHANNEL_DESCRIPTION = "Private agent channel.";
const MAX_CHANNEL_NAME_CODE_POINTS = 120;

/**
 * A conversation is named after who is in it — its Bot — and cut to fit a roster row.
 *
 * Cut by code points rather than UTF-16 units, so a name ending in an emoji is never split in half.
 */
export function channelName(names: string[]) {
  const joined = names.join(", ");
  const codePoints = Array.from(joined);
  if (codePoints.length <= MAX_CHANNEL_NAME_CODE_POINTS) return joined;
  return `${codePoints.slice(0, MAX_CHANNEL_NAME_CODE_POINTS - 1).join("")}…`;
}

export type ConversationDeps = {
  database: Database;
  profileStore: AgentProfileStore;
  threadIdentity: ThreadIdentity;
};

export function createConversation(
  { database, profileStore, threadIdentity }: ConversationDeps,
  actor: AgentActor,
  agentIds: string[],
): Promise<AgentChannel> {
  return database.transaction(
    async (transaction) => {
      const profilesById = await lockProfiles(
        transaction,
        profileStore,
        actor,
        agentIds,
      );

      /*
       * ONE CONVERSATION PER BOT, AND THIS IS WHERE THAT IS DECIDED.
       *
       * A Bot here is a colleague with a face, a standing role, its own routines and its own
       * seat at the account's computer — and every other table in this server is keyed on it:
       * policy identity, approvals, repetition counts, credentials, the audit trail. The
       * conversation was the one thing that was not, so every message from Home minted a fresh
       * channel and the roster filled up with the same colleague over and over. Three Bots had
       * thirteen channels between them, nine of them the same Bot.
       *
       * So a request for a single Bot resolves to that Bot's conversation if it has one. Inside
       * the transaction, after the profile lock above, so two sends racing from two tabs cannot
       * each decide there is no channel and make one.
       *
       * A request names one Bot: the route refuses more (`laf:channel_one_bot`) since rooms were
       * removed on 2026-09-24. The list shape is what the store has always taken.
       */
      const soleAgentId = agentIds.length === 1 ? agentIds[0] : undefined;
      if (soleAgentId) {
        const existing = await soloConversationOf(
          transaction,
          actor.id,
          soleAgentId,
        );
        if (existing) {
          return {
            id: existing.channelId,
            name: existing.name,
            agentIds,
            threadId: existing.threadId,
            active: true,
          };
        }
      }

      return insertConversation(
        transaction,
        threadIdentity,
        actor,
        agentIds,
        profilesById,
      );
    },
    { isolationLevel: "read committed" },
  );
}

/**
 * Every Bot the conversation will hold, read and locked on the caller's transaction.
 *
 * Validated on this transaction, not through `profileStore.get`: the read has to share the
 * connection this transaction already holds, and has to hold the profile so an agent cannot be
 * deleted between passing the check and being linked to the new channel.
 *
 * Locks are taken in agent-ID order. Two channels selecting the same pair of agents in opposite
 * orders would otherwise be able to deadlock against each other.
 */
async function lockProfiles(
  transaction: Executor,
  profileStore: AgentProfileStore,
  actor: AgentActor,
  agentIds: readonly string[],
): Promise<Map<string, AgentProfile>> {
  const profilesById = new Map<string, AgentProfile>();
  for (const agentId of [...agentIds].sort()) {
    const profile = await profileStore.getWithin(transaction, actor, agentId);
    if (!profile) throw new AgentNotFoundError(agentId);
    profilesById.set(agentId, profile);
  }
  return profilesById;
}

/** The channel, its one member, its Bots and the member's thread, written together. */
async function insertConversation(
  transaction: Executor,
  threadIdentity: ThreadIdentity,
  actor: AgentActor,
  agentIds: string[],
  profilesById: ReadonlyMap<string, AgentProfile>,
): Promise<AgentChannel> {
  const id = `channel_${crypto.randomUUID()}`;
  // Minted rather than a bare random id, so the thread says which deployment it belongs to
  // in a project that may hold more than one. See thread-identity.ts.
  const threadId = threadIdentity.mint();
  // Named from the caller's ordering, which is the order the channel presents its agents in.
  const name = channelName(
    agentIds.map((agentId) => {
      const profile = profilesById.get(agentId);
      if (!profile) throw new AgentNotFoundError(agentId);
      return profile.name;
    }),
  );

  await transaction.insert(channels).values({
    id,
    name,
    description: PRIVATE_AGENT_CHANNEL_DESCRIPTION,
  });
  await transaction.insert(channelMemberships).values({
    channelId: id,
    userId: actor.id,
  });
  await transaction
    .insert(channelAgents)
    .values(agentIds.map((agentId) => ({ channelId: id, agentId })));
  await transaction.insert(channelThreads).values({
    userId: actor.id,
    channelId: id,
    threadId,
  });

  return { id, name, agentIds, threadId, active: true };
}
