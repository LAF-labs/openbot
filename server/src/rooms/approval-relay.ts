/**
 * A member's toolkit, with the questions its actions raise carried to the room and back.
 *
 * Everything a Bot does in a room goes through one `execute`, which makes it the one place that can
 * see an action stop at a boundary. Three things have to happen there and they only make sense
 * together, which is why they are one wrapper rather than three:
 *
 * THE QUESTION IS RAISED TO THE ROOM. A one-to-one conversation draws it on the tool call's own
 * line; a room draws no tool calls, because a member's working is private and only what it sends is
 * shown. So it is announced, with who asked, and the room puts the buttons above the composer.
 *
 * THE TURN HOLDS. `runUnattended` was written for work nobody is watching and gives up on an `ask`
 * rule. In a room the person is right there, so the member waits (see `wait-for-approval.ts`).
 *
 * THE ANSWER TRAVELS WITH THE RETRY. The gateway spends an approval by id AND fingerprint. A retry
 * that presents neither is just a fresh attempt, and the policy raises a SECOND question for the
 * same action: measured, a new pending row 400 ms after the person pressed Allow, and the answer
 * they gave paid for nothing. The browser's retry has always presented it (`withApproval`); this is
 * the same contract for the loop that runs a room.
 *
 * Once, never in a loop. If the retry meets a boundary again, that is what the member is told —
 * an approval that does not fit its action is a fact to report, not a thing to keep asking about.
 */
import type { ToolOutcome, UnattendedToolkit } from "../runner/unattended";
import type { ApprovalWaiter } from "./wait-for-approval";

/** A question, as the room needs to show it. */
export type RoomQuestion = {
  approvalId: string;
  question: string;
  rule: string;
};

/** What a member is told when the person said no. Model-facing, so it says what to do next. */
export const DECLINED =
  "A person was asked and said no. Do not try it again; say what you could not do.";

function questionOf(outcome: ToolOutcome): RoomQuestion | null {
  const approvalId = outcome.approvalId;
  if (outcome.awaitingApproval !== true || typeof approvalId !== "string") {
    return null;
  }
  return {
    approvalId,
    question: typeof outcome.question === "string" ? outcome.question : "",
    rule: typeof outcome.rule === "string" ? outcome.rule : "",
  };
}

export function relayApprovals(
  base: UnattendedToolkit,
  options: {
    /** The Bot the question is asked about; the registry files answers under it. */
    memberId: string;
    /**
     * Show the question, and take it down again.
     *
     * `answered` true is sent only when a person actually answered. A wait that timed out announces
     * nothing further, because the question is still open and answering it late still counts — the
     * member's next attempt finds the answer waiting.
     */
    announce: (question: RoomQuestion, answered: boolean) => void;
    /** Absent where nothing can wait: the member then reports that it is waiting, as before. */
    wait?: ApprovalWaiter;
    /**
     * Aborted when the member's turn is over, however it ended.
     *
     * The run's deadline rejects the call and walks away from this promise; it does not stop it. So
     * without this the wait keeps polling after the turn is dead and, when the person finally
     * answers, performs the action on behalf of a turn nobody is watching any more.
     */
    signal?: AbortSignal;
  },
): UnattendedToolkit {
  return {
    tools: base.tools,
    execute: async (name, args, call) => {
      const outcome = await base.execute(name, args, call);
      const question = questionOf(outcome);
      if (!question) return outcome;

      options.announce(question, false);
      const answer = await options.wait?.(
        options.memberId,
        question.approvalId,
        options.signal,
      );

      // Checked again after the wait as well as inside it: an answer that arrived in the same tick
      // as the turn's end must not be spent on it.
      if (options.signal?.aborted) return outcome;

      if (answer === "granted") {
        options.announce(question, true);
        return base.execute(name, args, {
          id: call?.id ?? "",
          approvalId: question.approvalId,
        });
      }
      if (answer === "denied") {
        options.announce(question, true);
        return { ok: false, refused: true, reason: DECLINED };
      }
      return outcome;
    },
  };
}
