import { isFirstMoveCall } from "@shared/first-move";
import {
  serverKeyOf,
  TOOL_CALL,
  TOOL_SEARCH,
  WEATHER_TOOL_NAME,
} from "@shared/tools/bridge";
import {
  GALLERY_CONFIRMATIONS,
  GALLERY_DECISIONS,
} from "@shared/tools/gallery";
import { withheldMarksIn } from "@shared/tools/withheld";
import { weatherOf } from "@shared/weather";
import type { ComponentType } from "react";
import { WeatherCard } from "@/components/weather/weather-card";
import type { TranscriptItem, VisibleChatItem } from "./chat-messages";

/**
 * WHAT A ROW OF THE CONVERSATION IS, DECIDED ONCE FOR EVERY ROW (`rowKindsOf`).
 *
 * It used to be decided wherever somebody needed to know: the steps were found by a tool's name,
 * the row drawing a call was handed a flag the transcript had worked out again, and the arrow that
 * counts what arrived below the reader had a list of its own. The weather card had to be planted in
 * all three, and the third — the count of arrivals — was missed until a review found it (pull
 * request 62, round 8). Now everything that folds, draws or counts a row reads this, and a new card
 * is one entry of `CARDS`.
 */
export type RowKind =
  /** The person's words. */
  | { kind: "person" }
  /** The Bot's words. */
  | { kind: "answer" }
  /** A browsing task: the browser calls of one turn, drawn as one card (`withBrowsingTasks`). */
  | {
      kind: "browse";
      /** The Bot stopped right after it to ask the person for a hand, and is still waiting. */
      isHandedOver: boolean;
    }
  /** A thing the Bot made, or put in front of the person, that stays in the conversation (`CARDS`). */
  | { kind: "card"; card: string }
  /** A step of work: put away with the steps around it once it is over. */
  | {
      kind: "step";
      /** The run it is in, named by its first row. */
      runId: string;
      /** Still out, or holding something for the person: drawn whether or not its run is open. */
      staysDrawn: boolean;
    }
  /** Any other call: a line saying what was done, drawn where it was made — the clock, a note. */
  | { kind: "line" };

/** A call's row is told which of these it is (`TranscriptToolCall`). */
export type CallRowKind = Extract<RowKind["kind"], "card" | "step" | "line">;

/**
 * A CARD: A CALL DRAWN AS A THING THE BOT MADE, NOT AS A LINE OF WHAT IT DID.
 *
 * One entry is the whole of it. A row an entry claims is drawn as the card, is never put away with
 * the steps around it — not even under a name that would be — and counts as an arrival below the
 * reader (`arrivedBelow`).
 */
export type CardEntry = {
  /** The name the call is made under. */
  name: string;
  /** Which card it is: what its row is told. Several names can draw one card. */
  card: string;
  /**
   * Whether the answer that came back is the card. Absent, the call is the card by its name from
   * the moment it is made — a question is a card while it waits. Present, the call is the card only
   * once an answer that passes is in, and is whatever its name makes it until then.
   */
  isCard?: (result: string) => boolean;
  /**
   * The card, drawn by the transcript from the call's own answer. Absent where a renderer
   * registered with the runtime for the name draws it — the gallery's.
   */
  Drawn?: ComponentType<{ result: string }>;
};

/** The Bot asking the person for a hand, or for a value it must not see: a card of its own. */
export const ASKS_CARD = "asks";

export const CARDS: readonly CardEntry[] = [
  /*
   * WHAT THE BOT PUT IN FRONT OF THE PERSON — a card to read, or to answer — by the lists the
   * server answers these calls by (`@shared/tools/gallery`): what the transcript draws for a name
   * is a renderer registered with the runtime, which a function over the list cannot ask. A
   * component an administrator authored in the browser is in neither list and is not a card.
   */
  ...[...GALLERY_DECISIONS].map((name) => ({ name, card: "decision" })),
  ...Object.keys(GALLERY_CONFIRMATIONS).map((name) => ({
    name,
    card: "shown",
  })),
  { name: "computer_request_help", card: ASKS_CARD },
  { name: "computer_request_secret", card: ASKS_CARD },
  /*
   * THE WEATHER, WHEN ITS ANSWER CAME BACK WITH DATA (`WeatherCard`). The weather tool is a
   * connected service's by its name, so its row would be put away with the steps; with data in it,
   * it is the card the owner asked for (2026-10-04) and stays in the conversation. Without —
   * refused, failed, a place the forecast does not reach — it is the step it always was: put away,
   * and counted as one that did not work.
   *
   * BY THE SAME READING THE CARD IS DRAWN FROM (`weatherOf`). By how the answer begins alone, an
   * answer that held the next hours and nothing the card draws — no temperature now, no day; the
   * tool's own partial answer, late in the evening — was no step and no card: nothing on the screen
   * at all (Codex on pull request 62). It is asked of every weather call on every chunk, and
   * `weatherOf` looks at how an answer begins before it reads one.
   *
   * DRAWN HERE AND NOT THROUGH A REGISTERED RENDERER: a card of data is owed wherever the call is
   * in the record — after a reload, after the tool was taken back, in a window that never held it.
   */
  {
    name: WEATHER_TOOL_NAME,
    card: "weather",
    isCard: (result) => weatherOf(result) !== null,
    Drawn: WeatherCard,
  },
];

