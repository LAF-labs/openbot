/**
 * Where a turn the server carries out waits for a person.
 *
 * A window used to do the waiting: it held the question, polled for the answer and sent the call
 * again — and a closed window took the wait with it. The server waits now, in this process, for as
 * long as a person could legitimately take (the question's own ten minutes), and any window of the
 * conversation, or none, can be where the answer comes from.
 *
 * In memory by decision (`docs/laf/deployment-model.md`): the approval registry these waits read is
 * in memory too, and a turn that outlives the process is ended honestly at boot, not resumed.
 */
import { APPROVAL_TTL_MS, type ApprovalRegistry } from "../computer/approvals";
import type { AllowanceTier } from "../computer/standing-approvals";

/** How a wait for a person came out. The same four words the window's wait answered with. */
export type PersonAnswer = "granted" | "declined" | "gave up" | "cancelled";

/** How often a waiting turn asks the registry. In-process, so it costs a map lookup. */
const POLL_MS = 400;

/** Sleep, cut short by a stop. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Wait for a person to answer one question, holding it as the step's keeper.
 *
 * HELD, NOT ONLY WATCHED. A window from before this change carries a step on itself when it sees a
 * question nobody holds (`step-watcher.ts` in the app): the server holding it is what keeps an old
 * window from running the same call a second time beside this one. The hold is renewed on every
 * look, well inside the registry's lapse, so it never goes stale while the turn is alive — and it
 * does go stale on its own when the process that held it dies.
 *
 * A stop withdraws the question: nobody is waiting for that answer any more, and no window should
 * go on offering buttons for it.
 */
export async function awaitApproval(
  registry: Pick<ApprovalRegistry, "hold" | "withdraw">,
  input: {
    botId: string;
    approvalId: string;
    /** Who is holding it: the turn, by its run. */
    holder: string;
    signal: AbortSignal;
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<{ answer: PersonAnswer; tier?: AllowanceTier }> {
  const deadline = Date.now() + (input.timeoutMs ?? APPROVAL_TTL_MS);
  const pollMs = input.pollMs ?? POLL_MS;
  while (Date.now() < deadline) {
    if (input.signal.aborted) {
      await registry.withdraw(input.approvalId, input.botId).catch(() => {});
      return { answer: "cancelled" };
    }
    const held = await registry
      .hold(input.approvalId, input.botId, input.holder)
      .catch(() => null);
    // Unreadable is not an answer; gone from a registry that answered is the question ending.
    if (held && !held.ok) return { answer: "gave up" };
    const approval = held?.ok ? held.approval : undefined;
    if (approval?.granted === true) {
      return {
        answer: "granted",
        ...(approval.tier ? { tier: approval.tier } : {}),
      };
    }
    if (approval?.granted === false) return { answer: "declined" };
    await pause(pollMs, input.signal);
  }
  return { answer: "gave up" };
}

/** An answer a window gives to a call only a person can answer: a decision card's choice. */
type Waiting = {
  threadId: string;
  resolve: (
    value: { answered: true; value: unknown } | { answered: false },
  ) => void;
};

/**
 * The calls a turn is waiting on a person to answer through a card — a choice or a decision the
 * Bot put on screen — and the help requests a person chose to skip.
 *
 * Keyed by the tool call's id, which the model's provider mints per call: two calls never share one.
 */
export function createPersonAnswers(
  options: {
    /**
     * The cards a conversation is waiting on changed: one started waiting, or stopped. What tells
     * every window which card to hand a `respond` (`hub.ts`, `waiting` frames).
     */
    onChange?: (threadId: string) => void;
  } = {},
) {
  const waiting = new Map<string, Waiting>();
  const skipped = new Map<string, number>();
  /** A skip nobody read is forgotten after the longest a help request may wait. */
  const SKIP_KEPT_MS = APPROVAL_TTL_MS;

  return {
    /** Wait for a card's answer. Resolves unanswered on a stop or when the time runs out. */
    wait(input: {
      threadId: string;
      toolCallId: string;
      signal: AbortSignal;
      timeoutMs?: number;
    }): Promise<{ answered: true; value: unknown } | { answered: false }> {
      return new Promise((resolve) => {
        const timer = setTimeout(
          () => finish({ answered: false }),
          input.timeoutMs ?? APPROVAL_TTL_MS,
        );
        timer.unref?.();
        const onStop = () => finish({ answered: false });
        function finish(
          value: { answered: true; value: unknown } | { answered: false },
        ) {
          clearTimeout(timer);
          input.signal.removeEventListener("abort", onStop);
          if (waiting.get(input.toolCallId)?.resolve === settle) {
            waiting.delete(input.toolCallId);
            options.onChange?.(input.threadId);
          }
          resolve(value);
        }
        const settle = finish;
        if (input.signal.aborted) return finish({ answered: false });
        input.signal.addEventListener("abort", onStop, { once: true });
        waiting.set(input.toolCallId, {
          threadId: input.threadId,
          resolve: settle,
        });
        options.onChange?.(input.threadId);
      });
    },
    /** A window answered. False when nothing in that conversation is waiting on that call. */
    answer(threadId: string, toolCallId: string, value: unknown): boolean {
      const entry = waiting.get(toolCallId);
      if (!entry || entry.threadId !== threadId) return false;
      entry.resolve({ answered: true, value });
      return true;
    },
    /** The calls in one conversation waiting on a card, for a window that opens mid-wait. */
    awaiting(threadId: string): string[] {
      return [...waiting.entries()]
        .filter(([, entry]) => entry.threadId === threadId)
        .map(([toolCallId]) => toolCallId);
    },
    /** A person pressed 건너뛰기 on a help request: the call goes on without it. */
    skip(toolCallId: string): void {
      const now = Date.now();
      for (const [id, at] of skipped) {
        if (now - at > SKIP_KEPT_MS) skipped.delete(id);
      }
      skipped.set(toolCallId, now);
    },
    /** Read once by the waiting call, which forgets it: a skip answers one request. */
    takeSkip(toolCallId: string): boolean {
      return skipped.delete(toolCallId);
    },
  };
}

export type PersonAnswers = ReturnType<typeof createPersonAnswers>;
