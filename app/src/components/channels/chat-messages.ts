import type { Message, ToolCall } from "@ag-ui/core";
import { type AttachmentPart, attachmentPartsOf } from "@shared/attachments";
import { type FeedQuotePart, feedQuotesOf } from "@shared/feed";
import { isFirstMove } from "@shared/first-move";
import { TOOL_SEARCH } from "@shared/tools/bridge";
import { GALLERY_DECISIONS } from "@shared/tools/gallery";
import { stepDidNotWork } from "@shared/tools/step-result";
import {
  BROWSING_TOOLS,
  type BrowsingStep,
  type CutOff,
} from "@/lib/computer/browsing";
import { type RowKind, rowKindsOf } from "./row-kinds";
import { own } from "@/lib/own";

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
      /** The 소식 post a person's message is about (이야기하기, `@shared/feed`). */
      quotes?: FeedQuotePart[];
    }
  | {
      kind: "tool";
      id: string;
      toolCall: ToolCall;
      /** The result, once there is one. Absent means the call is still in flight. */
      result?: string;
      /**
       * The server made this call as the turn's first move, not the Bot (`@shared/first-move`):
       * said on the message that carries the call, and carried here because a row is read without
       * its message (`rowKindsOf`). Absent for every call the Bot made.
       */
      isFirstMove?: true;
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

/** Whether a row is a finished step that did not work (`stepDidNotWork`). */
function didNotWork(item: TranscriptItem): boolean {
  return (
    item.kind === "tool" &&
    item.result !== undefined &&
    stepDidNotWork(item.result)
  );
}

/** Where a step sits among the steps around it: the run it is in, and whether it is drawn anyway. */
export type StepRunPlace = {
  /** The run, named by its first row. */
  runId: string;
  /** Still out, or holding something for the person: drawn whether or not its run is open. */
  staysDrawn: boolean;
};

/**
 * The runs of steps, by the step rows' places in `items`: the steps of the projection
 * (`rowKindsOf`, which says what a run is and why steps are not drawn), as the readers of the
 * record ask for them — what an answer opens, which runs are open, where a drawn window may begin.
 *
 * `kinds` is the transcript's own, computed once per render; without it the rows are read here.
 */
export function stepRunsOf(
  items: readonly TranscriptItem[],
  kinds: readonly RowKind[] = rowKindsOf(items),
): Map<number, StepRunPlace> {
  const places = new Map<number, StepRunPlace>();
  kinds.forEach((kind, index) => {
    if (kind.kind !== "step") return;
    places.set(index, { runId: kind.runId, staysDrawn: kind.staysDrawn });
  });
  return places;
}

/**
 * The runs somebody has open: every run that holds a row it was opened by.
 *
 * BY A ROW IN IT, NOT BY THE RUN'S NAME. A run is named by its first row, and that name holds while
 * the run grows at its end — a task still going. It does not hold when a run grows at its HEAD: the
 * page above arrives carrying the earlier steps of the same run, the run has a new first row, and
 * one remembered by its old name would close itself in front of the person reading it. The row it
 * was opened by is still in it.
 */
export function openStepRuns(
  items: readonly TranscriptItem[],
  runs: ReadonlyMap<number, StepRunPlace>,
  openedRows: ReadonlySet<string>,
): Set<string> {
  const open = new Set<string>();
  if (openedRows.size === 0) return open;
  for (const [index, place] of runs) {
    const id = items[index]?.id;
    if (id !== undefined && openedRows.has(id)) open.add(place.runId);
  }
  return open;
}

/** What an answer opens: the steps taken on the way to it. */
export type AnswerSteps = {
  /** The runs they are in, by name: what opening adds (`openStepRuns`). */
  runIds: string[];
  /** Every row of those runs, in order: how many steps there were, and what closing takes back. */
  rows: string[];
  /** How many of them did not work: the control has to say so, since such a step is not drawn. */
  failed: number;
};

/**
 * WHAT WAS DONE FOR EACH ANSWER, by the answer's id: the steps a turn took before the Bot next
 * spoke.
 *
 * The steps are not drawn (`stepRunsOf`), so something has to carry the way back to them, and it is
 * the thing they were for. The FIRST thing the Bot says after them takes them all — every run
 * since it last spoke, whatever else was drawn between them: a card, a browsing task, the clock —
 * and what it says after that takes none. So a sentence said between two stretches of work ("두 통
 * 더 볼게요") opens the stretch before it, and the answer opens the one after.
 *
 * The person's next message drops whatever nothing took, and so does the end of the list: a turn
 * that never came to an answer — stopped, failed, ended on a card, or still at work — has nothing
 * to hang its steps on. A row of them is still opened by another screen sending the person to it.
 *
 * AND AN ANSWER WHOSE EVERY STEP IS DRAWN ANYWAY OPENS NOTHING, so it is not here: one mail read,
 * with a code in it, is on the screen already (`staysInTheOpen`), and a control over it would be
 * pressed and change nothing but its own name.
 *
 * Keyed the way the pages an answer was read from are (`sources.ts`).
 */
export function stepsByAnswer(
  items: readonly TranscriptItem[],
  runs: ReadonlyMap<number, StepRunPlace>,
): Map<string, AnswerSteps> {
  const found = new Map<string, AnswerSteps>();
  let taken: AnswerSteps | null = null;
  /** Whether one of them is not drawn: what there is to open. */
  let isAnyPutAway = false;
  items.forEach((item, index) => {
    if (item.kind === "text") {
      if (item.role === "assistant" && taken && isAnyPutAway) {
        found.set(item.id, taken);
      }
      taken = null;
      isAnyPutAway = false;
      return;
    }
    const place = runs.get(index);
    if (!place) return;
    taken ??= { runIds: [], rows: [], failed: 0 };
    // A run's rows follow one another, so its name is new only where the run is.
    if (taken.runIds.at(-1) !== place.runId) taken.runIds.push(place.runId);
    taken.rows.push(item.id);
    if (didNotWork(item)) taken.failed += 1;
    if (!place.staysDrawn) isAnyPutAway = true;
  });
  return found;
}

/**
 * Where a drawn window begins, given the row it would begin at: never among steps that a row it
 * holds would open.
 *
 * THE NUMBER A CONTROL NAMES IS WHAT PRESSING IT DRAWS. The window is counted over every row, the
 * ones not drawn too, and only the rows it holds can be drawn. Cut inside a run, the fold of the
 * time read 이전 5단계 and drew the two the window held, under a button that then said the record
 * was open (review of pull request 44, round 1). An answer is no different: one named for six
 * steps, in a window that began at the answer itself, would open to nothing. So a window that would
 * begin among the steps taken since the Bot last spoke — or at the sentence that takes them —
 * reaches back to the first of them. Not drawn, those rows cost nothing to hold.
 *
 * The person's own message begins a turn: nothing above it is opened from below it.
 */
export function wholeFrom(
  items: readonly TranscriptItem[],
  runs: ReadonlyMap<number, StepRunPlace>,
  cut: number,
): number {
  const row = items[cut];
  if (row?.kind === "text" && row.role === "user") return cut;
  let start = cut;
  for (let back = cut - 1; back >= 0; back -= 1) {
    if (items[back]?.kind === "text") break;
    if (runs.has(back)) start = back;
  }
  return start;
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

/**
 * Whether the person opened this task: one of its steps is a row they opened it by.
 *
 * A task that is over is drawn as one row (`browsing-card.tsx`), and which ones a person opened is
 * theirs for as long as the transcript is mounted.
 *
 * BY A STEP OF IT, NOT BY THE TASK'S NAME — the reason `openStepRuns` gives for a run. A task is
 * named by its first step, and the page above can arrive carrying the earlier steps of the same
 * task: it has a new first step then, and one remembered by its old name would fold shut in front
 * of the person reading it. The step they opened it by is still in it.
 */
export function isTaskUnfolded(
  item: BrowsingItem,
  openedTasks: ReadonlySet<string>,
): boolean {
  return (
    openedTasks.size > 0 && item.steps.some((step) => openedTasks.has(step.id))
  );
}

/**
 * The task an id is drawn inside: a step of it — the task's own id is its first step's — or a
 * sentence the Bot said between two steps. Every id `failurePlaces` counts as that row's. Null for
 * an id no task holds.
 *
 * FOR A JUMP INTO A TASK. 오늘 sends a person to the first thing a turn did, which for a turn that
 * began in the browser is a task's row, and a task that is over is folded to one line. What they
 * were sent to must not be behind a fold when they get there — the promise a folded run of step
 * lines already keeps (`chat-transcript.tsx`).
 */
export function browsingTaskHolding(
  items: readonly TranscriptItem[],
  id: string,
): BrowsingItem | null {
  for (const item of items) {
    if (item.kind !== "browse") continue;
    if (
      item.steps.some((step) => step.id === id) ||
      item.notes.some((note) => note.id === id)
    ) {
      return item;
    }
  }
  return null;
}

/** A tool result, as it arrives, its own message, pointing back at the call it answers. */
type ToolResultMessage = { role: "tool"; toolCallId: string; content?: string };

function isToolResult(
  message: Readonly<Message>,
): message is Readonly<Message> & ToolResultMessage {
  return message.role === "tool" && "toolCallId" in message;
}

/** The fact a call is answered with when its arguments do not fit, before anything happens. */
const ARGUMENTS_INVALID = "laf:tool_arguments_invalid";

/** Whether a call's result is the server's refusal of its arguments. */
function wasRefusedForArguments(result: string | undefined): boolean {
  if (!result) return false;
  try {
    const envelope: unknown = JSON.parse(result);
    return (
      envelope !== null &&
      typeof envelope === "object" &&
      (envelope as { ok?: unknown }).ok === false &&
      (envelope as { code?: unknown }).code === ARGUMENTS_INVALID
    );
  } catch {
    return false;
  }
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
      const moved = isFirstMove(message);
      if (message.content) {
        items.push({
          kind: "text",
          id: message.id,
          role: "assistant",
          text: message.content,
          ...(own(times, message.id) ? { at: own(times, message.id) } : {}),
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
        /*
         * A FINISHED LOOK THROUGH THE BOT'S OWN TOOL LIST LEAVES NO LINE. `tool_search` is how a
         * Bot finds a tool that is not in front of it (`shared/tools/bridge.ts`): the mechanism,
         * and nothing done in the world. While it is out its line shimmers — "도구 찾는 중" — so
         * the conversation is not standing still. Once it has answered, the same words stayed for
         * good: measured 2026-10-02, a conversation from that morning still read "도구 찾는 중"
         * between a saved file and the card for it, about a search that had ended hours before.
         * What it found is the next line, drawn by the tool itself.
         */
        if (
          toolCall.function.name === TOOL_SEARCH &&
          results.has(toolCall.id)
        ) {
          continue;
        }
        /*
         * A QUESTION THAT WAS NEVER ASKED IS NOT DRAWN. A question card called with nothing in it
         * is refused by the server before the turn waits (`isAskable`, `@shared/tools/gallery`),
         * and the Bot calls again: that one is the card. The refused call drawn too is an empty
         * frame above it reading 답을 기다려요 — a question nobody can read, that nobody was asked.
         */
        if (
          GALLERY_DECISIONS.has(toolCall.function.name) &&
          wasRefusedForArguments(results.get(toolCall.id))
        ) {
          continue;
        }
        items.push({
          kind: "tool",
          // One assistant message can carry multiple tool calls.
          id: toolCall.id,
          toolCall,
          ...(results.has(toolCall.id)
            ? { result: results.get(toolCall.id) }
            : {}),
          ...(moved ? { isFirstMove: true as const } : {}),
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
    const quotes = feedQuotesOf(message.content);

    return text || attachments.length > 0
      ? [
          {
            kind: "text",
            id: message.id,
            role: "user",
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(quotes.length > 0 ? { quotes } : {}),
            ...(own(times, message.id) ? { at: own(times, message.id) } : {}),
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
 * Whether the Bot stopped right after the task at `index` to ask the person for a hand, and has not
 * been answered (`rowKindsOf` says how that is known, and why such a task keeps its card).
 */
export function isHandedToThePerson(
  items: readonly TranscriptItem[],
  index: number,
  kinds: readonly RowKind[] = rowKindsOf(items),
): boolean {
  const kind = kinds[index];
  return kind?.kind === "browse" && kind.isHandedOver;
}

/**
 * How many things the Bot put there for the person arrived after `seenId`, the furthest row the
 * reader has had on screen (`furthestSeen`).
 *
 * Each bubble is one: a turn that answers in two is two things to read. AND EACH CARD IS ONE
 * (`CARDS`). A question is often the whole of what arrives — the Bot's message is empty and its
 * call is the card — and counting bubbles alone left the arrow as it was over a Bot stopped on a
 * question below, which is the arrival that most needs saying (review, first round). So is a
 * chart, a file, a request for a hand or for a password — and the weather, which a turn can end on,
 * and which was the card this count missed when it kept a list of its own (review, round 8).
 *
 * The person's own words are not counted — sent from another window of theirs, they are not news
 * to them — and neither is a step line, nor the card of a browsing task, which says what is being
 * done. A row that is not known (nothing seen yet, or it has left the list) counts nothing: saying
 * "3 new" by guessing is worse than the arrow alone.
 */
export function arrivedBelow(
  items: readonly TranscriptItem[],
  seenId: string | null,
  kinds: readonly RowKind[] = rowKindsOf(items),
): number {
  if (seenId === null) return 0;
  const seen = items.findIndex((item) => item.id === seenId);
  if (seen < 0) return 0;
  return kinds
    .slice(seen + 1)
    .filter((kind) => kind.kind === "answer" || kind.kind === "card").length;
}

/**
 * The furthest row the reader has had on screen: `seenId`, or the lowest of the rows on screen now
 * when that is further down.
 *
 * It only moves on. Scrolling back up to read does not make what was seen news again, and a row on
 * screen that the list no longer holds changes nothing.
 */
export function furthestSeen(
  items: readonly TranscriptItem[],
  seenId: string | null,
  onScreen: readonly (string | null)[],
): string | null {
  const place = (id: string | null) =>
    id === null ? -1 : items.findIndex((item) => item.id === id);
  const furthest = Math.max(place(seenId), ...onScreen.map(place));
  return items[furthest]?.id ?? seenId;
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
