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
 * WHO IS ADDRESSED IS FIXED FOR THE TURN: the names in the person's message, or everybody. The
 * reference lets a member pull a colleague in by @-naming them mid-turn and re-reads the room each
 * round to find out; this does not yet, and says so rather than pretending. The seam is
 * `addressedIds` — make it a function of the lines said so far and the rest follows.
 *
 * THE ORDER ROTATES. Whoever speaks first sets the frame, and the same Bot opening every round is
 * the same Bot deciding what the room is about every round.
 *
 * A SILENT ROUND ENDS IT. Nobody had anything to add, and asking again produces filler — which is
 * exactly what a model does when asked a second time.
 *
 * THE EPOCH IS CHECKED BETWEEN MEMBERS, NEVER BETWEEN A MEMBER FINISHING AND ITS WORDS LANDING. A
 * member that has already thought is a member whose sentence is worth keeping, even if the person
 * has moved on; dropping it would lose work that was done and paid for.
 */
import {
  addressedMembers,
  ROOM_MESSAGES_PER_TURN,
  ROOM_ROUNDS,
  type RoomMember,
  rotate,
  WIND_DOWN_SLOTS,
} from "./prompt";

export type RoomTurnDeps = {
  /** The room's Bots, in the room's one order. */
  members: readonly RoomMember[];
  /** Who the person named. Empty means everybody — see `addressedMembers`. */
  addressedIds: readonly string[];
  /**
   * Whether this is still the turn the room is waiting on.
   *
   * False the moment the person says something else. Checked before every member so a superseded
   * turn stops at the next boundary rather than finishing three more rounds nobody is reading.
   */
  isCurrent: () => Promise<boolean>;
  /** Ask one member to take its turn. Returns how many messages it put in the room. */
  runMember: (input: {
    member: RoomMember;
    windingDown: boolean;
  }) => Promise<number>;
};

export type RoomTurnOutcome = {
  /** Messages put in the room by everybody, this turn. */
  posted: number;
  /** How many rounds were actually opened. */
  rounds: number;
  /** Why it ended, for the record and for the tests. */
  ended: "silent-round" | "rounds" | "full" | "superseded" | "alone";
};

export async function runRoomTurn(
  deps: RoomTurnDeps,
): Promise<RoomTurnOutcome> {
  let posted = 0;
  let rounds = 0;

  for (let round = 0; round < ROOM_ROUNDS; round += 1) {
    if (!(await deps.isCurrent())) {
      return { posted, rounds, ended: "superseded" };
    }

    const speaking = rotate(
      addressedMembers(deps.members, deps.addressedIds),
      round,
    );
    if (speaking.length === 0) return { posted, rounds, ended: "alone" };

    rounds += 1;
    let spokeThisRound = 0;

    for (const member of speaking) {
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

      const spoke = await deps.runMember({ member, windingDown });
      posted += spoke;
      spokeThisRound += spoke;
    }

    /*
     * One member in the room means there is nobody to answer, so a second round is the same Bot
     * talking to itself. A round where nobody spoke means the conversation has settled.
     */
    if (speaking.length === 1) return { posted, rounds, ended: "alone" };
    if (spokeThisRound === 0) return { posted, rounds, ended: "silent-round" };
  }

  return { posted, rounds, ended: "rounds" };
}
