/**
 * What a Bot is shown when it is asked to take a turn in a room.
 *
 * Ported from Grok Bot 0.24's group-chat prompt (`Ecn` / `Scn` in its host), because the shape is
 * the answer to a problem we met from the other side and patched badly. A room has several Bots and
 * one AG-UI `assistant` role, so a Bot reading the room as its own history claims its colleagues'
 * work as its own. The reference never has that problem: the room is not the Bot's history. The
 * Bot answers from ITS OWN conversation, and the room arrives as one tagged user turn — a header,
 * who is present, and the lines said since this Bot last spoke.
 *
 * Two consequences worth stating, because both are load-bearing:
 *
 * THE BOT KEEPS ITS MEMORY. It answers the room out of the same conversation it has with this
 * person one-to-one, which is what a colleague brought into a meeting does. Our previous shape gave
 * a Bot in a room no memory of anything said to it privately.
 *
 * SPEAKING IS A TOOL CALL, NOT PROSE. Plain text a Bot writes during a room turn is private
 * scratch space; only `send_message` puts words in the room. That is what makes silence
 * unambiguous — a turn with no call is a Bot with nothing to add — and it is what lets a Bot do
 * real work mid-turn (open a page, read a file) without narrating it at everybody.
 */

/** One line of a room, as the transcript records it. */
export type RoomLine = {
  /** The Bot that said it, or null when the person did. */
  agentId: string | null;
  /** Whoever said it, for the rendered line. */
  name: string;
  text: string;
};

export type RoomMember = {
  id: string;
  name: string;
  /** The Bot's title or role, shown so colleagues know who they are talking to. Optional. */
  description?: string;
};

/** How many lines of the room a Bot is shown at most. The reference's `CNa`. */
export const ROOM_LINES = 24;

/** The header every room turn carries, and the marker that tells one apart from a private message. */
export const ROOM_TAG = "[Room: ";

/**
 * Is this user message a room turn rather than something the person typed privately?
 *
 * A Bot's own conversation accumulates both, and they mean different things — the reference tells
 * its Bots exactly this ("an untagged user message is from your private DM"). The tag is how the
 * transcript, and the Bot, tell them apart.
 */
export function isRoomTurn(text: string): boolean {
  return text.startsWith(ROOM_TAG);
}

/** The room's lines since this Bot last spoke. Everything, if it has not spoken here yet. */
export function linesSince(
  lines: readonly RoomLine[],
  memberId: string,
): RoomLine[] {
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    if (lines[at]?.agentId === memberId) return lines.slice(at + 1);
  }
  return [...lines];
}

function renderLine(line: RoomLine, memberId: string): string {
  if (line.agentId === null) return `${line.name} (user): ${line.text}`;
  const you = line.agentId === memberId ? " (you)" : "";
  return `${line.name}${you}: ${line.text}`;
}

/**
 * The turn itself: the room, who is in it, what has been said since, and whose turn it is.
 *
 * Deliberately one user message rather than several. The Bot's own history is the rest of the
 * request, and a room turn has to read as one thing that arrived — not as a conversation grafted
 * onto its conversation.
 */
export function roomTurnPrompt(input: {
  room: { name: string; description?: string };
  member: RoomMember;
  peers: readonly RoomMember[];
  lines: readonly RoomLine[];
  /** The last round, or nearly out of room: reply only if it matters. */
  windingDown?: boolean;
}): string {
  const { room, member, peers, lines, windingDown } = input;
  const roomName = room.name.trim() || "the room";
  const others = peers.filter((peer) => peer.id !== member.id);
  const withWhom =
    others.length > 0
      ? ` - with ${others.map((peer) => peer.name).join(", ")}`
      : "";
  const parts: string[] = [`${ROOM_TAG}"${roomName}"${withWhom}]`];

  const description = room.description?.trim();
  if (description) parts.push(`About this room: ${description}`);

  const introduced = others.filter((peer) => peer.description?.trim());
  if (introduced.length > 0) {
    parts.push(
      `Participants: ${introduced
        .map((peer) => `${peer.name} (${peer.description?.trim()})`)
        .join(", ")}`,
    );
  }

  const recent = lines.slice(-ROOM_LINES);
  if (recent.length === 0) {
    parts.push("No new messages in the room since your last turn.");
  } else {
    parts.push("New messages in the room (oldest first):");
    parts.push(recent.map((line) => renderLine(line, member.id)).join("\n"));
  }

  parts.push(
    "",
    `It's your turn, ${member.name}. Say something with send_message if you have something worth adding; if you don't, end your turn without calling it.`,
  );
  if (windingDown) {
    parts.push(
      "The room is wrapping up this turn: reply only if it's essential, otherwise stay silent.",
    );
  }
  return parts.join("\n");
}

/**
 * The standing instruction a Bot gets for the duration of a room turn.
 *
 * It is not the Bot's persona — that arrives the way it always does, from its own profile. This is
 * only what changes about being in a room, and every clause is one the reference spells out
 * because a model gets it wrong otherwise.
 */
export function roomConduct(member: RoomMember): string {
  return [
    `Several participants share this room. Stay fully in character as ${member.name}. Never speak or write as another participant or as the person, and never narrate the conversation from the outside.`,
    "",
    "How you talk in the room:",
    "- The ONLY way to say something the room can see is the send_message tool. Plain text is private scratch space, so a turn with no send_message means you stayed silent.",
    "- Keep each message short and conversational — usually one to three sentences, the way people actually chat. Do not monologue or summarise the whole thread.",
    "- React to what was just said: build on it, agree, disagree, or ask a pointed question. Address others by name when it helps.",
    "- Do not repeat points already made, and do not restate other people's messages back to them.",
    "- If you have nothing new worth adding, end your turn without calling send_message. Staying silent is a first-class move — it lets the conversation settle instead of spinning forever.",
    "- Say your piece in one turn, then stop.",
    "",
    "When the room asks for real work — checking a page, reading a file — do the work first and then deliver the result with send_message. Tool calls and plain text are private; only what you send is delivered.",
    "",
    `Your conversation history is your own and includes what this person told you privately. Answering the room from it is expected. Every room turn is tagged like ${ROOM_TAG}"..."]; an untagged message from the person is from your private conversation with them.`,
  ].join("\n");
}
