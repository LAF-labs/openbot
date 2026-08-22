/**
 * Reading a room and writing into it.
 *
 * A room's transcript is the same `laf_thread_snapshots` row a one-to-one conversation uses; what
 * makes it a room is that several Bots write into it and every assistant message carries
 * `lafAgentId`. Both halves live here so the rule about who said what is written once: a message
 * whose speaker nobody recorded is not shown to the members as anybody's, and no message is ever
 * written without one.
 *
 * The append is `createRoutineDelivery`'s, generalised. Everything it learned the hard way is kept:
 * `jsonb || jsonb` rather than read-modify-write, because a chat run can save the same thread
 * between our read and our write; Postgres' clock and a forward-only guard on the roster row,
 * because this process runs ~66 ms behind the database and the roster orders by that column; and
 * the announcement last, only when the row actually moved.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { CHANNEL_ACTIVITY_TOPIC } from "../channels/events";
import { previewOf } from "../channels/preview";
import type { Database } from "../db/client";
import { channelMemberships, channels, lafThreadSnapshots } from "../db/schema";
import type { RoomLine } from "./prompt";

/** A message as the snapshot stores it. See `laf-runner.ts` for why these keys ride the jsonb. */
export type StoredMessage = {
  id: string;
  role: string;
  content?: unknown;
  lafAt?: string;
  lafAgentId?: string;
};

/** Anything that can run a statement: the pool, or a transaction inside somebody else's work. */
export type Executor = Pick<
  Database,
  "select" | "insert" | "update" | "execute"
>;

function textOf(content: unknown): string {
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
 * `attribute()`'s rule (`runner/laf-runner.ts`) carried into the prompt: a message whose Bot nobody
 * recorded belongs to no particular Bot, and putting one colleague's words under another's name is
 * worse than leaving a gap.
 */
export async function readRoomLines(
  executor: Executor,
  threadId: string,
  names: ReadonlyMap<string, string>,
  personName: string,
): Promise<RoomLine[]> {
  const [row] = await executor
    .select({ messages: lafThreadSnapshots.messages })
    .from(lafThreadSnapshots)
    .where(eq(lafThreadSnapshots.threadId, threadId))
    .limit(1);
  const stored: unknown = row?.messages;
  if (!Array.isArray(stored)) return [];

  const lines: RoomLine[] = [];
  for (const entry of stored as StoredMessage[]) {
    if (!entry || typeof entry !== "object") continue;
    const text = textOf(entry.content).trim();
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
};

/**
 * Put one message in the room, tell the runner, move the roster row, announce it.
 *
 * The id is OURS, always. `agent-bot` mints `msg_${runId}` for the message it streams, and two
 * members answering in the same turn would collide on it — a collision here does not throw, it
 * silently merges two Bots' sentences into one message.
 */
export async function appendRoomMessage(
  executor: Executor,
  append: RoomAppend,
  onAppended?: (
    threadId: string,
    agentId: string | null,
    messages: StoredMessage[],
  ) => void,
): Promise<{ messageId: string; at: string } | null> {
  const at = new Date();
  const message: StoredMessage = {
    id: append.messageId ?? randomUUID(),
    role: append.agentId ? "assistant" : "user",
    content: append.text,
    lafAt: at.toISOString(),
    ...(append.agentId ? { lafAgentId: append.agentId } : {}),
  };
  const one = sql`${JSON.stringify([message])}::text::jsonb`;

  const [written] = await executor
    .insert(lafThreadSnapshots)
    .values({
      threadId: append.threadId,
      agentId: append.agentId,
      messages: one,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: lafThreadSnapshots.threadId,
      set: {
        messages: sql`${lafThreadSnapshots.messages} || ${one}`,
        updatedAt: at,
      },
    })
    .returning({ messages: lafThreadSnapshots.messages });

  if (Array.isArray(written?.messages)) {
    onAppended?.(
      append.threadId,
      append.agentId,
      written.messages as StoredMessage[],
    );
  }

  const [row] = await executor
    .update(channels)
    .set({
      lastMessage: previewOf(append.text),
      lastMessageAt: sql`now()`,
      lastMessageAgentId: append.agentId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(channels.id, append.channelId),
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
   * Nothing moved, so something newer is already there. The message is in the thread — it was
   * appended above, atomically — and announcing a stale preview would walk the roster backwards on
   * every open tab.
   */
  if (!row)
    return { messageId: message.id, at: message.lafAt ?? at.toISOString() };

  const members = await executor
    .select({ userId: channelMemberships.userId })
    .from(channelMemberships)
    .where(eq(channelMemberships.channelId, append.channelId));

  await executor.execute(
    sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify({
      channelId: append.channelId,
      memberIds: members.map((member) => member.userId),
      name: row.name,
      lastMessage: row.lastMessage,
      lastMessageAt: (row.lastMessageAt ?? at).toISOString(),
      lastMessageAgentId: append.agentId,
    })})`,
  );

  return { messageId: message.id, at: message.lafAt ?? at.toISOString() };
}
