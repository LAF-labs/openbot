import { type AttachmentPart, attachmentPartsOf } from "@shared/attachments";
import type { Message, ToolCall } from "@ag-ui/core";
import {
  BROWSING_TOOLS,
  type BrowsingStep,
  type CutOff,
} from "@/lib/computer/browsing";

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
      /** The files a person's message carried, drawn above their words (`@shared/attachments`). */
      attachments?: AttachmentPart[];
    }
  | {
      kind: "tool";
      id: string;
      toolCall: ToolCall;
      /** The result, once there is one. Absent means the call is still in flight. */
      result?: string;
    };

/**
 * Something the Bot said while it was in the middle of a browsing task, kept inside the task's card.
 *
 * `after` is how many of the task's steps came before it, so the card's list of what it did can put
 * the sentence back where it was said.
 */
export type BrowsingNote = { id: string; text: string; after: number };

/**
 * A browsing task: the browser calls of one turn, drawn as one card (`browsing-card.tsx`).
 *
 * `id` is the first call's, so the card keeps its identity — and its React key, and its place in the
 * scroller — while the task grows under it.
 */
export type BrowsingItem = {
  kind: "browse";
  id: string;
  steps: BrowsingStep[];
  /** What the Bot said between the steps, in order. The card's head shows the newest. */
  notes: BrowsingNote[];
  /** The person's words that started this turn: what the card's title says the task was for. */
  asked?: string;
};

/** What the transcript draws, in order: said things, other tool calls, and browsing tasks. */
export type TranscriptItem = VisibleChatItem | BrowsingItem;

/**
 * A turn's browser calls, folded into one task.
 *
 * MEASURED ON 2026-09-24 (UI/UX audit, item 1): one "바로구매" on 예스24 left TEN cards in the
 * conversation, with ten lines of the Bot talking to itself between them, and the answer two screens
 * further down. The rule was that anything drawn between two calls split them, and the model this
 * deployment runs says a line before nearly every call — so a card was one or two calls long, and a
 * task that went well looked like a pile of attempts.
 *
 * So what the Bot says between two stretches of browsing in the same turn goes INTO the card, as a
 * line of what it did, and the card keeps growing. What it said before its first call ("찾아볼게요")
 * and after its last (the answer) stay in the conversation as bubbles, because those are the two
 * things a person reads. A sentence after the card is a bubble until another call arrives, since
 * until then it may be the answer.
 *
 * Still broken by the things that are not the Bot talking: the person's next message (a new turn),
 * a request for a person (a card of its own, which ends the task in front of it — see `browsing.ts`),
 * or any other drawn tool, which did something in between that is not browsing and would be hidden
 * inside a browser's card.
 */
export function withBrowsingTasks(
  items: readonly VisibleChatItem[],
): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  /** The task this turn is still adding to, if nothing but the Bot's words has come after it. */
  let task: BrowsingItem | null = null;
  /** The Bot's sentences since that task's last step, drawn as bubbles until a call claims them. */
  let trailing: Extract<VisibleChatItem, { kind: "text" }>[] = [];
  let asked: string | undefined;
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
      if (task) {
        // The sentences were the last things pushed, so they come off the end in one cut.
        out.length -= trailing.length;
        for (const said of trailing) {
          task.notes.push({
            id: said.id,
            text: said.text,
            after: task.steps.length,
          });
        }
        trailing = [];
        task.steps.push(step);
      } else {
        task = {
          kind: "browse",
          id: step.id,
          steps: [step],
          notes: [],
          ...(asked ? { asked } : {}),
        };
        out.push(task);
      }
      continue;
    }
    if (task && item.kind === "text" && item.role === "assistant") {
      trailing.push(item);
      out.push(item);
      continue;
    }
    if (item.kind === "text" && item.role === "user") asked = item.text;
    task = null;
    trailing = [];
    out.push(item);
  }
  return out;
}

/**
 * The task still being done, while a turn is running: the last card, when nothing but the Bot's own
 * words has come after it.
 *
 * Those words may be the answer or may be the next line of the task (`withBrowsingTasks`), and until
 * the turn is over nothing says which — so the card stays open through them rather than closing and
 * opening again at every sentence, which blinked the banner and the header's mark with each one.
 * Anything else after it — a request for help, the person's next message — means the Bot has moved
 * on, and a turn that is over has no task open whatever it ended on.
 */
