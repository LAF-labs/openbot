import type { Message, ToolCall } from "@ag-ui/core";
import { BROWSING_TOOLS, type BrowsingStep } from "@/lib/computer/browsing";

/**
 * Transcript projection that pairs assistant tool calls with later tool-result messages.
 */

export type VisibleChatItem =
  | {
      kind: "text";
      id: string;
      role: "user" | "assistant";
      text: string;
      /** ISO-8601, when this message was first seen. Absent for anything said before stamping. */
      at?: string;
    }
  | {
      kind: "tool";
      id: string;
      toolCall: ToolCall;
      /** The result, once there is one. Absent means the call is still in flight. */
      result?: string;
    };

/**
 * A browsing task: calls to the Bot's browser in a row, drawn as one card (`browsing-card.tsx`).
 *
 * `id` is the first call's, so the card keeps its identity — and its React key, and its place in the
 * scroller — while the task grows under it.
 */
export type BrowsingItem = {
  kind: "browse";
  id: string;
  steps: BrowsingStep[];
};

/** What the transcript draws, in order: said things, other tool calls, and browsing tasks. */
export type TranscriptItem = VisibleChatItem | BrowsingItem;

/**
 * Browser calls in a row, folded into one task.
 *
 * A row is broken by anything else the transcript draws: a sentence from either side, a file saved,
 * a request for a person. What the Bot said between two stretches of browsing is the seam between
 * two things it did, and each gets its own card with its own last picture.
 */
export function withBrowsingTasks(
  items: readonly VisibleChatItem[],
): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const item of items) {
    if (
      item.kind === "tool" &&
      BROWSING_TOOLS.has(item.toolCall.function.name)
    ) {
      const step: BrowsingStep = {
        id: item.toolCall.id,
        name: item.toolCall.function.name,
        args: item.toolCall.function.arguments,
        ...(item.result === undefined ? {} : { result: item.result }),
      };
      const last = out.at(-1);
      if (last?.kind === "browse") {
        last.steps.push(step);
      } else {
        out.push({ kind: "browse", id: step.id, steps: [step] });
      }
      continue;
    }
    out.push(item);
  }
  return out;
}

/**
 * The task still being done: the last thing in the transcript, while a turn is running.
 *
 * Anything drawn after it — a sentence, a request for help — means the Bot has moved on, and a turn
 * that is over has no task open whatever it ended on.
 */
export function openBrowsingTask(
  items: readonly TranscriptItem[],
  busy: boolean,
): BrowsingItem | null {
  if (!busy) return null;
  const last = items.at(-1);
  return last?.kind === "browse" ? last : null;
}

/** A tool result, as it arrives, its own message, pointing back at the call it answers. */
type ToolResultMessage = { role: "tool"; toolCallId: string; content?: string };

function isToolResult(
  message: Readonly<Message>,
): message is Readonly<Message> & ToolResultMessage {
  return message.role === "tool" && "toolCallId" in message;
}

export function toVisibleChatItems(
  messages: ReadonlyArray<Readonly<Message>>,
  /**
   * Message id to ISO-8601. Only text items carry a time: a tool call is an action inside a turn,
   * not something said, and a separator drawn above one would split a turn in half.
   */
  times: Readonly<Record<string, string>> = {},
): VisibleChatItem[] {
  // Gather results first so calls render with their current completion state in the same pass.
  const results = new Map<string, string | undefined>();
  for (const message of messages) {
    if (isToolResult(message)) results.set(message.toolCallId, message.content);
  }

  return messages.flatMap((message): VisibleChatItem[] => {
    if (message.role === "assistant") {
      const items: VisibleChatItem[] = [];
      if (message.content) {
        items.push({
          kind: "text",
          id: message.id,
          role: "assistant",
          text: message.content,
          ...(times[message.id] ? { at: times[message.id] } : {}),
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        // A call streams in pieces: the id arrives before the function, the function before its
        // arguments. An entry that has no function yet is a call still being spoken, not a call —
        // rendering it would mean reading fields that are not there, and one interrupted run in a
        // thread's replay would crash the whole transcript for good. It appears on the render after
        // the stream completes it; an entry a dead run left permanently half-built never does,
        // which is the right way to remember a sentence nobody finished.
        if (!toolCall.function?.name) continue;
        items.push({
          kind: "tool",
          // One assistant message can carry multiple tool calls.
          id: toolCall.id,
          toolCall,
          ...(results.has(toolCall.id)
            ? { result: results.get(toolCall.id) }
            : {}),
        });
      }
      return items;
    }

    if (message.role !== "user") return [];

    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");

    return text
      ? [
          {
            kind: "text",
            id: message.id,
            role: "user",
            text,
            ...(times[message.id] ? { at: times[message.id] } : {}),
          },
        ]
      : [];
  });
}

/**
 * Where the turn still being written begins: just after the person's last message while a turn is
 * running, and past the end of the list when none is.
 *
 * Everything from here on can still change under the reader — a reply mid-stream, a second reply
 * after a tool line — so it is not yet an answer anybody can say they liked or did not. Counted from
 * the person's own message rather than from the last reply, because a turn can answer in several
 * bubbles and the first of them is no more finished than the last until the turn is over.
 */
export function unsettledFrom(
  items: readonly TranscriptItem[],
  busy: boolean,
): number {
  if (!busy) return items.length;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "text" && item.role === "user") return index + 1;
  }
  return 0;
}
