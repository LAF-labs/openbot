import type { Message } from "@ag-ui/core";
import {
  askSubjectOf,
  closeQuestion,
  decideQuestion,
  holdApproval,
  isHeldHere,
  type OpenQuestion,
  openQuestion,
  type PendingApproval,
  questionFromRecord,
  questionOn,
  readApprovals,
} from "@/lib/approvals";
import {
  SOCKET_RECONNECTED,
  socketState,
} from "@/lib/channels/use-channel-events";
import {
  NOTIFICATION_FRAME,
  type NotificationFrame,
  notificationFrames,
} from "@/lib/notifications/outbox";
import {
  resultContent,
  STEP_HANDED_OVER,
  STEP_HANDED_OVER_EVENT,
  type UnansweredCall,
  unansweredCall,
} from "./stranded-steps";

/**
 * EVERY WINDOW OF A CONVERSATION SEES WHAT ITS BOT IS WAITING ON, AND ONE OF THEM CARRIES IT ON.
 *
 * Before 0.5.4 a question was drawn only by the window whose tool call raised it. A second window
 * — the phone, while the PC asked — showed the task stopped and no card, and a reload or a closed
 * window took the card and the task with it (UX review 0.5.4, finding 1). This looks at the
 * server's open questions for this conversation (`step` on each), draws the ones this window's
 * thread holds the call for, and folds them when another window's person answers. And when no live
 * window holds a question's step — its window closed or reloaded, and said so on the way out — this
 * window takes it: it waits on the same question, sends the action once it is allowed, and hands
 * the result back to the Bot, which carries on as though nothing had happened.
 *
 * One at a time per window, and never while this window has a turn of its own in flight.
 */

/** Whether the thread holds a call with this id at all, answered or not. */
function holdsCall(messages: readonly Message[], toolCallId: string): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      ((message as { toolCalls?: { id: string }[] }).toolCalls ?? []).some(
        (call) => call.id === toolCallId,
      ),
  );
}

/**
 * How often a window looks again while it draws a question some other window is holding — to fold
 * the card when that window's person answers — and how often otherwise. The outbox frame is the
 * fast path for a new question; the slow look is for the frame that was missed.
 */
const LOOK_WHILE_SHOWING_MS = 2_000;
const LOOK_OTHERWISE_MS = 15_000;

/**
 * How long a step may be out with another window before this one stops calling it a turn going on.
 * A step takes a second or three, and the longest the computer lets one take is its navigation
 * timeout, 30 s; one waiting on the owner — a 허용, or a person at the wheel for a login — is not
 * this window's to call quiet at all (`CarryOnNotice`, `asksForPerson`). Past this, with neither,
 * it is a window that went quiet: most likely one that crashed, which says nothing, so the server
 * lists its step for ten minutes.
 */
export const ELSEWHERE_AFTER_MS = 60_000;

/** How the server says this thread's turn stands. */
export type TurnState = {
  /** A run on the wire, or a step out with a window: a task here is not stopped yet. */
  goingOn: boolean;
  /**
   * Going on only as a step another window took and has not brought back for far longer than a
   * step takes: "다른 창에서 진행 중이었어요 · 이어서 하기", not a turn this window must wait on.
   */
  elsewhere: boolean;
};

/**
 * Whether the server says this thread's turn is going on: a run on the wire or a step out with a
 * window. Unreachable counts as going on — saying a task stopped is the claim that needs the proof.
 */
export function turnStateOf(body: {
  running?: unknown;
  waiting?: unknown;
  waitingMs?: unknown;
}): TurnState {
  const running = body.running === true;
  const waiting = body.waiting === true;
  return {
    goingOn: running || waiting,
    elsewhere:
      !running &&
      waiting &&
      typeof body.waitingMs === "number" &&
      body.waitingMs >= ELSEWHERE_AFTER_MS,
  };
}

async function turnState(threadId: string): Promise<TurnState> {
  const unknown = { goingOn: true, elsewhere: false };
  try {
    const response = await fetch(
      `/api/copilotkit/threads/${encodeURIComponent(threadId)}/step`,
      { credentials: "include" },
    );
    if (!response.ok) return unknown;
    return turnStateOf(
      (await response.json()) as Parameters<typeof turnStateOf>[0],
    );
  } catch {
    return unknown;
  }
}

export type StepWatcherDeps = {
  botId: string;
  threadId: string;
  /** The thread as this window holds it now. */
  messages: () => readonly Message[];
  /** This window has a turn of its own in flight, so it carries nothing else on. */
  busy: () => boolean;
  /** Fetch the thread and add what this window has not got: a question can arrive before its call. */
  catchUp: () => Promise<void>;
  /** Replace this window's thread with the server's, after another window took a step from it. */
  resync: () => Promise<void>;
  /**
   * Run the Bot's call through its own handler, waiting on the question already open rather than
   * asking again (`resume` in `computer-tools.tsx`). What it hands back is the step's result.
   */
  execute: (
    step: UnansweredCall,
    question: OpenQuestion,
    signal: AbortSignal,
  ) => Promise<unknown>;
  /**
   * Put the result in the thread and hand the turn back to the Bot — unless the person stopped it,
   * in which case the result goes in and nothing runs.
   */
  carryOn: (
    step: UnansweredCall,
    content: string,
    stopped: boolean,
  ) => Promise<void>;
  /**
   * The first look has come back, with whether the turn is still going on somewhere — a run on the
   * wire, or a step another window is making. Until then, and while it is, a call with no result in
   * this window's copy is not a stopped task: it may be one another window is in the middle of.
   */
  onChecked: (goingOn: boolean, elsewhere: boolean) => void;
  /** This window is carrying a step on: the turn is in flight here, for Stop and the composer. */
  onCarrying: (carrying: boolean) => void;
};

