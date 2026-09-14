/**
 * The last thing said in a conversation, as the browser that saw it reports it to the roster.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { AgentNotFoundError } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
} from "../db/schema";
import type { Executor } from "../runner/thread-store";
import { ChannelNotFoundError } from "./errors";
import type { AnnounceChannelActivity, ChannelActivityEvent } from "./events";
import { previewOf } from "./preview";
import type { ChannelActivity } from "./types";

export async function recordActivity(
  database: Database,
  announce: AnnounceChannelActivity | undefined,
  actor: AgentActor,
  channelId: string,
  activity: ChannelActivity,
): Promise<void> {
  /*
   * Built inside the transaction, delivered after it. What `pg_notify` used to do for nothing:
   * a NOTIFY inside a transaction reaches listeners on commit and never after a rollback. In
   * process the same guarantee is the value this transaction returns and the line below the
   * `await` — announce from inside and a rolled-back message moves every member's roster with no
   * correction coming.
   */
  const announcement = await database.transaction(
    async (transaction) => {
      const now = await databaseNowFor(transaction, actor, channelId);

      /*
       * The browser says when it saw the message, because only it knows that. A browser whose
       * clock runs ahead would write a `last_message_at` in the future, and then no read mark
       * this server sets could ever pass it — the room would stay unread however often it was
       * opened. Earlier is honest; later is impossible.
       */
      const at = activity.at > now ? now : activity.at;

      if (activity.agentId !== null) {
        await requireLinkedAgent(transaction, channelId, activity.agentId);
      }

      /*
       * NO RETITLING. A channel used to take its name from the first thing said in it, because
       * a roster of five conversations with the same Bot was five identical rows — and that is
       * fixed at the root now: a Bot has one conversation, and a channel is named after its
       * participants the way a messaging thread is. Naming a Bot's one room after whatever was
       * typed into it first would freeze a stale sentence over a colleague's name forever.
       */
      return moveReportersRow(transaction, actor, channelId, activity, at);
    },
    { isolationLevel: "read committed" },
  );
  if (announcement) announce?.(announcement);
}

/**
 * The database's time, read on the reporter's membership row — which is also the check that they
 * are a member at all.
 *
 * POSTGRES' CLOCK, NOT THIS PROCESS'S, and taken here so it costs no extra round trip. Everything
 * this table orders by is written by Postgres — `created_at` defaults, `now()` in the read mark —
 * and the two clocks are not the same clock: measured, this Postgres runs ~66 ms ahead of the Bun
 * process beside it. Clamping a browser's reported time to `new Date()` therefore pinned a message
 * BEHIND the `created_at` of the room it was sent to, and a room a person had just spoken in failed
 * to move to the top of their roster.
 */
async function databaseNowFor(
  transaction: Executor,
  actor: AgentActor,
  channelId: string,
): Promise<Date> {
  const [membership] = await transaction
    .select({
      channelId: channelMemberships.channelId,
      at: sql<Date>`now()`,
    })
    .from(channelMemberships)
    .where(
      and(
        eq(channelMemberships.channelId, channelId),
        eq(channelMemberships.userId, actor.id),
      ),
    );
  // Not a member, or no such channel: the same answer either way, so belonging to a channel
  // is not something an outsider can probe for.
  if (!membership) throw new ChannelNotFoundError(channelId);
  return new Date(membership.at);
}

/** A Bot the report names has to be one of this channel's. */
async function requireLinkedAgent(
  transaction: Executor,
  channelId: string,
  agentId: string,
): Promise<void> {
  const [linked] = await transaction
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(
      and(
        eq(channelAgents.channelId, channelId),
        eq(channelAgents.agentId, agentId),
      ),
    );
  if (!linked) throw new AgentNotFoundError(agentId);
}

/**
 * Move the reporter's roster row, and say what that earned an announcement of — or null.
 *
 * A person's message and the agent's reply are reported separately, so they can arrive out of
 * order. Only ever move forwards.
 *
 * THE REPORTER'S OWN ROW. The browser reports what it saw in ITS conversation with the channel —
 * `channel_threads` keyed on this person and this channel — and that is the row that moves. It
 * moved `channels` until migration 0038, and in a channel two people share that put one person's
 * last sentence on the other's roster (audit A5-7).
 */
async function moveReportersRow(
  transaction: Executor,
  actor: AgentActor,
  channelId: string,
  activity: ChannelActivity,
  at: Date,
): Promise<ChannelActivityEvent | null> {
  const lastMessage = previewOf(activity.text);
  const applied = await transaction
    .update(channelThreads)
    .set({
      lastMessage,
      lastMessageAt: at,
      lastMessageAgentId: activity.agentId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(channelThreads.channelId, channelId),
        eq(channelThreads.userId, actor.id),
        or(
          isNull(channelThreads.lastMessageAt),
          lt(channelThreads.lastMessageAt, at),
        ),
      ),
    )
    .returning({ threadId: channelThreads.threadId });
  // Nothing changed, so there is nothing to announce: a stale report is not news.
  const [appliedRow] = applied;
  if (!appliedRow) return null;

  const [named] = await transaction
    .select({ name: channels.name })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  // To the reporter alone: the row that moved is theirs, and a member of the same
  // channel has a conversation — and a roster row — of their own.
  return {
    channelId,
    memberIds: [actor.id],
    name: named?.name ?? "",
    lastMessage,
    // The clamped time — what was WRITTEN. The event carrying the browser's own reading
    // would have every other tab patch its roster with a time the database does not hold.
    lastMessageAt: at.toISOString(),
    lastMessageAgentId: activity.agentId,
  };
}
