/**
 * A routine's answer, delivered where the person already reads.
 *
 * Without this a routine's output lives on the Routines page behind a disclosure — work you have to
 * go and find, which is work you stop reading. The Bot has exactly one conversation and that is
 * where you would have asked the question by hand, so that is where the answer belongs: it becomes
 * the roster preview, it lights the unread dot, and the transcript reads as one continuous
 * relationship rather than two logs of the same colleague.
 *
 * Written straight into the store rather than through a run of the conversation's agent. The
 * routine already ran — this is recording what was said, not saying it again, and re-running it
 * against the chat thread would double the cost and could answer differently the second time.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type {
  AnnounceChannelActivity,
  ChannelActivityEvent,
} from "../channels/events";
import { previewOf } from "../channels/preview";
import { soloChannelFor } from "../channels/solo-channel";
import type { Database } from "../db/client";
import { channelMemberships, channels } from "../db/schema";
import { appendMessages, type StoredMessage } from "../runner/thread-store";

export type RoutineDelivery = {
  agentId: string;
  userId: string;
  /** The routine's name, which is what the transcript announces before the answer. */
  routineName: string;
  answer: string;
  at: Date;
};

/** One thing a Bot said, appended to the one conversation it has with this person. */
export type SoloAppend = {
  agentId: string;
  userId: string;
  /** The bold line above the body: a routine's name, or who asked. Never a sentence — see below. */
  heading: string;
  body: string;
  at: Date;
};

/**
 * Write a message into a Bot's own conversation, and say nothing else about it.
 *
 * The half that two callers share: a routine delivering what it found, and a coworker recording
 * what it was asked. What they do NOT share is the roster row — a routine is news and rings the
 * bell, a handoff is a receipt for something the person watched happen a second ago in the other
 * Bot's window. Ringing for that would send them to read what they had just read.
 *
 * THE HEADING CARRIES NAMES, NEVER PROSE. Everything written here lands in a transcript, and the
 * server does not own the words on this surface (CLAUDE.md). A routine's name and a Bot's name are
 * facts the person authored; a sentence explaining them would be the server writing Korean.
 *
 * Returns the thread it wrote to, or null when the Bot has no conversation with this person yet —
 * creating one as a side effect of a schedule or a handoff is a surprise, not a feature.
 */
export async function appendToSoloConversation(
  database: Database,
  append: SoloAppend,
): Promise<{ channelId: string; threadId: string } | null> {
  const target = await soloChannelFor(database, append.userId, append.agentId);
  if (!target) return null;

  /*
   * One message, from the Bot, that says which routine spoke.
   *
   * Not two — the instruction is not something the person typed, and rendering it as their own
   * message would put words in their mouth every morning. The routine's name carries the "why is
   * this here" that the instruction would have carried.
   */
  const message = {
    id: randomUUID(),
    role: "assistant",
    content: `**${append.heading}**\n\n${append.body}`,
    lafAt: append.at.toISOString(),
    // The Bot whose routine it was. A message it left unattributed would be a hole in a record the
    // transcript reads as complete.
    lafAgentId: append.agentId,
  } as StoredMessage;

  /*
   * APPENDED, NOT READ-MODIFIED-WRITTEN.
   *
   * A chat run can write this thread at the same instant — the person may be mid-turn with the
   * same Bot when its routine fires — and whichever wrote second used to erase the other's message.
   * `appendMessages` takes a per-thread lock and adds a row, so neither side can lose the other's
   * and neither has to know the other exists.
   */
  await appendMessages(database, target.threadId, [message], { at: append.at });

  return target;
}

export function createRoutineDelivery(
  database: Database,
  /** Moves the roster row on every open tab. Absent in tests; the row is still written. */
  announce?: AnnounceChannelActivity,
) {
  return async (delivery: RoutineDelivery): Promise<void> => {
    const target = await appendToSoloConversation(database, {
      agentId: delivery.agentId,
      userId: delivery.userId,
      // The routine's name, which is the "why is this here" the instruction would have carried.
      heading: delivery.routineName,
      body: delivery.answer,
      at: delivery.at,
    });
    if (!target) return;

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
     * recordActivity): the same event to the same hub, so the roster row moves and the open
     * transcript picks the message up without anybody reloading. Without this the delivery was a
     * row in Postgres that the screen learned about from a four-second poll, or not at all.
     *
     * Nothing here is inside a transaction — the append and the roster update are each their own —
     * so the write above has committed by the time this line runs. See `channels/events.ts`.
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
    announce?.(event);
  };
}

export type DeliverRoutineAnswer = ReturnType<typeof createRoutineDelivery>;
