/**
 * How one member's part in a room turn came out, as a fact the screen draws from.
 *
 * MEASURED 2026-09-21, against a real model: in a room of three, one Bot said nothing in round 0 —
 * a deliberate silence, which the room's prompt allows — and to the person it looked as if that
 * Bot were not in the room at all. The orchestrator counted a member's result only as "messages
 * spoken", so a member with nothing to add, a member whose provider was down and a member that ran
 * out of time were the same zero, and nothing about any of them reached the screen.
 *
 * So the member's turn ends in one of these, and the room keeps them — on the socket while the turn
 * runs, and on the person's question afterwards, so they survive a reload:
 *
 *  - `spoke`: it put something in the room. Its words are the record; nothing else is drawn.
 *  - `passed`: it ended normally without `send_message`. It read the question and had nothing to add.
 *  - `failed`: it could not take its turn — a dead endpoint, a provider refusing, a stream cut.
 *  - `timed_out`: it ran out of time (`MEMBER_TURN_TIMEOUT_MS`), or its model did.
 *  - `stopped`: the turn ended under it — a person's `모두 멈추기`, or the person moving on before
 *    its place in the queue came up. Nothing is known about what it would have said, so the screen
 *    says nothing about it either, and a stop never overwrites what the room already knew.
 *
 * The server sends these and never a sentence (CLAUDE.md, "the server sends facts"). Pure, and
 * imported by the orchestrator, which is pure; how one member's run is read into a kind is
 * `outcomeOf` in `member-turn.ts`, beside the run.
 */
export const MEMBER_OUTCOMES = [
  "spoke",
  "passed",
  "failed",
  "timed_out",
  "stopped",
] as const;

export type MemberOutcome = (typeof MEMBER_OUTCOMES)[number];

export function isMemberOutcome(value: unknown): value is MemberOutcome {
  return (
    typeof value === "string" &&
    (MEMBER_OUTCOMES as readonly string[]).includes(value)
  );
}

/** One member's outcome for a whole room turn. */
export type MemberReceipt = { id: string; outcome: MemberOutcome };

/**
 * A member asked twice in one turn — by the person, then by a colleague — has one outcome for it.
 *
 * Spoke at any point wins: its words are in the room. Otherwise the later asking is the newer fact,
 * except a stop, which says nothing about the member and so changes nothing.
 */
export function settleOutcome(
  previous: MemberOutcome | undefined,
  next: MemberOutcome,
): MemberOutcome {
  if (previous === "spoke") return "spoke";
  if (next === "stopped" && previous !== undefined) return previous;
  return next;
}

/**
 * The turn's outcomes, one per member, in the order they were first asked.
 *
 * A member whose only asking was cut by a stop is left out: there is nothing true to say about it,
 * and the question's record must not lose what an earlier turn learned about that member.
 */
export function summariseOutcomes(
  asked: readonly MemberReceipt[],
): MemberReceipt[] {
  const settled = new Map<string, MemberOutcome>();
  for (const { id, outcome } of asked) {
    settled.set(id, settleOutcome(settled.get(id), outcome));
  }
  return [...settled]
    .filter(([, outcome]) => outcome !== "stopped")
    .map(([id, outcome]) => ({ id, outcome }));
}
