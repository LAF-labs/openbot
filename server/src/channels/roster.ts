/**
 * The channels a person can see, what their roster says about each, and where they stopped reading.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  agentProfiles,
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
} from "../db/schema";
import { ChannelNotFoundError } from "./errors";
import type { AgentChannel, ChannelStore, ChannelSummary } from "./types";

/**
 * Whether a room has something in it this person has not seen.
 *
 * Two conditions, and the second is the one that is easy to forget: a message only counts as unread
 * if a BOT said it. Your own message is the newest thing in the room the instant you send it, so
 * without the agent check every room you spoke in would mark itself unread the moment you left.
 */
function isUnread(row: {
  lastMessageAt: Date | null;
  lastMessageAgentId: string | null;
  lastReadAt: Date | null;
}): boolean {
  if (row.lastMessageAgentId === null || row.lastMessageAt === null) {
    return false;
  }
  return row.lastReadAt === null || row.lastMessageAt > row.lastReadAt;
}

export async function readChannel(
  database: Database,
  actor: AgentActor,
  channelId: string,
): Promise<AgentChannel | null> {
  const rows = await database
    .select({
      id: channels.id,
      name: channels.name,
      agentId: channelAgents.agentId,
      threadId: channelThreads.threadId,
      deletedAt: agentProfiles.deletedAt,
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
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, channelAgents.agentId))
    .where(eq(channels.id, channelId))
    .orderBy(asc(channelAgents.agentId));

  const first = rows[0];
  if (!first) return null;

  return {
    id: first.id,
    name: first.name,
    agentIds: rows.map((row) => row.agentId),
    threadId: first.threadId,
    active: rows.every((row) => row.deletedAt === null),
  };
}

export async function listChannels(
  database: Database,
  actor: AgentActor,
): Promise<ChannelSummary[]> {
  const rows = await database
    .select({
      id: channels.id,
      name: channels.name,
      agentId: channelAgents.agentId,
      threadId: channelThreads.threadId,
      deletedAt: agentProfiles.deletedAt,
      // THIS PERSON'S last message, from the row that is their conversation. The columns sat
      // on `channels` until migration 0038, which put the owner's last sentence on a member
      // of staff's roster — the join on `channelThreads` above is the scope.
      lastMessage: channelThreads.lastMessage,
      lastMessageAt: channelThreads.lastMessageAt,
      lastMessageAgentId: channelThreads.lastMessageAgentId,
      lastReadAt: channelMemberships.lastReadAt,
      createdAt: channels.createdAt,
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
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, channelAgents.agentId))
    // Most recent first, where starting a conversation counts as activity. A channel somebody
    // just created has nothing said in it yet, and is also the one they are about to type in;
    // ordering on the message alone would bury it under every channel that has one.
    //
    // The browser repeats this when the socket patches a row. Both must agree, or the list
    // reorders itself on the next event; see `byRecency` in use-channel-events.ts.
    .orderBy(
      sql`coalesce(${channelThreads.lastMessageAt}, ${channels.createdAt}) desc`,
      asc(channels.id),
      asc(channelAgents.agentId),
    );

  // One row per channel-agent pair; the ordering above keeps each channel's rows together and
  // its agents in the same lexicographic order `get` returns.
  const summaries = new Map<string, ChannelSummary>();
  for (const row of rows) {
    const summary = summaries.get(row.id);
    if (summary) {
      summary.agentIds.push(row.agentId);
      summary.active &&= row.deletedAt === null;
      continue;
    }
    summaries.set(row.id, {
      id: row.id,
      name: row.name,
      agentIds: [row.agentId],
      threadId: row.threadId,
      active: row.deletedAt === null,
      lastMessage: row.lastMessage,
      lastMessageAt: row.lastMessageAt,
      lastMessageAgentId: row.lastMessageAgentId,
      unread: isUnread(row),
      createdAt: row.createdAt,
    });
  }
  return [...summaries.values()];
}

export function setLastRead(
  database: Database,
  actor: AgentActor,
  channelId: string,
  at: Date | null,
  options?: Parameters<ChannelStore["setLastRead"]>[3],
): Promise<{ previous: Date | null; at: Date | null }> {
  return database.transaction(async (transaction) => {
    /*
     * Scoped by userId in the WHERE, so this can only ever move the caller's own mark. Reading
     * membership first and updating second would be the same two statements with a race in
     * between; one guarded UPDATE is both.
     */
    /*
     * The PREVIOUS mark comes back, and that is the point of returning anything.
     *
     * Opening a room marks it read, which destroys the very fact the transcript needs to draw
     * its "unread from here" line. Reading it in a separate request would race the write; one
     * statement that reports what it replaced cannot.
     */
    const [before] = await transaction
      .select({ lastReadAt: channelMemberships.lastReadAt })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, actor.id),
        ),
      )
      .for("update");
    // Not a member, or no such channel: the same answer either way, so belonging to a channel
    // is not something an outsider can probe for.
    if (!before) throw new ChannelNotFoundError(channelId);

    /*
     * NEVER FORWARDS, when asked not to. Marking unread puts the boundary just before the
     * newest thing said — and on a room that already had several unread replies, taking that
     * literally moved the mark FORWARD and marked the earlier ones read. "I have not read this"
     * cannot be an instruction that marks four messages read.
     */
    const next =
      options?.neverForward && before.lastReadAt !== null && at !== null
        ? new Date(Math.min(before.lastReadAt.getTime(), at.getTime()))
        : at;

    await transaction
      .update(channelMemberships)
      .set({ lastReadAt: next })
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, actor.id),
        ),
      );
    return { previous: before.lastReadAt, at: next };
  });
}