export function openBrowsingTask(
  items: readonly TranscriptItem[],
  busy: boolean,
): BrowsingItem | null {
  if (!busy) return null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "browse") return item;
    if (item?.kind !== "text" || item.role !== "assistant") return null;
  }
  return null;
}

/**
 * Whether the card at `index` is a task its turn was cut off in: nothing came after it before the
 * person's next message or the end of the thread, so the Bot never said what the task came to
 * (`CutOff` in `lib/computer/browsing.ts`). Null for a card the Bot spoke after, and for the last
 * card while a turn is still running — that one is open, not cut off.
 */
export function cutOffOf(
  items: readonly TranscriptItem[],
  index: number,
  { busy, failed }: { busy: boolean; failed: boolean },
): CutOff {
  if (items[index]?.kind !== "browse") return null;
  const next = items[index + 1];
  if (next === undefined) {
    if (busy) return null;
  } else if (next.kind !== "text" || next.role !== "user") {
    return null;
  }
  return failed ? "failed" : "stopped";
}

/**
 * Whether the card at `index` is its turn's last task and the turn ended in a failure line drawn
 * after it — `failedRows` holds the rows a failure is drawn under, stored or this tab's own.
 *
 * MEASURED 2026-09-26 (0.5.4 final QA, "끝남 on the card, 못 끝냄 in 오늘"): the Bot finished a
 * Naver task and began its answer, and the turn died there — agent-bot cut, or the server
 * restarting. The half answer after the card made it not cut off, so the card read 끝남 from its
 * steps, while 오늘 read the turn's ledger and said 못 끝냄. The turn is one thing that did not
 * finish, and its last task says so with it; an earlier task in the same turn keeps its own ending.
 */
export function turnFailedAfter(
  items: readonly TranscriptItem[],
  index: number,
  failedRows: ReadonlySet<string>,
): boolean {
  if (items[index]?.kind !== "browse") return false;
  for (let at = index + 1; at < items.length; at += 1) {
    const item = items[at];
    if (!item) break;
    if (item.kind === "browse") return false;
    if (item.kind === "text" && item.role === "user") return false;
    if (failedRows.has(item.id)) return true;
  }
  return false;
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
    // A message of files alone is still something said: a receipt handed over without a word.
    const attachments = attachmentPartsOf(message.content);

    return text || attachments.length > 0
      ? [
          {
            kind: "text",
            id: message.id,
            role: "user",
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
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

/**
 * WHERE A STORED FAILURE IS DRAWN: AFTER THE LAST THING ITS TURN DREW. Item id to the failure keys
 * drawn after it.
 *
 * The server keys a failure to a message (`turn-failures.ts`) — the question, or the last message
 * its run wrote — and the transcript drew the line right under that message's own row. But one
 * message draws several rows: the Bot's "찾아볼게요" and the browsing card its tool calls became
 * are one assistant message, so after a reload the red line sat between the sentence and the card it
 * was about (0.5.4 QA), while the live line — drawn at the end — sat under the card. So the line goes
 * where the live one did: after the last row drawn from that message or anything after it, up to
 * the person's next message. A key no row can be found for stays where it was, under its own row.
 */
export function failurePlaces(
  messages: ReadonlyArray<Readonly<Message>>,
  items: readonly TranscriptItem[],
  failureIds: Iterable<string>,
): Map<string, string[]> {
  /** Every id a row stands for — a message, a call, a result, a note inside a card — to its row. */
  const rowOf = new Map<string, number>();
  items.forEach((item, index) => {
    rowOf.set(item.id, index);
    if (item.kind === "browse") {
      for (const step of item.steps) rowOf.set(step.id, index);
      for (const note of item.notes) rowOf.set(note.id, index);
    }
  });
  const positionOf = new Map(
    messages.map((message, index) => [message.id, index]),
  );
  const places = new Map<string, string[]>();
  for (const key of failureIds) {
    let last = rowOf.get(key) ?? -1;
    const at = positionOf.get(key);
    if (at !== undefined) {
      for (let index = at; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message) break;
        if (index > at && message.role === "user") break;
        const ids: string[] = [message.id];
        if (message.role === "assistant") {
          for (const call of message.toolCalls ?? []) ids.push(call.id);
        }
        if (isToolResult(message)) ids.push(message.toolCallId);
        for (const id of ids) last = Math.max(last, rowOf.get(id) ?? -1);
      }
    }
    const row = items[last];
    if (!row) continue;
    places.set(row.id, [...(places.get(row.id) ?? []), key]);
  }
  return places;
}
