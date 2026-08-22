/**
 * A routine's answer, delivered where the person already reads.
 *
 * Without this a routine's output lives on the Routines page behind a disclosure — work you have to
 * go and find, which is work you stop reading. The Bot has exactly one conversation and that is
 * where you would have asked the question by hand, so that is where the answer belongs: it becomes
 * the roster preview, it lights the unread dot, and the transcript reads as one continuous
 * relationship rather than two logs of the same colleague.
 *
 * Written straight into the snapshot rather than through a run of the conversation's agent. The
 * routine already ran — this is recording what was said, not saying it again, and re-running it
 * against the chat thread would double the cost and could answer differently the second time.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  CHANNEL_ACTIVITY_TOPIC,
  type ChannelActivityEvent,
} from "../channels/events";
import { previewOf } from "../channels/preview";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  lafThreadSnapshots,
} from "../db/schema";

type StampedMessage = {
  id: string;
  role: string;
  content: string;
  lafAt?: string;
  /** Which Bot said it. See `laf-runner.ts` for why this rides the jsonb rather than the type. */
  lafAgentId?: string;
};

export type RoutineDelivery = {
  agentId: string;
  userId: string;
  /** The routine's name, which is what the transcript announces before the answer. */
  routineName: string;
  answer: string;
  at: Date;
};

/**
 * The single-Bot conversation this person has with this Bot, and the thread behind it.
 *
 * Single-Bot only, deliberately: a routine belongs to one colleague, and dropping its output into a
 * group room would put it in front of people who never asked for it. Returns null when the Bot has
 * no conversation yet — there is nowhere to deliver, and creating a channel as a side effect of a
 * schedule firing is a surprise, not a feature.
 */
async function soloChannelFor(
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

export function createRoutineDelivery(
  database: Database,
  /**
   * Told what the thread now holds, so the runner's rehydrated copy stays in step with Postgres.
   * Absent in tests; the row is still written and read correctly on the next boot.
   */
  onAppended?: (
    threadId: string,
    agentId: string,
    messages: StampedMessage[],
  ) => void,
) {
  return async (delivery: RoutineDelivery): Promise<void> => {
    const target = await soloChannelFor(
      database,
      delivery.userId,
      delivery.agentId,
    );
    if (!target) return;

    const [snapshot] = await database
      .select({ messages: lafThreadSnapshots.messages })
      .from(lafThreadSnapshots)
      .where(eq(lafThreadSnapshots.threadId, target.threadId))
      .limit(1);

    const existing: StampedMessage[] = Array.isArray(snapshot?.messages)
      ? (snapshot?.messages as StampedMessage[])
      : [];
    const at = delivery.at.toISOString();
    /*
     * One message, from the Bot, that says which routine spoke.
     *
     * Not two — the instruction is not something the person typed, and rendering it as their own
     * message would put words in their mouth every morning. The routine's name carries the "why is
     * this here" that the instruction would have carried.
     */
    const message: StampedMessage = {
      id: randomUUID(),
      role: "assistant",
      content: `**${delivery.routineName}**\n\n${delivery.answer}`,
      lafAt: at,
      // The Bot whose routine it was. This is the second writer into the snapshot, and a message
      // it left unattributed would be a hole in a record the transcript reads as complete.
      lafAgentId: delivery.agentId,
    };
    const one = sql`${JSON.stringify([message])}::text::jsonb`;

    /*
     * APPENDED IN SQL, NOT READ-MODIFIED-WRITTEN.
     *
     * A chat run can save this thread between a read here and a write here — the person may be
     * mid-turn with the same Bot when its routine fires — and whichever wrote second would erase
     * the other's message. `jsonb || jsonb` appends atomically against whatever the row holds at
     * that instant, so neither side can lose the other's. The read above is only for the copy the
     * runner is told about.
     */
    const [written] = await database
      .insert(lafThreadSnapshots)
      .values({
        threadId: target.threadId,
        agentId: delivery.agentId,
        messages: one,
        updatedAt: delivery.at,
      })
      .onConflictDoUpdate({
        target: lafThreadSnapshots.threadId,
        set: {
          messages: sql`${lafThreadSnapshots.messages} || ${one}`,
          updatedAt: delivery.at,
        },
      })
      .returning({ messages: lafThreadSnapshots.messages });

    onAppended?.(
      target.threadId,
      delivery.agentId,
      Array.isArray(written?.messages)
        ? (written.messages as StampedMessage[])
        : [...existing, message],
    );

    /*
     * And the roster row, which is the half a person actually notices. `lastMessageAgentId` being
     * set is what makes the room count as unread — an answer nobody has read yet is exactly the
     * state the unread dot exists for.
     */
    /*
     * POSTGRES' CLOCK AND THE SAME FORWARD-ONLY GUARD THE OTHER WRITER USES.
     *
     * This is the second thing that writes `last_message_at`, and it was writing Bun's clock —
     * measured ~66 ms behind Postgres on this machine — with no ordering guard at all. A message a
     * person sent (stamped by `recordActivity` with Postgres `now()`) followed 50 ms later by a
     * delivery would be overwritten by a time EARLIER than itself, and `unread` is
     * `last_message_at > last_read_at`: the room could fail to go unread for the delivery and sort
     * below where it belongs. Same clock, same `lt` guard, so the two writers cannot disagree.
     */
    const [row] = await database
      .update(channels)
      .set({
        lastMessage: previewOf(delivery.answer),
        lastMessageAt: sql`now()`,
        lastMessageAgentId: delivery.agentId,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(channels.id, target.channelId),
          or(
            isNull(channels.lastMessageAt),
            lt(channels.lastMessageAt, sql`now()`),
          ),
        ),
      )
      .returning({
        name: channels.name,
        lastMessage: channels.lastMessage,
        lastMessageAt: channels.lastMessageAt,
      });
    /*
     * Nothing moved, which means something newer is already there. The message itself is in the
     * thread — it was appended above, atomically — so the transcript has it and the roster row is
     * already showing something more recent. Announcing a stale preview would be the news going
     * backwards on every open tab.
     */
    if (!row) return;

    /*
     * And announced, the way a message typed into the room is (channels/routes.ts,
     * recordActivity): the same event on the same topic, so the roster row moves and the open
     * transcript picks the message up without anybody reloading. Without this the delivery was a
     * row in Postgres that the screen learned about from a four-second poll, or not at all.
     */
    const members = await database
      .select({ userId: channelMemberships.userId })
      .from(channelMemberships)
      .where(eq(channelMemberships.channelId, target.channelId));
    const event: ChannelActivityEvent = {
      channelId: target.channelId,
      memberIds: members.map((member) => member.userId),
      name: row.name,
      lastMessage: row.lastMessage,
      // The time that was WRITTEN, on the database's clock, not the one this process guessed.
      lastMessageAt: (row.lastMessageAt ?? delivery.at).toISOString(),
      lastMessageAgentId: delivery.agentId,
    };
    await database.execute(
      sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
    );
  };
}

export type DeliverRoutineAnswer = ReturnType<typeof createRoutineDelivery>;