/** Watch one conversation. One per mounted conversation; `dispose` when it unmounts. */
export function watchStrandedSteps(deps: StepWatcherDeps): {
  /** Stop the step this window is carrying on, as the conversation's Stop does. */
  stop: () => void;
  dispose: () => void;
} {
  /** Questions this window drew from the server, by approval, with the call they are on. */
  const shown = new Map<string, string>();
  let disposed = false;
  let looking = false;
  let carrying: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The turn was still going on somewhere at the last look; looked at again soon, until it is not. */
  let goingOn = false;

  const schedule = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => void look(),
      shown.size > 0 || goingOn ? LOOK_WHILE_SHOWING_MS : LOOK_OTHERWISE_MS,
    );
  };

  const adopt = async (approval: PendingApproval, step: UnansweredCall) => {
    const controller = new AbortController();
    carrying = controller;
    deps.onCarrying(true);
    // The call's own wait draws and folds the card from here on.
    shown.delete(approval.id);
    try {
      const held = await holdApproval(deps.botId, approval.id);
      if (held.state !== "holding" || disposed) return;
      let result: unknown;
      try {
        result = await deps.execute(
          step,
          questionFromRecord(held.approval),
          controller.signal,
        );
      } catch (error) {
        const said = error instanceof Error ? error.message : String(error);
        if (said === STEP_HANDED_OVER) return;
        // What the core itself writes for a handler that threw, so the Bot reads the same thing.
        result = `Error: ${said}`;
      }
      await deps.carryOn(
        step,
        resultContent(result),
        controller.signal.aborted,
      );
    } finally {
      carrying = undefined;
      deps.onCarrying(false);
    }
  };

  const look = async () => {
    if (disposed || looking) return;
    looking = true;
    try {
      const approvals = await readApprovals(deps.botId);
      if (!approvals || disposed) return;
      const here = approvals.filter(
        (approval) => approval.step?.threadId === deps.threadId,
      );
      if (
        here.some(
          (approval) =>
            approval.step &&
            !holdsCall(deps.messages(), approval.step.toolCallId),
        )
      ) {
        await deps.catchUp();
      }
      for (const approval of here) {
        const toolCallId = approval.step?.toolCallId ?? "";
        // This window's own call is waiting on it, and draws its own card.
        if (isHeldHere(approval.id)) continue;
        const step = unansweredCall(deps.messages(), toolCallId);
        if (!step) continue;
        if (approval.granted === undefined && !questionOn(toolCallId)) {
          openQuestion(toolCallId, questionFromRecord(approval));
          shown.set(approval.id, toolCallId);
        }
        // Nobody alive is holding it: this window carries it on, once it is answered.
        if (!approval.held && !carrying && !deps.busy()) {
          void adopt(approval, step);
        }
      }
      // Answered in another window, or gone: fold the card this window drew.
      for (const [approvalId, toolCallId] of shown) {
        const record = here.find((approval) => approval.id === approvalId);
        if (record && record.granted === undefined) continue;
        shown.delete(approvalId);
        if (record?.granted !== undefined) {
          const subject = askSubjectOf(record.subject);
          decideQuestion(toolCallId, {
            outcome: record.granted ? "allowed" : "declined",
            ...(record.granted && record.tier ? { tier: record.tier } : {}),
            ...(subject ? { subject } : {}),
            approvalId,
            botId: deps.botId,
          });
        } else {
          // Spent, withdrawn or run out, and this window never saw which: the card comes down and
          // the step's own line says what happened once its result arrives.
          closeQuestion(toolCallId);
        }
      }
      const wasGoingOn = goingOn;
      const state = await turnState(deps.threadId);
      goingOn = state.goingOn;
      // It just ended somewhere else: what it said is fetched before anything here reads the thread.
      if (wasGoingOn && !goingOn) await deps.catchUp();
      if (!disposed) deps.onChecked(goingOn, state.elsewhere);
    } finally {
      looking = false;
      schedule();
    }
  };

  const onFrame = (event: Event) => {
    const frame = (event as CustomEvent<NotificationFrame>).detail;
    if (frame?.botId === deps.botId && frame.event.startsWith("approval.")) {
      void look();
    }
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") void look();
  };
  const onHandedOver = () => {
    void deps.resync();
  };
  notificationFrames.addEventListener(NOTIFICATION_FRAME, onFrame);
  socketState.addEventListener(SOCKET_RECONNECTED, onVisible);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener(STEP_HANDED_OVER_EVENT, onHandedOver);
  void look();

  return {
    stop: () => carrying?.abort(),
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      carrying?.abort();
      notificationFrames.removeEventListener(NOTIFICATION_FRAME, onFrame);
      socketState.removeEventListener(SOCKET_RECONNECTED, onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(STEP_HANDED_OVER_EVENT, onHandedOver);
    },
  };
}