const byName = (cards: readonly CardEntry[]) =>
  new Map(cards.map((entry) => [entry.name, entry]));

const CARD_BY_NAME = byName(CARDS);

/**
 * The card the transcript draws itself for a call by this name, when its row is a card. Null for a
 * card a registered renderer draws.
 */
export function cardDrawnFor(
  name: string,
  cards: readonly CardEntry[] = CARDS,
): ComponentType<{ result: string }> | null {
  const entries = cards === CARDS ? CARD_BY_NAME : byName(cards);
  return entries.get(name)?.Drawn ?? null;
}

/**
 * Whether a call is a step of work: a plain line saying what the Bot is doing, which is not drawn
 * in the conversation once it is over (`rowKindsOf`).
 *
 * ONLY THE LINES KNOWN TO BE LINES. A connected service's tool ("메일 찾기 · 지메일"), and the two
 * ways a Bot reaches a tool that is not in front of it. Everything else that is drawn by name — a
 * card from the gallery, a file handed over, the clock, a note — is left where it is: a card put
 * away with the steps around it would be a thing the Bot made, hidden as though it were a thing it
 * did on the way. A name left off this list is a line that stays in the conversation, which is how
 * every line was until 2026-10-03.
 *
 * A call `CARDS` claims is a card first, whatever its name: the weather's is a connected
 * service's.
 */
export function isFoldableStep(name: string): boolean {
  return (
    name === TOOL_SEARCH || name === TOOL_CALL || serverKeyOf(name) !== null
  );
}

/**
 * Whether a step has something on it for the person — a line that is drawn whether or not anybody
 * opened the record it belongs to.
 *
 * - STILL OUT: no result yet. It is the one line of a turn at work, shimmering at the end of the
 *   conversation, and a boundary's question is drawn on the line of the call that raised it
 *   (`ApprovalRequest`). A model may ask for two calls in one breath, so the call waiting on the
 *   person need not be the last. Not drawn, its card would be drawn nowhere: a question nobody can
 *   see, running out its ten minutes, and a press on 기다리는 일 that finds no card to go to.
 * - A WITHHELD MARK IN ITS RESULT. The 보기 for a mail's one-time code belongs on that call's own
 *   line (`WithheldSecrets`), and the person who asked for the code is waiting on it — not on the
 *   search the Bot made after reading the mail.
 *
 * A STEP THAT DID NOT WORK IS NOT ONE OF THEM (the owner, 2026-10-04). It was, at first: a refused
 * or failed step stayed drawn, so that it could not read as one more thing the Bot did. What that
 * left on the screen was the owner's own example of too many words — a weather look-up that failed
 * and the one after it that worked, a line each, above an answer that already says which did not
 * work. It is put away like any other, and that one of them did not work is said BY THE CONTROL
 * THAT OPENS THEM — its colour and its name (`AnswerSteps.failed`) — so nothing that failed is
 * behind a control that looks like nothing happened.
 */
function staysInTheOpen(
  step: Extract<VisibleChatItem, { kind: "tool" }>,
): boolean {
  if (step.result === undefined) return true;
  // The cheap look first: this runs over every step of the conversation on every chunk.
  return (
    step.result.includes("[[withheld:") &&
    withheldMarksIn(step.result).length > 0
  );
}

/**
 * The calls drawn as cards, by their place in `items`, to the card each is.
 *
 * A FIRST MOVE THE BOT DID NOT ANSWER FROM IS NOT A CARD. With the first move on, the server
 * fetches the weather for where the person lives before the Bot's model is asked
 * (`first-move.ts`), on a small model's word that the question is about there. When that word was
 * wrong — "내일 부산 해운대 날씨 어때?" — the Bot asks again for the place that was meant
 * (`first-move-for-the-wrong-place-is-put-right` holds it to that), and both answers came back
 * with data: the conversation showed the forecast for home, then the one for 해운대, over a
 * sentence about 해운대 (Codex on pull request 62). So once the Bot calls the same tool itself, the
 * turn's first move is what it was before there were cards — for the weather, a step on the way,
 * put away with the others and counted with them.
 *
 * FROM THE MOMENT THE BOT ASKS, not from when its answer comes back: whatever becomes of the second
 * call, the Bot has said the first was not the answer.
 *
 * ONLY A FIRST MOVE, known by its id (`isFirstMoveCall`). Two calls the Bot made itself are two
 * places it was asked about — "서울이랑 부산 날씨 비교해 줘" — and two cards.
 *
 * Found before the steps are, since a later row can take a card back.
 */
