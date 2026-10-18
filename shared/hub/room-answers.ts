/**
 * A member asks their own 라피 in a team room, and the room sees it working and then answering.
 *
 * Both ends read this file: the VM that answers (`server/src/hub/room-answers.ts`) and the screen
 * that draws a room. Rules only — no words; the surface owns those.
 *
 * WHO ANSWERS. A message by a person (`m:<member>`) that mentions `lafi` is answered by THAT
 * person's 라피, on that person's VM: the hub tells only the author of a `lafi` mention
 * (`room.mention`), so nobody else's VM so much as hears of it. The answer is posted as the author's
 * 라피 (`bot:<member>`), which the hub refuses to let mention `lafi` back.
 *
 * WORKING IS READ OFF THE ROOM, NOT SENT TO IT. The hub has no passing signal — no typing line, no
 * status that disappears — and a status MESSAGE would stay in the room for good, one more line
 * for every question anybody asks. Everything a screen needs is already in the room: a person's
 * questions to their 라피, and that 라피's answers to them. So nothing is posted while it works,
 * and every member's screen can still say so.
 *
 * FOR A WHILE, NOT FOREVER. A VM that is off, or a turn that failed, never answers; the question
 * would read as being worked on until the end of the room. So a question counts as being worked on
 * for {@link ROOM_ANSWER_WINDOW_MS}, and the answering VM uses the same bound the other way: a
 * question older than that when its VM first hears of it — a VM that was off and catches up — is
 * not taken up, where its asker has stopped looking for the answer. One heard in time is answered
 * even when the turns before it in its room run past the window, so an answer can come after the
 * screens have stopped saying it is being worked on.
 */
import { HUB_LAFI_MENTION } from "./protocol";

export const ROOM_ANSWER_WINDOW_MS = 10 * 60_000;

/** A room message, as far as these rules read one. */
export type RoomLine = {
  seq: number;
  by: string;
  mentions: readonly string[];
  /**
   * The run that posted it. A 라피's answer to a room question is posted under that question's id
   * ({@link roomQuestionId}), which is how a screen tells which question it answers.
   */
  runId?: string | null;
  /** ISO 8601. */
  at: string | null;
};

/**
 * The id a room question goes by on the answering VM: the person's message in the room's
 * conversation, and the run its answer is posted under (`runId`), so a screen reading the room
 * pairs the answer with its question.
 */
export const roomQuestionId = (roomId: string, seq: number): string =>
  `room:${roomId}:${seq}`;

/** The question an answer names by its run (`room:<room>:<seq>`), or null for any other post. */
export function answeredQuestion(
  runId: string | null | undefined,
): number | null {
  const match = runId?.match(/^room:[A-Za-z0-9_-]{1,80}:([1-9][0-9]{0,15})$/);
  const seq = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(seq) ? seq : null;
}

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

/** Whether this message is `member` asking their own 라피. */
export function asksOwnLafi(line: RoomLine, member: string): boolean {
  return line.by === `m:${member}` && line.mentions.includes(HUB_LAFI_MENTION);
}

const ageOf = (line: RoomLine, now: number): number => {
  const at = line.at ? Date.parse(line.at) : Number.NaN;
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : now - at;
};

/** Whether a question is still young enough to be answered, or shown as being answered. */
export function isFresh(line: RoomLine, now: number): boolean {
  return ageOf(line, now) <= ROOM_ANSWER_WINDOW_MS;
}

/**
 * The members whose 라피 is working on a question in this room now, oldest question first: a
 * person asked their 라피, the question is fresh, and it has not been answered yet.
 *
 * AN ANSWER NAMES ITS QUESTION. A VM answers its person's questions in a room one after another,
 * in the order they were asked, and posts each answer under the question's id (`runId`). So an
 * answer to question N ends N and every question of that member before it — those were taken
 * first, and whatever came of them (an answer, a stop, a refusal) they are over. Paired by order
 * instead, an earlier question that got no answer took the next answer as its own, and an answer
 * that came late was paired with the question after it.
 *
 * A 라피 post that names no question — one the Bot made itself, or one from before answers named
 * theirs — ends every question of that member asked before it.
 *
 * `lines` is a page of the room in any order. A member asking twice is listed once, at the oldest
 * question still open.
 */
export function lafiWorking(
  lines: readonly RoomLine[],
  now: number,
): { member: string; seq: number }[] {
  const ordered = [...lines].sort((a, b) => a.seq - b.seq);
  /** Each member's questions not over yet, oldest first. */
  const open = new Map<string, RoomLine[]>();
  for (const line of ordered) {
    const author = roomAuthor(line.by);
    if (!author) continue;
    const asked = open.get(author.member) ?? [];
    if (!author.isLafi) {
      if (asksOwnLafi(line, author.member)) {
        open.set(author.member, [...asked, line]);
      }
      continue;
    }
    const named = answeredQuestion(line.runId);
    const through = named !== null && named < line.seq ? named : line.seq - 1;
    open.set(
      author.member,
      asked.filter((question) => question.seq > through),
    );
  }
  const working: { member: string; seq: number }[] = [];
  for (const [member, asked] of open) {
    const oldest = asked.find((question) => isFresh(question, now));
    if (oldest) working.push({ member, seq: oldest.seq });
  }
  return working.sort((a, b) => a.seq - b.seq);
}

/**
 * The conversation a person's 라피 answers a room in, on their own VM: one per room and Bot, under
 * an id made from the two, so the VM finds it again without a table and a room's screen can link
 * to it from what it already knows.
 */
export const roomConversationId = (roomId: string, botId: string): string =>
  `room_${roomId}_${botId}`;
