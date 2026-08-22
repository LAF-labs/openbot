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
 * polls (`app/src/lib/approvals.ts`). This is that same wait, on the server, for the loop that runs
 * a room. Same registry, same ten-minute window, same rule that an answer is final.
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
/** How often it looks. The browser's own waiter polls at the same rate. */
export const APPROVAL_POLL_MS = 1_000;

export type ApprovalWaiter = (
  botId: string,
  approvalId: string,
  /** Stop waiting: the turn this wait belongs to is over. */
  signal?: AbortSignal,
) => Promise<ApprovalOutcome>;

export function createApprovalWaiter(
  approvals: Pick<ApprovalRegistry, "pending">,
  options: {
    waitMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): ApprovalWaiter {
  const waitMs = options.waitMs ?? ROOM_APPROVAL_WAIT_MS;
  const pollMs = options.pollMs ?? APPROVAL_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));

  return async function waitForApproval(botId, approvalId, signal) {
    const deadline = now() + waitMs;
    for (;;) {
      /*
       * The turn ended while this was waiting — its deadline fired, or it was aborted. The wait is
       * inside a promise the loop has already walked away from, so without this it keeps polling
       * and, worse, its answer would send the action through on behalf of a turn that is over.
       */
      if (signal?.aborted) return "unanswered";
      /*
       * `pending` includes answered-but-unspent questions on purpose — that is how a waiting caller
       * learns the answer, and it is what the browser's waiter reads too. A question that is GONE
       * from the list expired or was already spent, and there is nothing left to wait for.
       */
      const open = await approvals.pending(botId).catch(() => null);
      if (open) {
        const mine = open.find((approval) => approval.id === approvalId);
        if (!mine) return "unanswered";
        if (mine.granted === true) return "granted";
        if (mine.granted === false) return "denied";
      }
      // A failed read is a blip, not an answer: keep waiting rather than giving up on one query.
      if (now() >= deadline) return "unanswered";
      await sleep(pollMs);
    }
  };
}
