/**
 * The single-Bot conversation this person has with this Bot, and the thread behind it.
 *
 * Three things need the same answer: starting a conversation with one Bot (which returns the one
 * that already exists — see `conversations.ts`), a routine delivering its output where the person
 * already reads, and a room member recalling what it was told in private. Single-Bot only,
 * deliberately — a group room is not "the Bot's conversation", it is everybody's. Returns null when
 * the Bot has no conversation yet; creating one as a side effect of a schedule or a room turn is a
 * surprise, not a feature.
 *
 * ONE QUERY FOR ALL THREE. Channel creation used to ask with its own SQL and this file with another
 * (audit A1 §6): the same fact two ways, with two different tie-breaks, one of which was a
 * JavaScript sort over however many rows came back. They agree by construction now.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
} from "../db/schema";

export type SoloConversation = {
  channelId: string;
  threadId: string;
  /** What the roster calls it, which `create` hands back as the channel's name. */
  name: string;
};

/**
 * The conversation with its name. The pool, or a transaction already open around the caller:
 * channel creation asks inside the transaction that holds the Bot's profile locked.
 */
export async function soloConversationOf(
  database: Pick<Database, "select">,
  userId: string,
  agentId: string,
): Promise<SoloConversation | null> {
  const [solo] = await database
    .select({
      channelId: channels.id,
      threadId: channelThreads.threadId,
      name: channels.name,
    })
    .from(channels)
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, userId),
      ),
    )
    .innerJoin(
      channelThreads,
      and(
        eq(channelThreads.channelId, channels.id),
        eq(channelThreads.userId, userId),
      ),
    )
    .innerJoin(
      channelAgents,
      and(
        eq(channelAgents.channelId, channels.id),
        eq(channelAgents.agentId, agentId),
      ),
    )
    /*
     * THE MAIN ONE, BY WHAT IT SAYS IT IS (`channels.kind`, migration 0064). This was "the oldest
     * channel holding only this Bot"; the migration wrote that answer down, channel by channel, so
     * that a project — another conversation with the same Bot — is never taken for it.
     */
    .where(
      and(
        eq(channels.kind, "main"),
        // A channel that also holds somebody else is a group, not this Bot's conversation.
        sql`(select count(*) from ${channelAgents} where ${channelAgents.channelId} = ${channels.id}) = 1`,
      ),
    )
    // One, by construction (`conversations.ts`). Were there ever two, the older has the history.
    .orderBy(asc(channels.createdAt), asc(channels.id))
    .limit(1);
  return solo ?? null;
}

/**
 * Where the conversation is, and nothing else: what a routine writes into and a room member reads.
 *
 * The pool, or a transaction already open around the caller: a routine settling its run reads
 * the conversation inside the same transaction it writes the answer into. Its answer carries
 * exactly these two fields, because a routine's delivery spreads it into what it returns.
 */
export async function soloChannelFor(
  database: Pick<Database, "select">,
  userId: string,
  agentId: string,
): Promise<{ channelId: string; threadId: string } | null> {
  const solo = await soloConversationOf(database, userId, agentId);
  return solo ? { channelId: solo.channelId, threadId: solo.threadId } : null;
}
