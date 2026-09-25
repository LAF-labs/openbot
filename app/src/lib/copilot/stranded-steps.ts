import type { Message } from "@ag-ui/core";

/**
 * A BOT'S STEP THAT OUTLIVED ITS WINDOW, found in the thread a window opened (UX review 0.5.4,
 * candidate 1, audit item 16 from 0.5.3).
 *
 * Every computer tool runs in the window: the Bot asks for a click, its run ENDS, and the window
 * makes the click and starts the next run with the result. So the window was the only thing
 * holding a task together, and closing or reloading it mid-step — worst of all while it waited on
 * the owner's 허용 — left a tool call with no result that nothing would ever answer. A second
 * window showed the task stopped and no card, and the ledger wrote the turn `done`.
 *
 * The server now keeps the question with its step on it (`server/src/computer/approvals.ts`), and a
 * window that opens the conversation finds the call here, draws the card on it, and — when no other
 * live window holds it — carries the step on once it is answered. What cannot be carried on (a
 * click whose window closed with no question open) is said as stopped, with a way to continue.
 *
 * Pure: the thread in, facts out, so the rules can be checked without a browser. The watching is
 * `step-watcher.ts`.
 */

/**
 * Said by a call whose step another window took over while this one was asleep. Thrown, not
 * returned: a handler that throws gets no follow-up run from the core, and a follow-up would carry
 * the same step on a second time.
 */
export const STEP_HANDED_OVER = "laf:step_handed_over";

/** The window event that says so, for the conversation to fetch the thread as it now stands. */
export const STEP_HANDED_OVER_EVENT = "laf-step-handed-over";

type ToolCall = {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
};
type AssistantWithCalls = Message & {
  role: "assistant";
  toolCalls: ToolCall[];
};

function hasCalls(message: Message | undefined): message is AssistantWithCalls {
  return (
    message?.role === "assistant" &&
    Array.isArray((message as { toolCalls?: unknown }).toolCalls) &&
    ((message as { toolCalls: unknown[] }).toolCalls.length ?? 0) > 0
  );
}

function resultOf(
  messages: readonly Message[],
  toolCallId: string,
): Message | undefined {
  return messages.find(
    (message) =>
      message.role === "tool" &&
      (message as { toolCallId?: string }).toolCallId === toolCallId,
  );
}

/** A call the thread holds with no result yet, and the message it is on. */
export type UnansweredCall = { messageId: string; call: ToolCall };

/**
 * The call with this id, if the thread holds it and nothing has answered it — the only kind a
 * window may carry on. A call with a result has been carried on already, by whichever window.
 */
export function unansweredCall(
  messages: readonly Message[],
  toolCallId: string,
): UnansweredCall | undefined {
  for (const message of messages) {
    if (!hasCalls(message)) continue;
    const call = message.toolCalls.find((one) => one.id === toolCallId);
    if (!call) continue;
    return resultOf(messages, toolCallId)
      ? undefined
      : { messageId: message.id, call };
  }
  return undefined;
}

/**
 * How the conversation's last task ended, when it ended in the middle of the Bot's work.
 *
 * `window_closed`: the Bot's last message asked for steps and at least one never got a result —
 * its window went away with it. `stopped`: every step answered, and one of them says the person
 * stopped it (`laf:stopped`). Null when the Bot said something after its last step, when the person
 * spoke since, or when nothing was stopped: those are ordinary endings, or somebody else's line.
 */
export type TaskStop = {
  reason: "window_closed" | "stopped";
  /** The calls with no result, which a question may still be open on. */
  unanswered: string[];
};

export function taskStopOf(
  messages: readonly Message[],
  /**
   * The turn left a failure line. A turn cut off between two steps is the person's Stop only when
   * it did not: one that failed there says so on its own line, with 다시 시도.
   */
  { failed = false }: { failed?: boolean } = {},
): TaskStop | null {
  let index = messages.length - 1;
  // Past the step results at the end, to the message that asked for them.
  while (index >= 0 && messages[index]?.role === "tool") index -= 1;
  const asked = messages[index];
  if (!hasCalls(asked)) return null;
  const unanswered = asked.toolCalls
    .filter((call) => !resultOf(messages, call.id))
    .map((call) => call.id);
  if (unanswered.length > 0) return { reason: "window_closed", unanswered };
  const stopped = asked.toolCalls.some((call) =>
    isStoppedResult(resultOf(messages, call.id)),
  );
  if (stopped) return { reason: "stopped", unanswered: [] };
  /*
   * EVERY STEP ANSWERED AND NOTHING SAID AFTER: the turn ended while the Bot was thinking between
   * two steps, which is where Stop nearly always lands — a step takes a second, the thinking many.
   * MEASURED 2026-09-25 (0.5.4 final QA): Stop there left no 이어서 하기 at all.
   */
  const endsOnResults = messages.at(-1)?.role === "tool";
  return endsOnResults && !failed
    ? { reason: "stopped", unanswered: [] }
    : null;
}

/** A step's result that says the person stopped it, as `computer-tools.tsx` hands it back. */
function isStoppedResult(message: Message | undefined): boolean {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content !== "string") return false;
  try {
    const parsed = JSON.parse(content) as { code?: unknown; stopped?: unknown };
    return parsed.code === "laf:stopped" || parsed.stopped === true;
  } catch {
    return false;
  }
}

/** A handler's result as the core writes it into the thread: a string as it is, else JSON. */
export function resultContent(result: unknown): string {
  if (result === undefined || result === null) return "";
  return typeof result === "string" ? result : JSON.stringify(result);
}

/**
 * The thread with a step's result in place: right after the message that asked for it and after
 * any results already there, where the core itself puts one (providers want results to follow
 * their calls). The same array when the message is not in it.
 */
export function withStepResult(
  messages: readonly Message[],
  answered: {
    messageId: string;
    toolCallId: string;
    content: string;
    id: string;
  },
): Message[] {
  const at = messages.findIndex((message) => message.id === answered.messageId);
  if (at === -1) return [...messages];
  let insertAt = at + 1;
  while (messages[insertAt]?.role === "tool") insertAt += 1;
  return [
    ...messages.slice(0, insertAt),
    {
      id: answered.id,
      role: "tool",
      toolCallId: answered.toolCallId,
      content: answered.content,
    } as Message,
    ...messages.slice(insertAt),
  ];
}
