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
 * WHAT A ROOM TURN CONTAINS: this prompt, behind the tail of the Bot's own conversation with this
 * person. The reference's members answer from their unified history and so do ours, with one bound
 * the reference does not have: `private-history.ts` carries the last dozen things said in private
 * and cuts each one, so a room turn's worst-case cost is a known number rather than the length of
 * somebody's conversation. Everything older than that tail is not in front of the Bot, which is
 * why `roomConduct` ends by telling it to ask rather than assume.
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

/** The header every room turn carries, so a Bot can see at a glance where it is. */
export const ROOM_TAG = "[Room: ";

/**
 * The caps, all from the reference, all deliberately small.
 *
 * A room turn is a conversation between models, and a conversation between models does not stop on
 * its own: every one of these exists to end a turn that would otherwise keep finding something to
 * add. `ROOM_ROUNDS` bounds how many times round the table, `ROOM_MESSAGES_PER_TURN` bounds the
 * whole turn whatever the rounds do, and `ROOM_MESSAGES_PER_MEMBER` stops one Bot holding the floor.
 */
export const ROOM_ROUNDS = 3;
export const ROOM_MESSAGES_PER_TURN = 10;
export const ROOM_MESSAGES_PER_MEMBER = 3;
export const ROOM_MEMBERS = 6;
/** With this many slots left, everybody is asked to wrap up. */
export const WIND_DOWN_SLOTS = 2;

/** One line of a room, and one name in it, cut to what a prompt can carry. */
const ROOM_LINE_CHARS = 8000;
const ROOM_NAME_CHARS = 120;

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

/** `text` cut to `limit` characters, the last one an ellipsis when anything was dropped. */
export function clamp(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit
    ? text
    : `${points.slice(0, limit - 1).join("")}…`;
}

function renderLine(line: RoomLine, memberId: string): string {
  /*
   * Both halves are cut. A person can paste a novel into a room and a Bot can answer with one, and
   * a prompt built from two dozen of those is a request no provider accepts — the turn would fail
   * for everybody because of one line. `users.name` is nullable, so an unnamed person is "User"
   * rather than a line that starts with a space and a bracket.
   */
  const name = clamp(line.name.trim() || "User", ROOM_NAME_CHARS);
  const text = clamp(line.text, ROOM_LINE_CHARS);
  if (line.agentId === null) return `${name} (user): ${text}`;
  const you = line.agentId === memberId ? " (you)" : "";
  return `${name}${you}: ${text}`;
}

/**
 * The order members speak in, rotated so the same Bot does not open every round.
 *
 * The reference's `d6i`. Without it the first member by id answers first, every round, every turn —
 * and in a conversation between models whoever speaks first sets the frame for everybody after.
 */
export function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) return [];
  const at = ((by % items.length) + items.length) % items.length;
  return [...items.slice(at), ...items.slice(0, at)];
}

/**
 * Who this turn is addressed to.
 *
 * NOBODY NAMED MEANS EVERYBODY, which is the reference's rule (`m6i`) and the opposite of the one
 * we had: ours picked the room's first member, so a question to the room was always answered by
 * whichever Bot happened to sort first. Ids, never names — the composer already carries the id of
 * every `@` chip, and re-deriving it by scanning prose for names is a worse version of a thing we
 * already have exactly.
 */
export function addressedMembers<T extends { id: string }>(
  members: readonly T[],
  addressedIds: readonly string[],
): T[] {
  const wanted = new Set(addressedIds);
  const named = members.filter((member) => wanted.has(member.id));
  return named.length > 0 ? named : [...members];
}

/**
 * A Bot that had nothing to add.
 *
 * Empty is silence, and so is `(pass)` — the reference accepts it because models reach for a word
 * when told they may say nothing, and a room that prints "(pass)" as a message is worse than one
 * that prints nothing.
 */
export function isSilence(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || /^\(?pass\)?$/i.test(trimmed);
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

  /*
   * Never set today: `channels.description` is the constant "Private agent channel." and no screen
   * offers a room description. Kept in the signature because a room people name and describe is the
   * obvious next thing, and a prompt that has nowhere to put it is the reason it never gets added.
   */
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

  /*
   * THE LAST WORDS IN THE REQUEST, AND BLUNT ON PURPOSE.
   *
   * A Bot arrives here carrying its own system prompt, which ends by telling it to say what it
   * found in plain language — sensible everywhere else in the product and exactly wrong in a room.
   * Measured: with a polite "say something with send_message if you like", both members answered in
   * prose and the room stayed empty. The instruction has to be unmistakable and it has to be last.
   */
  parts.push(
    "",
    `It's your turn, ${clamp(member.name, ROOM_NAME_CHARS)}.`,
    "DO NOT reply in plain text — nobody in the room can see plain text. To say anything at all you",
    "must call the send_message tool with what you want to say.",
    "If you have nothing worth adding, call nothing and end your turn. That is staying silent, and",
    "it is a perfectly good answer.",
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
    "YOU ARE IN A ROOM, AND PLAIN TEXT IS INVISIBLE HERE.",
    "Whatever you write as an ordinary answer goes nowhere: nobody in the room sees it. The send_message tool is the only thing that puts words in front of the other participants. Any instruction you carry about answering in plain language does not apply during this turn.",
    "",
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
    "The most recent part of your private conversation with this person is in your history; the room's messages are in this turn. Beyond those two, ask rather than assume, and never claim to remember something neither has said.",
  ].join("\n");
}
