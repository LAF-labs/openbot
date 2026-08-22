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
import { and, eq, inArray, sql } from "drizzle-orm";
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

  const solo = rows.find((row) => Number(row.members) === 1);
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
    await database
      .update(channels)
      .set({
        lastMessage: delivery.answer.slice(0, 200),
        lastMessageAt: delivery.at,
        lastMessageAgentId: delivery.agentId,
        updatedAt: delivery.at,
      })
      .where(eq(channels.id, target.channelId));
  };
}

export type DeliverRoutineAnswer = ReturnType<typeof createRoutineDelivery>;
