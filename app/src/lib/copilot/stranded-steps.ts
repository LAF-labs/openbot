import type { Message } from "@ag-ui/core";

/**
 * A TASK THAT ENDED IN THE MIDDLE OF THE BOT'S WORK, found in the conversation as it stands (UX
 * review 0.5.4, candidate 1, audit item 16 from 0.5.3).
 *
 * The Bot's last message asked for steps and nothing was said after them: a step with no result,
 * one the person stopped, or a turn cut off between two steps. What cannot be carried on by itself
 * is said as stopped, with a way to continue (`carry-on-notice.tsx`).
 *
 * A step with no result at all is rare now, and this still reads it. It was the ordinary way a task
 * died while every computer tool ran in the window — the Bot asked for a click, its run ended, the
 * window made the click and started the next run — and closing the window mid-step left a call
 * nothing would ever answer. The server runs the steps since v0.5.7 and files a result for every
 * call of a turn that stops or fails (`server/src/turns/engine.ts`), and the window-driven path,
 * with the watcher that carried such a step on from another window, was removed 2026-10-05. What
 * is left without a result is a conversation from before, or a turn its process died under.
 *
 * Pure: the thread in, facts out, so the rules can be checked without a browser.
 */

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

/**
 * How the conversation's last task ended, when it ended in the middle of the Bot's work.
 *
 * `window_closed`: the Bot's last message asked for steps and at least one never got a result —
 * named for the window that went away with it, when a window made the steps. `stopped`: every step answered, and one of them says the person
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

/** A step's result that says the person stopped it, as the turn files one (`STOPPED_RESULT`). */
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
