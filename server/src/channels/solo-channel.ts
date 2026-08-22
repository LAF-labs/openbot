/**
 * The single-Bot conversation this person has with this Bot, and the thread behind it.
 *
 * Two things need the same answer: a routine delivering its output where the person already reads,
 * and a room member recalling what it was told in private. Single-Bot only, deliberately — a group
 * room is not "the Bot's conversation", it is everybody's. Returns null when the Bot has no
 * conversation yet; creating one as a side effect of a schedule or a room turn is a surprise, not
 * a feature.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../db/schema";

export async function soloChannelFor(
  database: Database,
  userId: string,
  agentId: string,
): Promise<{ channelId: string; threadId: string } | null> {
  const mine = database
    .select({ channelId: channelAgents.channelId })
    .from(channelAgents)
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channelAgents.channelId),
        eq(channelMemberships.userId, userId),
      ),
    )
    .where(eq(channelAgents.agentId, agentId));

  const rows = await database
    .select({
      channelId: channels.id,
      threadId: intelligenceChannelMappings.threadId,
      members: sql<number>`(
        select count(*) from ${channelAgents}
        where ${channelAgents.channelId} = ${channels.id}
      )`,
      createdAt: channels.createdAt,
    })
    .from(channels)
    .innerJoin(
      intelligenceChannelMappings,
      and(
        eq(intelligenceChannelMappings.channelId, channels.id),
        eq(intelligenceChannelMappings.userId, userId),
      ),
    )
    .where(inArray(channels.id, mine));

  // The OLDEST solo channel, which is the rule `channels.create` resolves by and the roster follows.
  const solo = rows
    .filter((row) => Number(row.members) === 1)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  return solo ? { channelId: solo.channelId, threadId: solo.threadId } : null;
}
