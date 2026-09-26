/**
 * The questions a server-owned turn is waiting on, put on the lines of the calls that raised them.
 *
 * The server holds the question and waits for its answer (`server/src/turns/people.ts`); a window
 * only draws the card and sends what the person pressed (`approval-request.tsx`, unchanged). Every
 * window of the conversation draws it, off the server's own record — the record names its step —
 * and folds it once anybody, anywhere, has answered.
 */
import {
  closeQuestion,
  decideQuestion,
  decisionOn,
  openQuestion,
  type PendingApproval,
  questionFromRecord,
  questionOn,
  readApprovals,
} from "@/lib/approvals";

/** How often a window looks while the turn is going, and while it is not. */
const LOOK_WHILE_GOING_MS = 1_500;
const LOOK_OTHERWISE_MS = 15_000;

export function watchServerQuestions(deps: {
  botId: string;
  threadId: string;
  /** Whether the conversation's turn is going: questions only arise then. */
  going: () => boolean;
  read?: (botId: string) => Promise<PendingApproval[] | null>;
}): { look: () => void; dispose: () => void } {
  const read = deps.read ?? readApprovals;
  /** Questions drawn from the server, by approval, with the call each is on. */
  const shown = new Map<string, string>();
  let disposed = false;
  let looking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => void look(),
      deps.going() || shown.size > 0 ? LOOK_WHILE_GOING_MS : LOOK_OTHERWISE_MS,
    );
  };

  const look = async () => {
    if (disposed || looking) return;
    looking = true;
    try {
      const approvals = await read(deps.botId);
      if (!approvals || disposed) return;
      const here = approvals.filter(
        (approval) => approval.step?.threadId === deps.threadId,
      );
      const open = new Set<string>();
      for (const approval of here) {
        const toolCallId = approval.step?.toolCallId ?? "";
        if (!toolCallId) continue;
        if (approval.granted === undefined) {
          open.add(approval.id);
          if (!questionOn(toolCallId)) {
            openQuestion(toolCallId, questionFromRecord(approval));
          }
          shown.set(approval.id, toolCallId);
          continue;
        }
        // Answered somewhere — here, in another window, or on the approval's own page.
        if (!decisionOn(toolCallId)) {
          decideQuestion(toolCallId, {
            outcome: approval.granted ? "allowed" : "declined",
            ...(approval.granted && approval.tier
              ? { tier: approval.tier }
              : {}),
            ...(approval.subject ? { subject: approval.subject } : {}),
            ...(approval.granted
              ? {}
              : { approvalId: approval.id, botId: approval.botId }),
          });
        }
        shown.delete(approval.id);
      }
      // Gone from the record — spent on its call, withdrawn by a stop, or run out: no more buttons.
      for (const [approvalId, toolCallId] of shown) {
        if (open.has(approvalId)) continue;
        shown.delete(approvalId);
        closeQuestion(toolCallId);
      }
    } finally {
      looking = false;
      schedule();
    }
  };

  void look();
  return {
    look: () => void look(),
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
