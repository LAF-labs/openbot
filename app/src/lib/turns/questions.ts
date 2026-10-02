/**
 * The questions a server-owned turn is waiting on, put on the lines of the calls that raised them.
 *
 * The server holds the question and waits for its answer (`server/src/turns/people.ts`); a window
 * only draws the card and sends what the person pressed (`approval-request.tsx`, unchanged). Every
 * window of the conversation draws it, off the server's own record — the record names its step —
 * and folds it once anybody, anywhere, has answered.
 *
 * AND EVERY SCREEN KNOWS ONE IS OPEN, NOT ONLY THE CONVERSATION. The record was read by the open
 * conversation alone, and everything that says "the Bot is waiting on you" reads the store this
 * fills: the pill under the Bot's name and the tray, the sidebar's 기다리는 일, 오늘's mark, the
 * phone bar's dot. So a Bot that stopped to ask while the person was reading 소식 said nothing on
 * that screen, and the question ran out its ten minutes unseen; and a question that was open when
 * the person left the conversation went on saying 확인 필요 after somebody had answered it
 * elsewhere, because nothing was left to hear that it had been. The shell keeps a watch of its own
 * now (`watchShellQuestions`, mounted once for every signed-in screen): it stands down while a
 * conversation of the Bot's is watching, and takes over the moment that conversation leaves.
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
import { OUTAGE_CAP_MS } from "@/lib/polling";

/** How often a window looks while the turn is going, and while it is not. */
const LOOK_WHILE_GOING_MS = 1_500;
const LOOK_OTHERWISE_MS = 15_000;

type Shown = { toolCallId: string; threadId: string };

/**
 * Questions drawn from the server, per Bot, by approval: the call each is on and its conversation.
 *
 * One map for every watcher of a Bot, so whichever looks next folds what another one drew. Each
 * used to keep its own, and a card drawn by a conversation that then left the screen had nobody
 * who knew it was there to close.
 */
const shownByBot = new Map<string, Map<string, Shown>>();

/** How many conversations on this screen are watching each Bot's questions themselves. */
const conversations = new Map<string, number>();
/** The shell's look, per Bot: what a conversation calls as it leaves. */
const shellLooks = new Map<string, () => void>();

function shownFor(botId: string): Map<string, Shown> {
  let shown = shownByBot.get(botId);
  if (!shown) {
    shown = new Map();
    shownByBot.set(botId, shown);
  }
  return shown;
}

/**
 * Put what the server's record says on the lines it names, and fold what it no longer holds.
 *
 * `threadId` narrows it to one conversation, which is what a conversation's own watch does; without
 * one it covers every conversation of the Bot.
 */
function settle(
  botId: string,
  approvals: PendingApproval[],
  threadId: string | undefined,
): void {
  const shown = shownFor(botId);
  const open = new Set<string>();
  for (const approval of approvals) {
    const step = approval.step;
    if (!step?.toolCallId) continue;
    if (threadId !== undefined && step.threadId !== threadId) continue;
    if (approval.granted === undefined) {
      open.add(approval.id);
      if (!questionOn(step.toolCallId)) {
        openQuestion(step.toolCallId, questionFromRecord(approval));
      }
      shown.set(approval.id, {
        toolCallId: step.toolCallId,
        threadId: step.threadId,
      });
      continue;
    }
    // Answered somewhere — here, in another window, or on the approval's own page.
    if (!decisionOn(step.toolCallId)) {
      decideQuestion(step.toolCallId, {
        outcome: approval.granted ? "allowed" : "declined",
        ...(approval.granted && approval.tier ? { tier: approval.tier } : {}),
        ...(approval.subject ? { subject: approval.subject } : {}),
        ...(approval.granted
          ? {}
          : { approvalId: approval.id, botId: approval.botId }),
      });
    }
    shown.delete(approval.id);
  }
  // Gone from the record — spent on its call, withdrawn by a stop, or run out: no more buttons.
  for (const [approvalId, card] of shown) {
    if (open.has(approvalId)) continue;
    if (threadId !== undefined && card.threadId !== threadId) continue;
    shown.delete(approvalId);
    closeQuestion(card.toolCallId);
  }
}