function cardsAt(
  items: readonly TranscriptItem[],
  cards: ReadonlyMap<string, CardEntry>,
): Map<number, string> {
  const at = new Map<number, string>();
  /** This turn's first move, while it is drawn as a card and the Bot has not asked again. */
  let moved: { index: number; name: string } | null = null;
  items.forEach((item, index) => {
    if (item.kind === "text" && item.role === "user") {
      moved = null;
      return;
    }
    if (item.kind !== "tool") return;
    const name = item.toolCall.function.name;
    if (moved?.name === name) {
      at.delete(moved.index);
      moved = null;
    }
    const entry = cards.get(name);
    if (!entry) return;
    if (entry.isCard) {
      if (item.result === undefined || !entry.isCard(item.result)) return;
    }
    at.set(index, entry.card);
    if (isFirstMoveCall(item.toolCall.id)) moved = { index, name };
  });
  return at;
}

/**
 * WHAT EVERY ROW OF `items` IS, aligned with it. Computed once per render of the transcript.
 *
 * STEPS OF WORK ARE NOT DRAWN IN THE CONVERSATION (the owner, 2026-10-04, choosing "proposal A" of
 * the mock-up shown that day). A turn at work shows the one step that is still out, and a finished
 * turn leaves what the Bot said and the cards that need the person. The record is not thrown away:
 * the answer carries the control that opens what was done for it (`stepsByAnswer`).
 *
 * HOW IT CAME TO THIS. Measured on a trial deployment, 2026-10-03 (the owner's screenshot): "내
 * 지메일에 비즈니스메일 온 거 있나 보고 알려줘" left five grey lines stacked above the answer — 도구
 * 찾는 중, 메일 찾기 · 지메일 twice, 메일 읽기 · 지메일 twice — each a row of its own, and the answer
 * a screen further down for it. A run was first folded to its newest line, with the rest behind a
 * fold beside it: "이전 3단계", and then an icon, because the words were one more phrase on the
 * screen. That still left a line and a control above every answer that took two steps to write,
 * and a step alone was drawn as it always had been — and the owner's word on the app as a whole
 * was that it shows far too many words.
 *
 * A RUN is the step rows that follow one another with nothing between them — and a step alone is a
 * run of one. Anything between two steps ends the run — the Bot's own sentence, a card, a browsing
 * task, the person's next message — so what is put away is only ever steps, and a run never
 * crosses a turn. A run is what is opened together: with the others an answer was written from, or
 * by itself when another screen sends the person to a row inside it.
 *
 * A step that has something on it for the person (`staysInTheOpen`) is a member like any other,
 * marked: drawn while its run is closed, and still one of the steps the answer counts.
 *
 * `cards` is `CARDS` but in a test that shows what one more entry does.
 */
export function rowKindsOf(
  items: readonly TranscriptItem[],
  cards: readonly CardEntry[] = CARDS,
): RowKind[] {
  const cardAt = cardsAt(items, cards === CARDS ? CARD_BY_NAME : byName(cards));
  let runId: string | null = null;
  const kinds = items.map((item, index): RowKind => {
    const card = cardAt.get(index);
    if (
      item.kind === "tool" &&
      card === undefined &&
      isFoldableStep(item.toolCall.function.name)
    ) {
      runId ??= item.id;
      return { kind: "step", runId, staysDrawn: staysInTheOpen(item) };
    }
    runId = null;
    if (item.kind === "text") {
      return { kind: item.role === "user" ? "person" : "answer" };
    }
    if (item.kind === "browse") return { kind: "browse", isHandedOver: false };
    return card === undefined ? { kind: "line" } : { kind: "card", card };
  });
  /*
   * HANDED TO THE PERSON: the first thing after the task that is not the Bot's own words is a
   * request for a hand, or for a value it must not see, with no result yet.
   *
   * Such a request ends the task in front of it (`withBrowsingTasks`), so by its steps that task is
   * over — while the Bot is in the middle of it, and the page it is stuck on is that task's picture.
   * A task that is over folds to one row; this one is not over to the person looking at it, and
   * keeps its card for as long as the request waits (`browsing-card.tsx`).
   */
  let isWaitingBelow = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const kind = kinds[index];
    const item = items[index];
    if (!kind || !item || kind.kind === "answer") continue;
    if (kind.kind === "browse") {
      kinds[index] = { kind: "browse", isHandedOver: isWaitingBelow };
    }
    isWaitingBelow =
      kind.kind === "card" &&
      kind.card === ASKS_CARD &&
      item.kind === "tool" &&
      item.result === undefined;
  }
  return kinds;
}

/**
 * Whether a row is on the screen: everything but a step put away in a run nobody has open.
 */
export function isDrawn(
  kind: RowKind | undefined,
  openRuns: ReadonlySet<string>,
): boolean {
  return kind?.kind !== "step" || kind.staysDrawn || openRuns.has(kind.runId);
}
