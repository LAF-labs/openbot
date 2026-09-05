/**
 * Who speaks in a room, decided from the roster and the log alone.
 *
 * EVERY BOT USED TO ANSWER EVERY ROUND. A person asked the room something, all six members spoke,
 * and then all six spoke again to what the other five had said, three times over — a conversation
 * between models that the caps ended rather than the conversation itself. The reference (Hermes)
 * decides turns the way a meeting does: the person's message names who it is for, and after that
 * a Bot speaks only when a colleague has explicitly named it and it has not answered since. A round
 * where nobody named anybody is the conversation settling, and it ends.
 *
 * PURE, AND DETERMINISTIC. No model decides who is next; the same roster and the same lines give
 * the same order every time, which is what makes the rule testable in milliseconds and arguable
 * with afterwards — the audit row for each member's turn says which of these reasons it spoke for.
 *
 * NAMES, NOT IDS, IN THE LOG. A person's message carries the ids of the `@` chips the composer
 * built; a Bot's message carries only words. So naming is read out of the text, and read in the
 * way people actually write it in Korean: `@민수`, `@민수님`, `@민수야` — the name followed by a
 * particle, with no space — and, because a model asked to address a colleague writes "민수님, …"
 * more often than "@민수", a bare name that OPENS the message counts as addressing that colleague.
 * A name buried in prose ("민수가 말한 대로") does not: that is talking about somebody, not to
 * them, and pulling a Bot in every time it is mentioned is the every-Bot-every-round behaviour by
 * another route.
 */
import { rotate } from "./prompt";

/** A member, as much of it as naming needs. */
export type Nameable = { id: string; name: string };

/** One thing said in the room this turn. `agentId` is the Bot that said it. */
export type TurnLine = { agentId: string; text: string };

/**
 * Why a member is being asked to speak.
 *
 * `addressed`: the person named it. `everybody`: the person named nobody, so everybody opens.
 * `named`: a colleague named it in this turn and it has not answered since — the only reason a
 * Bot speaks after the first round.
 */
export type SpeakReason = "addressed" | "everybody" | "named";

export type Speaker<T extends Nameable> = {
  member: T;
  reason: SpeakReason;
  /** The colleague whose naming pulled it in. Present exactly when `reason` is `named`. */
  namedBy?: string;
};

/**
 * What may follow a bare opening name for it to be addressing that colleague: punctuation, a
 * space, an honorific or a vocative particle, or a dative one. Not 이/가/은/는 — "민수가 말한 대로"
 * opens with the name too, and is talking about 민수, not to them.
 */
const VOCATIVE_TAIL = /^(?:[\s,:!?~.…]|님|씨|아|야|께|한테|에게)/u;

/**
 * The members named in a piece of text, in the order they were first named, each once.
 *
 * `@` followed by a member's name, longest name first so that `@민수2` is 민수2 and not 민수. The
 * name may be followed by anything — a particle, a comma, the end — because Korean glues the
 * particle onto the name and a rule that wanted a space after it would miss every "@민수님".
 * Latin names compare case-insensitively; a person typing `@risk` means the Bot called Risk.
 *
 * A bare name counts only when it opens the text: the vocative, "민수님, 이거 봐 줘". See the module
 * comment for why a name in the middle of a sentence does not.
 */
export function mentionsIn(
  text: string,
  members: readonly Nameable[],
): string[] {
  const named: string[] = [];
  const add = (id: string) => {
    if (!named.includes(id)) named.push(id);
  };
  const byLength = members
    .map((member) => ({ id: member.id, name: member.name.trim() }))
    .filter((member) => member.name.length > 0)
    .sort((left, right) => right.name.length - left.name.length);

  const opening = text.trimStart();
  for (const member of byLength) {
    if (!startsWithName(opening, member.name)) continue;
    const tail = opening.slice(member.name.length);
    if (tail.length === 0 || VOCATIVE_TAIL.test(tail)) {
      add(member.id);
      break;
    }
  }

  let at = text.indexOf("@");
  while (at !== -1) {
    const rest = text.slice(at + 1);
    const hit = byLength.find((member) => startsWithName(rest, member.name));
    if (hit) {
      add(hit.id);
      at = text.indexOf("@", at + 1 + hit.name.length);
    } else {
      at = text.indexOf("@", at + 1);
    }
  }
  return named;
}

function startsWithName(text: string, name: string): boolean {
  return text.slice(0, name.length).toLowerCase() === name.toLowerCase();
}

/**
 * Who speaks in this round, in the order they speak.
 *
 * ROUND 0 is the person's: the members they named, or everybody when they named nobody — the
 * reference's rule, and `addressedMembers` in prompt.ts before it. Ids the person named that are
 * not in the room fall back to everybody rather than to nobody.
 *
 * LATER ROUNDS are the colleagues': a member speaks only if another member named it in a line
 * said this turn, and it has not spoken since that line. A member naming itself pulls nobody in.
 * A member that answered and was named again afterwards is asked again; one that was named and
 * answered is not, until it is named again.
 *
 * THE ORDER ROTATES by round, over the roster's order, so the same Bot does not open every round
 * — whoever speaks first sets the frame for everybody after.
 */
export function speakersForRound<T extends Nameable>(input: {
  members: readonly T[];
  round: number;
  /** Who the person named, as ids. Empty means everybody. */
  addressedIds: readonly string[];
  /** Everything said in the room this turn so far, oldest first. */
  said: readonly TurnLine[];
}): Speaker<T>[] {
  const { members, round, addressedIds, said } = input;
  if (members.length === 0) return [];

  if (round === 0) {
    const wanted = new Set(addressedIds);
    const named = members.filter((member) => wanted.has(member.id));
    const speakers: Speaker<T>[] =
      named.length > 0
        ? named.map((member) => ({ member, reason: "addressed" }))
        : members.map((member) => ({ member, reason: "everybody" }));
    return rotate(speakers, round);
  }

  const speakers: Speaker<T>[] = [];
  for (const member of members) {
    let namedAt = -1;
    let namedBy: string | undefined;
    let spokeAt = -1;
    for (const [index, line] of said.entries()) {
      if (line.agentId === member.id) {
        spokeAt = index;
        continue;
      }
      if (mentionsIn(line.text, members).includes(member.id)) {
        namedAt = index;
        namedBy = line.agentId;
      }
    }
    if (namedAt !== -1 && namedBy !== undefined && spokeAt < namedAt) {
      speakers.push({ member, reason: "named", namedBy });
    }
  }
  return rotate(speakers, round);
}
