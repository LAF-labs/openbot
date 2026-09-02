/**
 * What a member carries into a room turn: the tail of its own conversation with this person.
 *
 * The reference's members answer from a unified history — the room turn is one more user turn in
 * the Bot's own conversation, so a Bot in a room knows what it was asked in private an hour ago.
 * We held this back because a private conversation has no length bound, and a room turn whose cost
 * is unknown is one that fails for everybody on the day somebody pastes a novel. This is the bounded
 * version: the last `HISTORY_MESSAGES` things said, each cut to `HISTORY_MESSAGE_CHARS`, so the
 * worst case is a known number and the common case is a few hundred tokens.
 *
 * Only what was SAID, on both sides. Tool calls, tool results and system turns are the Bot's
 * working, not its memory of the person, and by bytes they are most of a thread. A routine's
 * delivery is an assistant message in the solo thread, so a Bot remembers what it reported.
 */
import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { soloChannelFor } from "../channels/solo-channel";
import type { Database } from "../db/client";
import { messagesFor, type StoredMessage } from "../runner/thread-store";
import { clamp } from "./prompt";
import { textOf } from "./transcript";

/** How many of the most recent things said are carried. A dozen is a conversation's last page. */
export const HISTORY_MESSAGES = 12;
/** How much of any one of them. Long enough for an answer, short enough that twelve are bounded. */
export const HISTORY_MESSAGE_CHARS = 1500;

/**
 * The tail of a stored thread, as messages a Bot can answer from.
 *
 * Fresh ids: these messages live for one run of the loop, and an id the snapshot minted is not
 * guaranteed unique against the note and the instruction placed around them.
 */
export function historyOf(stored: readonly StoredMessage[]): Message[] {
  const said: Message[] = [];
  /*
   * BACKWARDS, AND IT STOPS AT TWELVE. Only the tail is carried, so only the tail is worth reading:
   * walking forwards meant flattening and clamping every message in the thread — a year of
   * conversation — to keep the last dozen, on every member of every round.
   */
  for (
    let at = stored.length - 1;
    at >= 0 && said.length < HISTORY_MESSAGES;
    at -= 1
  ) {
    const entry = stored[at];
    if (!entry || typeof entry !== "object") continue;
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    const text = textOf((entry as { content?: unknown }).content).trim();
    if (!text) continue;
    const content = clamp(text, HISTORY_MESSAGE_CHARS);
    said.push(
      entry.role === "user"
        ? { id: randomUUID(), role: "user", content }
        : { id: randomUUID(), role: "assistant", content },
    );
  }
  return said.reverse();
}

/** Empty for a Bot the person has never talked to alone, and for one whose thread has nothing said. */
export async function readPrivateHistory(
  database: Database,
  userId: string,
  agentId: string,
): Promise<Message[]> {
  const solo = await soloChannelFor(database, userId, agentId);
  if (!solo) return [];
  return historyOf(await messagesFor(database, solo.threadId));
}
