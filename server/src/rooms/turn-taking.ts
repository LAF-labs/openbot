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
 * more often than "@민수", a bare name carrying an honorific or a vocative particle counts as
 * addressing that colleague wherever it sits. A name buried in prose with no such particle
 * ("민수가 말한 대로") does not: that is talking about somebody, not to them, and pulling a Bot in
 * every time it is mentioned is the every-Bot-every-round behaviour by another route.
 */
import { rotate, type SpeakReason } from "./prompt";

/** A member, as much of it as naming needs. */
export type Nameable = { id: string; name: string };

/** One thing said in the room this turn. `agentId` is the Bot that said it. */
export type TurnLine = { agentId: string; text: string };

/**
 * Why a member is being asked to speak. Declared in `prompt.ts`, which is the other reader of it.
 */
export type { SpeakReason } from "./prompt";

export type Speaker<T extends Nameable> = {
  member: T;
  reason: SpeakReason;
  /** The colleague whose naming pulled it in. Present exactly when `reason` is `named`. */
  namedBy?: string;
};

/**
 * What may follow a bare name that OPENS the message for it to be addressing that colleague:
 * punctuation, a space, an honorific or a vocative particle, or a dative one. Not 이/가/은/는 —
 * "민수가 말한 대로" opens with the name too, and is talking about 민수, not to them.
 */
const OPENING_TAIL = /^(?:[\s,:!?~.…]|님|씨|아|야|께|한테|에게)/u;

/**
 * What may follow a bare name IN THE MIDDLE of a sentence for it to be addressing that colleague:
 * an honorific, a vocative particle or a dative one, glued straight onto the name.
 *
 * THE OPENING-ONLY RULE WAS WHERE THE CONVERSATION DIED. Measured on nine sentences of the kind
 * these prompts produce, four named nobody — "매출은 12% 올랐어요. 리뷰봇님은 어떻게 보세요?" and
 * "매출은 12% 올랐고, 재고봇님 재고 좀 봐 주세요." among them. Both are a direct question to a
 * colleague; neither opens with the name, because polite Korean puts the report first and the
 * question second. The round after those ends with `nobody-named`, which is a room where one Bot
 * asked another something and the other was never asked to answer.
 *
 * Deliberately NARROWER than the opening set: no bare whitespace and no comma. "그건 재고봇이
 * 확인해 주면 좋겠네요" and "재고봇 쪽은 아직이에요" are still talking ABOUT a colleague, and
 * pulling one in every time it is mentioned is the every-Bot-every-round behaviour by another
 * route (see the module comment). What survives is the honorific, which in Korean is how you
 * address somebody rather than how you refer to them.
 */
const VOCATIVE_TAIL = /^(?:님|씨|아|야|께|한테|에게)/u;

/** A name is only read where a word can start: the beginning, after a space, or after punctuation. */
const BOUNDARY = /[\s,;:!?~.…"'“”‘’()[\]{}<>·、，。]/u;

/**
 * "리뷰봇, 재고봇 둘 다" and "매출봇님과 리뷰봇님이" — what may sit between two colleagues
 * addressed together: the first one's own honorific, then a separator.
 *
 * Only reached from a name that already counted as an address, so "매출봇과 리뷰봇의 의견이
 * 갈렸다" does not qualify: 매출봇 opening with a "과" tail is not an address to begin with.
 */
const LIST_SEPARATOR =
  /^(?:님|씨|아|야|께|한테|에게)?\s*(?:,|·|와|과|랑|하고|그리고)\s*/u;

/**
 * The members named in a piece of text, in the order they were first named, each once.
 *
 * `@` followed by a member's name, longest name first so that `@민수2` is 민수2 and not 민수. The
 * name may be followed by anything — a particle, a comma, the end — because Korean glues the
 * particle onto the name and a rule that wanted a space after it would miss every "@민수님".
 * Latin names compare case-insensitively; a person typing `@risk` means the Bot called Risk.
 *
 * A bare name counts as an address when it opens the message, when it ends it, or when it carries
 * an honorific or a vocative particle anywhere in it. See the two tail patterns above for why
 * those are not the same set.
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
  if (byLength.length === 0) return named;

  /** Where the message's first character is, so "opens the message" survives leading whitespace. */
  const opensAt = text.length - text.trimStart().length;

  /*
   * ONE PASS OVER THE TEXT, so the ids come back in the order they were actually named. Scanning
   * once per member would be simpler and would report a room's members in roster order, which is
   * not the order anybody was called in.
   *
   * NOTHING IN THIS LOOP SLICES THE REST OF THE STRING. It is the version that read it that did,
   * and this runs over what a PERSON typed (`rooms/service.ts`), which is bounded by nothing: a
   * `text.slice(at)` per character is quadratic, so a pasted spreadsheet would have held the room
   * turn for as long as it took to walk it several million times over. The comparisons are done in
   * place and the two tails are read from a fixed window.
   */
  for (let at = 0; at < text.length; at += 1) {
    const marked = text[at] === "@";
    const from = marked ? at + 1 : at;
    if (!marked && at > 0 && !BOUNDARY.test(text[at - 1] ?? "")) continue;
    const hit = byLength.find((member) => nameAt(text, from, member.name));
    if (!hit) continue;

    const ends = from + hit.name.length;
    // Longer than the longest tail this can match, and a constant whatever was pasted.
    const tail = text.slice(ends, ends + TAIL_WINDOW);
    const opens = at === opensAt;
    const addresses =
      marked ||
      tail.length === 0 ||
      (opens ? OPENING_TAIL : VOCATIVE_TAIL).test(tail);
    if (!addresses) continue;

    add(hit.id);
    // Past the name, so "@민수" is not re-read from its second character.
    at = ends - 1;

    // "리뷰봇, 재고봇 둘 다 확인 부탁해요" — everybody in the list is being asked, not just the first.
    let cursor = ends;
    for (;;) {
      const separator = LIST_SEPARATOR.exec(
        text.slice(cursor, cursor + TAIL_WINDOW),
      );
      if (!separator) break;
      const next = byLength.find((member) =>
        nameAt(text, cursor + separator[0].length, member.name),
      );
      if (!next) break;
      add(next.id);
      cursor += separator[0].length + next.name.length;
      at = cursor - 1;
    }
  }
  return named;
}

/** Enough for the longest honorific-plus-separator run the two tails can match, and no more. */
const TAIL_WINDOW = 12;

/** Whether `name` sits at `from` in `text`, compared in place and without case. */
function nameAt(text: string, from: number, name: string): boolean {
  if (from + name.length > text.length) return false;
  return (
    text.slice(from, from + name.length).toLowerCase() === name.toLowerCase()
  );
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
