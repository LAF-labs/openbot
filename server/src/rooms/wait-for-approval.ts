/**
 * Waiting, in a room, for a person to answer a question a member's action raised.
 *
 * THE ROOM WAITS BECAUSE SOMEBODY IS WATCHING. `runUnattended` was written for work nobody is
 * looking at, so a tool that meets an `ask` rule is told "a person has to allow that, and nobody is
 * here right now — say what you were waiting for and stop". In a routine that is exactly right. In
 * a room it is wrong twice over: the person IS here, looking at the message, and the card with the
 * buttons is on their screen. Measured before this: a member said "wttr.in 페이지 열기가 승인 대기
 * 중입니다", the person pressed Allow, and nothing happened — the turn had already ended, so the
 * grant was spent on nothing and the room simply went quiet.
 *
 * The one-to-one conversation has always waited: the browser's loop holds its tool call open and
 * polls (`app/src/lib/approvals.ts`). A browser has to poll — it cannot hold a promise on this
 * heap. This wait can, and used to poll anyway: it asked the registry in this very process for its
 * list of open questions once a second for two minutes, to learn something the registry knew the
 * instant it happened. It now asks to be told (`ApprovalRegistry.waitFor`), so the turn resumes in
 * the same tick the button is pressed and a wait costs nothing while nobody is answering.
 *
 * BOUNDED, because a room is a conversation and the other members are queued behind this one. Two
 * minutes is long enough for somebody at the screen and short of a turn that hangs because the
 * person walked away; the member's own turn deadline (five minutes) is the outer bound either way.
 * Nobody answering is not a failure — the member says it is waiting, as it did before, and the
 * question stays open on screen for the rest of its ten minutes. The next time that member tries
 * the same action, the answer given late is there waiting for it.
 */
import type { ApprovalRegistry } from "../computer/approvals";

/** What a wait ended with. `unanswered` covers "nobody answered", "expired" and "already spent". */
export type ApprovalOutcome = "granted" | "denied" | "unanswered";

/** How long a room turn will hold for an answer. */
export const ROOM_APPROVAL_WAIT_MS = 120_000;

export type ApprovalWaiter = (
  botId: string,
  approvalId: string,
  /** Stop waiting: the turn this wait belongs to is over. */
  signal?: AbortSignal,
) => Promise<ApprovalOutcome>;

export function createApprovalWaiter(
  approvals: Pick<ApprovalRegistry, "waitFor">,
  options: { waitMs?: number } = {},
): ApprovalWaiter {
  const waitMs = options.waitMs ?? ROOM_APPROVAL_WAIT_MS;

  return async function waitForApproval(botId, approvalId, signal) {
    /*
     * A wait that throws is a wait that ended, and it ended without an answer. Nothing here is
     * allowed to fail a member's turn: the question is still on screen, and the honest report is
     * the same one nobody answering gets.
     */
    const answered = await approvals
      .waitFor(botId, approvalId, {
        ...(signal ? { signal } : {}),
        timeoutMs: waitMs,
      })
      .catch(() => null);

    /*
     * Null is expiry, an abandoned turn, a question spent elsewhere, or nobody answering in time —
     * one ending, because the member does the same thing with all four: it says it is still waiting
     * and stops. `granted === undefined` cannot happen through `waitFor`, and is read the same way
     * rather than trusted.
     */
    if (!answered || answered.granted === undefined) return "unanswered";
    return answered.granted ? "granted" : "denied";
  };
}