/** A conversation's own watch: its thread's questions, quickly while its turn is going. */
export function watchServerQuestions(deps: {
  botId: string;
  threadId: string;
  /** Whether the conversation's turn is going: questions only arise then. */
  going: () => boolean;
  read?: (botId: string) => Promise<PendingApproval[] | null>;
}): { look: () => void; dispose: () => void } {
  const read = deps.read ?? readApprovals;
  let disposed = false;
  let looking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  conversations.set(deps.botId, (conversations.get(deps.botId) ?? 0) + 1);

  const isShowing = () =>
    [...shownFor(deps.botId).values()].some(
      (card) => card.threadId === deps.threadId,
    );

  const schedule = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => void look(),
      deps.going() || isShowing() ? LOOK_WHILE_GOING_MS : LOOK_OTHERWISE_MS,
    );
  };

  const look = async () => {
    if (disposed || looking) return;
    looking = true;
    try {
      const approvals = await read(deps.botId);
      if (!approvals || disposed) return;
      settle(deps.botId, approvals, deps.threadId);
    } finally {
      looking = false;
      schedule();
    }
  };

  void look();
  return {
    look: () => void look(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      const left = (conversations.get(deps.botId) ?? 1) - 1;
      if (left > 0) conversations.set(deps.botId, left);
      else conversations.delete(deps.botId);
      /*
       * The conversation has left the screen with its cards still in the store: the shell's turn.
       * A turn later, and only if nobody has taken its place — an effect that merely ran again
       * disposes one watch and starts the next in the same breath, and that is not leaving.
       */
      queueMicrotask(() => {
        if ((conversations.get(deps.botId) ?? 0) > 0) return;
        shellLooks.get(deps.botId)?.();
      });
    },
  };
}

/**
 * The shell's watch of one Bot's questions, for every screen that is not its conversation.
 *
 * IT DOES NOT POLL WHILE NOTHING IS OPEN. A look is asked for — on mounting, when the server's
 * outbox says something happened to this Bot, when the socket comes back, when the window is looked
 * at again, when a conversation leaves — and only a question on screen keeps it looking by itself,
 * at the conversation's own pace, because nothing announces that a question was answered in another
 * window or ran out. A watch that asked every fifteen seconds on every signed-in screen, all day,
 * for a thing that happens a few times a week, is the kind of poll the 2026-09-10 audit counted
 * (`lib/polling.ts`: 53 requests a minute from one idle screen).
 *
 * A READ THAT FAILS IS ASKED AGAIN, because the nudge that caused it will not come twice and the
 * question it was about is still waiting — but at the long interval, doubling to a minute: a server
 * that is down is not asked every second and a half.
 */
export function watchShellQuestions(deps: {
  botId: string;
  read?: (botId: string) => Promise<PendingApproval[] | null>;
  /** The two waits, for a test that cannot sit through them. */
  pace?: { whileOpenMs: number; afterFailureMs: number };
}): { look: () => void; dispose: () => void } {
  const read = deps.read ?? readApprovals;
  const whileOpenMs = deps.pace?.whileOpenMs ?? LOOK_WHILE_GOING_MS;
  const afterFailureMs = deps.pace?.afterFailureMs ?? LOOK_OTHERWISE_MS;
  let disposed = false;
  let looking = false;
  /** Asked for while a look was in flight: what that look read may already be old. */
  let again = false;
  /** Reads in a row that the server did not answer. */
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const isConversationWatching = () => (conversations.get(deps.botId) ?? 0) > 0;

  const look = async () => {
    if (disposed) return;
    // A conversation of this Bot's is on screen and watching: its word, not a second request.
    if (isConversationWatching()) return;
    if (looking) {
      again = true;
      return;
    }
    looking = true;
    again = false;
    clearTimeout(timer);
    let answered = false;
    try {
      const approvals = await read(deps.botId);
      if (!approvals || disposed) return;
      answered = true;
      if (!isConversationWatching()) settle(deps.botId, approvals, undefined);
    } finally {
      looking = false;
      if (!disposed && !isConversationWatching()) {
        if (!answered) {
          failures += 1;
          timer = setTimeout(
            () => void look(),
            Math.min(OUTAGE_CAP_MS, afterFailureMs * 2 ** (failures - 1)),
          );
        } else {
          failures = 0;
          if (again) void look();
          else if (shownFor(deps.botId).size > 0) {
            timer = setTimeout(() => void look(), whileOpenMs);
          }
        }
      }
    }
  };

  shellLooks.set(deps.botId, () => void look());
  void look();
  return {
    look: () => void look(),
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      shellLooks.delete(deps.botId);
    },
  };
}

/** For the tests: nothing drawn, nobody watching. */
export function forgetWatchedQuestions(): void {
  for (const shown of shownByBot.values()) {
    for (const card of shown.values()) closeQuestion(card.toolCallId);
  }
  shownByBot.clear();
  conversations.clear();
  shellLooks.clear();
}
