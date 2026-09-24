/**
 * Reading a room and writing into it.
 *
 * A room's transcript is the same `laf_thread_messages` rows a one-to-one conversation uses; what
 * makes it a room is that several Bots write into it and every assistant message carries
 * `lafAgentId`. Both halves live here so the rule about who said what is written once: a message
 * whose speaker nobody recorded is not shown to the members as anybody's, and no message is ever
 * written without one.
 *
 * The append goes through `appendMessages` (runner/thread-store.ts) like every other write in the
 * product. What this file kept from the version that wrote `jsonb || jsonb` by hand is the half
 * that is about the ROSTER rather than the transcript: Postgres' clock and a forward-only guard on
 * the roster row, because this process runs ~66 ms behind the database and the roster orders by
 * that column; and the announcement last, only when the row actually moved.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { ChannelActivityEvent } from "../channels/events";
import { previewOf } from "../channels/preview";
import { channels, channelThreads, lafThreadMessages } from "../db/schema";
import {
  appendMessages,
  type Executor,
  messagesFor,
  type StoredMessage,
} from "../runner/thread-store";
import type { MemberReceipt } from "./outcomes";
import type { RoomLine } from "./prompt";

export type { Executor, StoredMessage } from "../runner/thread-store";

/**
 * How many rows a room turn reads back for its prompt.
 *
 * The prompt keeps the last `ROOM_LINES` things somebody SAID (`prompt.ts`), and a said line is
 * at most one row — so a window of rows this size holds them with room for the tool calls and
 * results between them, which are rows too and are not lines. A room's thread was read whole on
 * every member of every round; audit A5-2 puts a six-month thread at tens of thousands of rows.
 */
export const ROOM_READ_ROWS = 200;

/** The words of a stored message. Parts that are not text — an image, a file — are not words. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  // AG-UI allows an array of parts on a user message. Only the text of it belongs in a room line.
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: string }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * The room, as its members are shown it.
 *
 * Only what somebody SAID: a person's message, and an assistant message whose Bot is recorded.
 * Tool calls, tool results and system turns are a Bot's private working and are not the room's
 * conversation — the reference draws the same line, and it is what lets a member do real work in a
 * room without narrating it at everybody.
 *
 * An assistant message with no `lafAgentId` is skipped rather than attributed to somebody. That is
 * `attribute()`'s rule (`runner/thread-store.ts`) carried into the prompt: a message whose Bot
 * nobody recorded belongs to no particular Bot, and putting one colleague's words under another's
 * name is worse than leaving a gap.
 */
export async function readRoomLines(
  executor: Executor,
  threadId: string,
  names: ReadonlyMap<string, string>,
  personName: string,
): Promise<RoomLine[]> {
  const stored = await messagesFor(executor, threadId, {
    last: ROOM_READ_ROWS,
  });

  const lines: RoomLine[] = [];
  for (const entry of stored) {
    const text = textOf((entry as { content?: unknown }).content).trim();
    if (!text) continue;
    if (entry.role === "user") {
      lines.push({ agentId: null, name: personName, text });
      continue;
    }
    if (entry.role !== "assistant") continue;
    const by = entry.lafAgentId;
    if (typeof by !== "string") continue;
    lines.push({ agentId: by, name: names.get(by) ?? by, text });
  }
  return lines;
}

export type RoomAppend = {
  channelId: string;
  threadId: string;
  /** The Bot that said it, or null when the person did. Null is what keeps the room read. */
  agentId: string | null;
  text: string;
  /** Minted by the caller when the id has to be known before the write — a client's own message. */
  messageId?: string;
  /**
   * The run this message belongs to: the member's run for what a member says, the turn's run for
   * what the person said. It was left null for both, which is why the failures reader — keyed on
   * `run_id` — could never find a room's message. See `channels/turn-failures.ts`.
   */
  runId?: string;
};

/**
 * Put one message in the room, move the roster row, and say what to announce.
 *
 * The id is OURS, always. `agent-bot` mints `msg_${runId}` for the message it streams, and two
 * members answering in the same turn would collide on it — a collision here does not throw, it
 * silently merges two Bots' sentences into one message.
 *
 * IT DOES NOT ANNOUNCE, IT RETURNS THE ANNOUNCEMENT. This runs on a caller's executor, which is
 * sometimes a transaction still open around it, and delivery has to happen after that commits (see
 * `events.ts`). The old `pg_notify` could be issued from in here precisely because Postgres held it
 * until the commit; nothing in this process will, so the caller that knows where its transaction
 * ends is the one that hands it to the hub. Null when the roster row did not move — a stale preview
 * is not news.
 */
