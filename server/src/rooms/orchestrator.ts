/**
 * Whose turn it is, how many times round, and when a room turn is over.
 *
 * Pure: no database, no agents, no clock. Everything it needs is a function it was handed, which is
 * what lets the whole cap-and-stop matrix be tested with fakes in milliseconds — and that matters
 * because every rule in here exists to end a conversation between models, and a rule that ends a
 * conversation is one you cannot afford to get wrong by a round.
 *
 * The shape is the reference's `Ivt.run`, and so are the reasons:
 *
 * WHO SPEAKS IS DECIDED FROM THE ROSTER AND THE LOG, by `turn-taking.ts`. Round 0 is the person's:
 * the members they named, or everybody. Every later round is the colleagues': a member speaks only
 * when another member named it this turn and it has not answered since. Every Bot used to answer
 * every round, and the caps were the only thing that ended it.
 *
 * THE ORDER ROTATES. Whoever speaks first sets the frame, and the same Bot opening every round is
 * the same Bot deciding what the room is about every round.
 *
 * A SILENT ROUND ENDS IT. Nobody had anything to add, and asking again produces filler — which is
 * exactly what a model does when asked a second time. A round where nobody was named ends it too:
 * the conversation has settled, whatever the caps still allow.
 *
 * THE EPOCH IS CHECKED BETWEEN MEMBERS, NEVER BETWEEN A MEMBER FINISHING AND ITS WORDS LANDING. A
 * member that has already thought is a member whose sentence is worth keeping, even if the person
 * has moved on; dropping it would lose work that was done and paid for.
 */
import {
  ROOM_MESSAGES_PER_TURN,
  ROOM_ROUNDS,
  type RoomMember,
  WIND_DOWN_SLOTS,
} from "./prompt";
import {
  type SpeakReason,
  speakersForRound,
  type TurnLine,
} from "./turn-taking";

/** What a member is asked with: who, whether to wrap up, and why it is being asked at all. */
export type MemberAsk = {
  member: RoomMember;
  windingDown: boolean;
  /** Which round of the turn this is, from 0. On the audit row so a turn can be read in order. */
  round: number;
  /** Why this member speaks now. See `turn-taking.ts`. */
  reason: SpeakReason;
  /** The colleague whose naming pulled it in, when that is the reason. */
  namedBy?: string;
};

export type MemberSaid = {
  /** How many messages this member put in the room. Zero is silence, and is a normal outcome. */
  spoke: number;
  /** What it said, in order, so the next round can read who it named. */
  said: readonly string[];
};

export type RoomTurnDeps = {
  /** The room's Bots, in the room's one order. */
  members: readonly RoomMember[];
  /** Who the person named — chips and `@`-mentions, as ids. Empty means everybody. */
  addressedIds: readonly string[];
  /**
   * Whether this is still the turn the room is waiting on.
   *
   * False the moment the person says something else. Checked before every member so a superseded
   * turn stops at the next boundary rather than finishing three more rounds nobody is reading.
   */
  isCurrent: () => Promise<boolean>;
  /** Ask one member to take its turn. */
  runMember: (input: MemberAsk) => Promise<MemberSaid>;
};

export type RoomTurnOutcome = {
  /** Messages put in the room by everybody, this turn. */
  posted: number;
  /** How many rounds were actually opened. */
  rounds: number;
  /** Why it ended, for the record and for the tests. */
  ended:
    | "silent-round"
    | "nobody-named"
    | "rounds"
    | "full"
    | "superseded"
    | "alone";
};

export async function runRoomTurn(
  deps: RoomTurnDeps,
): Promise<RoomTurnOutcome> {
  let posted = 0;
  let rounds = 0;
  const said: TurnLine[] = [];

  for (let round = 0; round < ROOM_ROUNDS; round += 1) {
    if (!(await deps.isCurrent())) {
      return { posted, rounds, ended: "superseded" };
    }

    const speaking = speakersForRound({
      members: deps.members,
      round,
      addressedIds: deps.addressedIds,
      said,
    });
    if (speaking.length === 0) {
      // Nobody in the room at all on the first round; nobody named on a later one.
      return {
        posted,
        rounds,
        ended: round === 0 ? "alone" : "nobody-named",
      };
    }

    rounds += 1;
    let spokeThisRound = 0;

    for (const speaker of speaking) {
      if (posted >= ROOM_MESSAGES_PER_TURN) {
        return { posted, rounds, ended: "full" };
      }
      if (!(await deps.isCurrent())) {
        return { posted, rounds, ended: "superseded" };
      }

      /*
       * Wind-down is asked for on the last round, and earlier if the room is nearly out of
       * messages. Without the second clause a turn can hit its hard cap mid-sentence with nobody
       * having been told it was ending, which reads as the room being cut off rather than settling.
       */
      const windingDown =
        round === ROOM_ROUNDS - 1 ||
        ROOM_MESSAGES_PER_TURN - posted <= WIND_DOWN_SLOTS;

      const result = await deps.runMember({
        member: speaker.member,
        windingDown,
        round,
        reason: speaker.reason,
        ...(speaker.namedBy ? { namedBy: speaker.namedBy } : {}),
      });
      posted += result.spoke;
      spokeThisRound += result.spoke;
      for (const text of result.said) {
        said.push({ agentId: speaker.member.id, text });
      }
    }

    /*
     * One member in the room means there is nobody to answer, so a second round is the same Bot
     * talking to itself. A round where nobody spoke means the conversation has settled.
     */
    if (deps.members.length === 1) return { posted, rounds, ended: "alone" };
    if (spokeThisRound === 0) return { posted, rounds, ended: "silent-round" };
  }

  return { posted, rounds, ended: "rounds" };
}
