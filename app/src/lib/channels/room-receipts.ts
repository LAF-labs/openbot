/**
 * Who read a question in a room and stayed quiet, who could not answer it, and where that is drawn.
 *
 * MEASURED 2026-09-21, against a real model: in a room of three one Bot chose not to speak — which
 * the room allows, and which is often the right answer — and to the person it looked as if that Bot
 * were not in the room at all. Silence, a failure and a timeout were the same nothing on screen.
 *
 * So a room turn leaves a receipt, the way a messenger does: the faces of the members that read the
 * question and had nothing to add, small, under the turn's last bubble — under the person's own
 * message when nobody answered at all. No sentence in the flow of the conversation; the words are
 * in the receipt's label. A member that could not answer is not silence and is not drawn as it: it
 * wears the face that asks for help, with a way to ask it again.
 *
 * The server sends kinds (`server/src/rooms/outcomes.ts`); this owns the words and the placement.
 * Pure, so the rules can be asserted without a socket or a component.
 */

/** The kinds the server sends. Declared again here, as the frame kinds are; see `room-frames.ts`. */
export const MEMBER_OUTCOMES = [
  "spoke",
  "passed",
  "failed",
  "timed_out",
  "stopped",
] as const;

export type MemberOutcome = (typeof MEMBER_OUTCOMES)[number];

/** What a receipt draws. `spoke` is its words and `stopped` is nothing anybody can say. */
export type ReceiptOutcome = Extract<
  MemberOutcome,
  "passed" | "failed" | "timed_out"
>;

/** Member id to how that member's part in one turn came out. */
export type Heard = Readonly<Record<string, MemberOutcome>>;

/** One face on a receipt: which member, how it came out, and the question it was asked. */
export type ReceiptMark = {
  memberId: string;
  outcome: ReceiptOutcome;
  /** The person's message the turn answered — what 다시 묻기 asks again. */
  questionId: string;
};

export function memberOutcomeOf(value: unknown): MemberOutcome | undefined {
  return typeof value === "string" &&
    (MEMBER_OUTCOMES as readonly string[]).includes(value)
    ? (value as MemberOutcome)
    : undefined;
}

/** A stored receipt — member id to outcome — with anything this surface does not know dropped. */
export function heardOf(value: unknown): Heard {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const heard: Record<string, MemberOutcome> = {};
  for (const [memberId, outcome] of Object.entries(value)) {
    const known = memberOutcomeOf(outcome);
    if (known) heard[memberId] = known;
  }
  return heard;
}

/** The `members` of a `room.done` frame — `[{ id, outcome }]` — as a receipt. */
export function heardFromList(value: unknown): Heard {
  if (!Array.isArray(value)) return {};
  const heard: Record<string, MemberOutcome> = {};
  for (const entry of value) {
    const id = (entry as { id?: unknown } | null)?.id;
    const outcome = memberOutcomeOf(
      (entry as { outcome?: unknown } | null)?.outcome,
    );
    if (typeof id === "string" && outcome) heard[id] = outcome;
  }
  return heard;
}

/**
 * The server's rule for a member asked twice in one turn, kept identical here because the screen
 * folds the same frames the server summarises: spoke at any point wins, a stop changes nothing.
 */
export function settleOutcome(
  previous: MemberOutcome | undefined,
  next: MemberOutcome,
): MemberOutcome {
  if (previous === "spoke") return "spoke";
  if (next === "stopped" && previous !== undefined) return previous;
  return next;
}

function drawn(outcome: MemberOutcome): outcome is ReceiptOutcome {
  return (
    outcome === "passed" || outcome === "failed" || outcome === "timed_out"
  );
}

/** The part of a message placement reads. A room's messages and AG-UI's both have it. */
type Placed = { id: string; role: string; content?: unknown };

/**
 * Every message in a turn that left a receipt: the question and the replies under it.
 *
 * The transcript's failure line (`TurnFailed`) is keyed to the last message a failed run wrote, and
 * in a room that is either the question — "no answer came back", even when two of three answered —
 * or a member's own reply, when its run failed after it had spoken. The receipt says the first
 * member by member, and a room's reply is always whole (`send_message` delivers finished messages
 * only), so the second is a member whose words are in the room: measured, a reply the timeout
 * harvest had kept sat above a red "the model took too long" as if it had been cut off. A turn
 * with a receipt draws neither; turns from before receipts keep the line.
 */