export async function appendRoomMessage(
  executor: Executor,
  append: RoomAppend,
): Promise<{
  messageId: string;
  at: string;
  activity: ChannelActivityEvent | null;
}> {
  const at = new Date();
  const message: StoredMessage = {
    id: append.messageId ?? randomUUID(),
    role: append.agentId ? "assistant" : "user",
    content: append.text,
    lafAt: at.toISOString(),
    ...(append.agentId ? { lafAgentId: append.agentId } : {}),
  } as StoredMessage;

  await appendMessages(executor, append.threadId, [message], {
    at,
    ...(append.runId ? { runId: append.runId } : {}),
  });

  /*
   * THE ROSTER ROW IS THE THREAD'S, NOT THE CHANNEL'S. A room two people share holds two threads
   * (`channel_threads` is keyed on person and channel), and the preview used to sit on the channel
   * — so a member of staff's roster showed the owner's last sentence, and a leaver's last words
   * stayed on the survivor's row (audit A5-7). The row that moves is the one the message went
   * into, and the announcement goes to its owner alone.
   */
  const [row] = await executor
    .update(channelThreads)
    .set({
      lastMessage: previewOf(append.text),
      lastMessageAt: sql`now()`,
      lastMessageAgentId: append.agentId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(channelThreads.threadId, append.threadId),
        or(
          isNull(channelThreads.lastMessageAt),
          lt(channelThreads.lastMessageAt, sql`now()`),
        ),
      ),
    )
    .returning({
      userId: channelThreads.userId,
      lastMessage: channelThreads.lastMessage,
      lastMessageAt: channelThreads.lastMessageAt,
    });
  /*
   * Nothing moved, so something newer is already there. The message is in the thread — it was
   * appended above, atomically — and announcing a stale preview would walk the roster backwards on
   * every open tab.
   */
  if (!row)
    return {
      messageId: message.id,
      at: message.lafAt ?? at.toISOString(),
      activity: null,
    };

  const [named] = await executor
    .select({ name: channels.name })
    .from(channels)
    .where(eq(channels.id, append.channelId))
    .limit(1);

  return {
    messageId: message.id,
    at: message.lafAt ?? at.toISOString(),
    activity: {
      channelId: append.channelId,
      memberIds: [row.userId],
      name: named?.name ?? "",
      lastMessage: row.lastMessage,
      // The time that was WRITTEN, on the database's clock, not the one this process guessed.
      lastMessageAt: (row.lastMessageAt ?? at).toISOString(),
      lastMessageAgentId: append.agentId,
    },
  };
}

/**
 * Keep how each member's part in a turn came out, on the person's message that started the turn.
 *
 * WHY THE QUESTION'S OWN ROW, AND NOT A TABLE. The footprint ladder: the fact belongs to one message
 * — "who read this, and who could not answer it" — and that message is already a row, already keyed
 * by the id the screen holds, already read by the one route that hands the transcript its marks
 * (`createMessageMarkReader`). A table would be a second record of a thing the thread already names.
 * And not a message of its own: the transcript is what the members are shown the room by, and a
 * row nobody said is one they would read as somebody's words.
 *
 * MERGED, member by member. Asking one colleague again (다시 묻기) runs a turn that hears from that
 * colleague alone; the members that had already read the question and stayed quiet are still the
 * record, and only the one asked again changes. `jsonb ||` on two objects is exactly that merge.
 *
 * A turn that asked nobody — superseded before its first member, or stopped — writes nothing.
 */
export async function recordRoomReceipts(
  executor: Executor,
  receipt: {
    threadId: string;
    /** The person's message the turn answered. */
    messageId: string;
    members: readonly MemberReceipt[];
  },
): Promise<void> {
  if (receipt.members.length === 0) return;
  const heard = Object.fromEntries(
    receipt.members.map((member) => [member.id, member.outcome]),
  );
  /*
   * Through `text` for the reason `unstoredOf` gives in thread-store.ts: the driver sends a string
   * bound straight to `jsonb` as a JSON string scalar, and `||` onto a string makes an array.
   */
  await executor
    .update(lafThreadMessages)
    .set({
      message: sql`jsonb_set(${lafThreadMessages.message}, '{lafRoomReceipts}', coalesce(${lafThreadMessages.message} -> 'lafRoomReceipts', '{}'::jsonb) || ${JSON.stringify(heard)}::text::jsonb)`,
    })
    .where(
      and(
        eq(lafThreadMessages.threadId, receipt.threadId),
        sql`${lafThreadMessages.message} ->> 'id' = ${receipt.messageId}`,
      ),
    );
}
