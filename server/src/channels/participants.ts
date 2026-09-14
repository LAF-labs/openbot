/**
 * Who is in a conversation, changed while it is going on.
 */
import { and, asc, eq } from "drizzle-orm";
import {
  AgentNotFoundError,
  type AgentProfileStore,
} from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
} from "../db/schema";
import type { Executor } from "../runner/thread-store";
import { channelName } from "./conversations";
import { ChannelMembershipError, ChannelNotFoundError } from "./errors";
import type { AgentChannel } from "./types";

/**
 * Another colleague joins the conversation that is already going on.
 *
 * The profile is locked inside the transaction exactly the way `create` locks it, so a Bot
 * cannot be deleted between passing the check and being linked. The channel's NAME is rebuilt
 * from the new membership in the same breath: the roster row is the only place a room is
 * named, and a room whose name still lists two people after a third joined is a row that lies.
 */
export async function addParticipant(
  database: Database,
  profileStore: AgentProfileStore,
  actor: AgentActor,
  channelId: string,
  agentId: string,
): Promise<AgentChannel> {
  return database.transaction(
    async (transaction) => {
      const held = await membershipOf(transaction, actor, channelId);
      if (held.agentIds.includes(agentId)) {
        throw new ChannelMembershipError("laf:already_in_room");
      }
      const profile = await profileStore.getWithin(transaction, actor, agentId);
      if (!profile) throw new AgentNotFoundError(agentId);

      await transaction.insert(channelAgents).values({ channelId, agentId });

      const agentIds = [...held.agentIds, agentId];
      const name = await renameFrom(transaction, channelId, agentIds);
      return {
        id: channelId,
        name,
        agentIds,
        threadId: held.threadId,
        active: true,
      };
    },
    { isolationLevel: "read committed" },
  );
}

/**
 * A colleague leaves. What was said stays: this is a membership change, not a deletion.
 *
 * IT REFUSES TO LEAVE A ROOM WITH ONE MEMBER, and that is not fussiness. `create` resolves a
 * request for a single Bot to that Bot's EXISTING one-to-one conversation, on purpose — it is
 * what stopped three Bots accumulating thirteen channels between them. A room emptied down to
 * one member would be a second single-Bot channel that `create` would never return, so the
 * next message from Home would open the other one and the history here would be orphaned.
 * Somebody who wants to talk to one Bot already has that Bot's own conversation.
 */
export async function removeParticipant(
  database: Database,
  actor: AgentActor,
  channelId: string,
  agentId: string,
): Promise<AgentChannel> {
  return database.transaction(
    async (transaction) => {
      const held = await membershipOf(transaction, actor, channelId);
      if (!held.agentIds.includes(agentId)) {
        throw new ChannelMembershipError("laf:not_in_room");
      }
      if (held.agentIds.length <= 2) {
        throw new ChannelMembershipError("laf:room_too_small");
      }

      await transaction
        .delete(channelAgents)
        .where(
          and(
            eq(channelAgents.channelId, channelId),
            eq(channelAgents.agentId, agentId),
          ),
        );

      const agentIds = held.agentIds.filter((held) => held !== agentId);
      const name = await renameFrom(transaction, channelId, agentIds);
      return {
        id: channelId,
        name,
        agentIds,
        threadId: held.threadId,
        active: true,
      };
    },
    { isolationLevel: "read committed" },
  );
}

/**
 * Who is in a channel this person can actually see, read inside the caller's transaction.
 *
 * Through `channelMemberships` rather than by id alone: a channel id somebody else's conversation
 * owns must read as absent, not as a channel with a permission error attached.
 */
async function membershipOf(
  transaction: Executor,
  actor: AgentActor,
  channelId: string,
): Promise<{ agentIds: string[]; threadId: string }> {
  const rows: { agentId: string; threadId: string }[] = await transaction
    .select({
      agentId: channelAgents.agentId,
      threadId: channelThreads.threadId,
    })
    .from(channels)
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, actor.id),
      ),
    )
    .innerJoin(
      channelThreads,
      and(
        eq(channelThreads.channelId, channels.id),
        eq(channelThreads.userId, actor.id),
      ),
    )
    .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
    .where(eq(channels.id, channelId))
    .orderBy(asc(channelAgents.agentId));

  const first = rows[0];
  if (!first) throw new ChannelNotFoundError(channelId);
  return {
    agentIds: rows.map((row) => row.agentId),
    threadId: first.threadId,
  };
}

/** Rebuild a channel's name from who is in it now, the way `create` first built it. */
async function renameFrom(
  transaction: Executor,
  channelId: string,
  agentIds: readonly string[],
): Promise<string> {
  const names: string[] = [];
  for (const id of agentIds) {
    const [row] = await transaction
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);
    if (row) names.push(row.name);
  }
  const name = channelName(names);
  await transaction
    .update(channels)
    .set({ name })
    .where(eq(channels.id, channelId));
  return name;
}