export function receiptTurns(
  messages: readonly Placed[],
  receipts: Readonly<Record<string, Heard>>,
): Set<string> {
  const covered = new Set<string>();
  let inside = false;
  for (const message of messages) {
    if (message.role === "user") inside = Boolean(receipts[message.id]);
    if (inside) covered.add(message.id);
  }
  return covered;
}

/**
 * The transcript's standing failures, less the ones a receipt already speaks for.
 *
 * One function for the live screen and the reloaded one, because they disagreed: a reply the
 * timeout harvest kept is a member's run that ended in error with the reply as its last message, so
 * the failures read put "the model took too long" under an answer that had arrived — on the screen
 * that had the stored failures and not yet the receipt, and not on the one read after it.
 */
export function withoutReceiptTurns<Failure>(
  standing: Readonly<Record<string, Failure>>,
  messages: readonly Placed[],
  receipts: Readonly<Record<string, Heard>>,
): Record<string, Failure> {
  const covered = receiptTurns(messages, receipts);
  return Object.fromEntries(
    Object.entries(standing).filter(([messageId]) => !covered.has(messageId)),
  );
}

/**
 * Whether a reply has any words yet. A member's message is on screen from the moment it opens,
 * empty, and the transcript draws nothing for it until its first word — so a receipt anchored to
 * it would vanish for that moment and come back.
 */
function hasWords(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.length > 0;
}

/**
 * The turn in flight: who has been asked so far, and how the ones that finished came out.
 *
 * A member asked again — 다시 묻기, or the whole question asked again — is not what the question's
 * stored receipt says any more: it is working, or it has just settled differently. So for the
 * question being answered right now, the stored receipt gives way to this, member by member.
 */
export type LiveTurn = { asked: readonly string[]; settled: Heard };

/**
 * Where each receipt goes: anchor message id to the faces drawn under it.
 *
 * THE END OF THE TURN. The anchor is the last thing said in answer to a question — the last message
 * before the person's next one — which is the person's own message when nobody answered. The turn
 * in flight is always the last question in the room (a new message starts one; asking again is
 * only offered on the last), so its receipt sits at the very end and grows as members settle.
 *
 * In the room's own order (`order`), so a member's face does not move about from one turn to the
 * next; the stored receipt is a jsonb object, whose keys come back in no order worth keeping.
 */
export function placeReceipts(
  messages: readonly Placed[],
  receipts: Readonly<Record<string, Heard>>,
  live: LiveTurn | null,
  order: readonly string[],
): Record<string, ReceiptMark[]> {
  const rank = new Map(order.map((id, index) => [id, index]));
  const placed: Record<string, ReceiptMark[]> = {};
  const questions = messages.filter((message) => message.role === "user");
  const lastQuestion = questions.at(-1)?.id;

  const marksFor = (questionId: string): ReceiptMark[] => {
    const stored = receipts[questionId] ?? {};
    const heard: Record<string, MemberOutcome> =
      live && questionId === lastQuestion
        ? {
            ...Object.fromEntries(
              Object.entries(stored).filter(
                ([memberId]) => !live.asked.includes(memberId),
              ),
            ),
            ...live.settled,
          }
        : { ...stored };
    return Object.entries(heard)
      .filter((entry): entry is [string, ReceiptOutcome] => drawn(entry[1]))
      .sort(
        ([left], [right]) =>
          (rank.get(left) ?? order.length) - (rank.get(right) ?? order.length),
      )
      .map(([memberId, outcome]) => ({ memberId, outcome, questionId }));
  };

  let question: string | null = null;
  let anchor: string | null = null;
  const close = () => {
    if (question === null || anchor === null) return;
    const marks = marksFor(question);
    if (marks.length > 0) placed[anchor] = marks;
  };
  for (const message of messages) {
    if (message.role === "user") {
      close();
      question = message.id;
      anchor = message.id;
    } else if (
      message.role === "assistant" &&
      question !== null &&
      hasWords(message.content)
    ) {
      anchor = message.id;
    }
  }
  close();
  return placed;
}
