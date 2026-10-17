/**
 * A team room's "○○의 라피가 알아보는 중" line: whose 라피 is answering a question in this room now.
 *
 * READ OFF THE ROOM. The hub carries no passing signal, and the answering VM posts nothing while it
 * works (#259, `server/src/hub/room-answers.ts`): a person's message that mentions `lafi`, with no
 * message from that person's 라피 after it, is a question being worked on. These rules are the same
 * as #259's `lafiWorking` (`shared/hub/room-answers.ts` on `laf/room-answers`), copied here so this
 * screen does not wait on that branch; the window is this file's own.
 *
 * TWO MINUTES, NOT TEN, FOR EVERYBODY ELSE. A turn that failed or was stopped posts nothing to the
 * room — #259 tells only the asker, in their own conversation — so a line held for #259's ten-minute
 * answer window would hang for ten minutes over a question nobody is working on. Everybody else's
 * screen shows the line for at most {@link ROOM_WORKING_SHOWN_MS} after the question; the answer
 * arriving ends it sooner.
 *
 * THE ASKER'S OWN SCREEN KNOWS MORE. Their VM is the one running the turn, and its working list says
 * whether a room's run is still going (`origin: "room"`, `/api/agents/working`). While one is, the
 * asker's line stays up to {@link ROOM_WORKING_ASKER_MS}; once none is and two minutes have passed,
 * it goes, like everybody else's.
 */

/** What a message mentions to ask its author's own 라피 (`HUB_LAFI_MENTION` on the hub). */
export const LAFI_MENTION = "lafi";

/** How long a question shows as being worked on when nothing says whether its turn is still going. */
export const ROOM_WORKING_SHOWN_MS = 2 * 60_000;

/** The longest the asker's screen shows it while their own VM's room run is going (#259's window). */
export const ROOM_WORKING_ASKER_MS = 10 * 60_000;

export type RoomLine = {
  seq: number;
  by: string;
  mentions: readonly string[];
  at: string | null;
};

/** Who wrote a message: a person, or that person's 라피. Null for anything else. */
export function roomAuthor(
  by: string,
): { member: string; isLafi: boolean } | null {
  const at = by.indexOf(":");
  if (at <= 0 || at === by.length - 1) return null;
  const kind = by.slice(0, at);
  const member = by.slice(at + 1);
  if (kind === "m") return { member, isLafi: false };
  if (kind === "bot") return { member, isLafi: true };
  return null;
}

/**
 * The members whose 라피 is answering in this room now, oldest question first, one line each.
 *
 * `me` is this screen's member, and `myRoomRun` whether this VM has a room's run going now.
 */
export function workingInRoom(
  lines: readonly RoomLine[],
  now: number,
  options: { me?: string; myRoomRun?: boolean } = {},
): { member: string; seq: number }[] {
  const ordered = [...lines].sort((a, b) => a.seq - b.seq);
  const answered = new Map<string, number>();
  for (const line of ordered) {
    const author = roomAuthor(line.by);
    if (author?.isLafi) answered.set(author.member, line.seq);
  }
  const working = new Map<string, number>();
  for (const line of ordered) {
    const author = roomAuthor(line.by);
    if (!author || author.isLafi || working.has(author.member)) continue;
    if (!line.mentions.includes(LAFI_MENTION)) continue;
    if ((answered.get(author.member) ?? 0) > line.seq) continue;
    const at = line.at ? Date.parse(line.at) : Number.NaN;
    const age = Number.isNaN(at) ? Number.POSITIVE_INFINITY : now - at;
    const window =
      author.member === options.me && options.myRoomRun
        ? ROOM_WORKING_ASKER_MS
        : ROOM_WORKING_SHOWN_MS;
    if (age > window) continue;
    working.set(author.member, line.seq);
  }
  return [...working].map(([member, seq]) => ({ member, seq }));
}

/**
 * When the line next changes on its own — the soonest moment a shown question ages out — so the
 * screen re-reads the clock then instead of every second. Null when nothing is shown.
 */
export function nextWorkingChange(
  lines: readonly RoomLine[],
  shown: readonly { seq: number }[],
  options: { me?: string; myRoomRun?: boolean } = {},
): number | null {
  let soonest: number | null = null;
  for (const { seq } of shown) {
    const line = lines.find((one) => one.seq === seq);
    const at = line?.at ? Date.parse(line.at) : Number.NaN;
    if (!line || Number.isNaN(at)) continue;
    const author = roomAuthor(line.by);
    const window =
      author?.member === options.me && options.myRoomRun
        ? ROOM_WORKING_ASKER_MS
        : ROOM_WORKING_SHOWN_MS;
    const end = at + window + 1;
    soonest = soonest === null ? end : Math.min(soonest, end);
  }
  return soonest;
}

/** Whether a message as written asks the writer's own 라피: it says "@라피". */
export function asksLafi(text: string): boolean {
  return text.includes("@라피");
}

/** The asker's conversation with their 라피 for this room, once it has answered there (#259). */
export function roomConversationOf<T extends { id: string }>(
  roomId: string,
  channels: readonly T[] | undefined,
): T | undefined {
  // `room_<room id>_<bot id>` (`roomConversationId` in #259): this VM's only Bot answers there.
  return channels?.find((channel) =>
    channel?.id?.startsWith(`room_${roomId}_`),
  );
}
