/**
 * WHAT IS TYPED WHILE THE BOT WAITS ON A CHOICE IS THE ANSWER.
 *
 * Pressed on the running app, 2026-10-02. Asked to help pick dinner, the Bot put up a card — 한식,
 * 중식, 양식, "답을 기다려요". None fitted, so the natural thing was typed: "셋 다 말고 냉면 먹고
 * 싶어". The composer's button read "메시지 대기열에 넣기", and the words were parked under the card —
 * "보낼 예정 · 지금 일이 끝나면 전해요" — behind a job that ends only when the card is answered. The
 * one way out was 멈추고 이걸로, which stops the turn the question was part of.
 *
 * The server takes whatever a person answers a waiting card with and gives it to the Bot as the
 * call's result (`server/src/turns/chat-tools.ts`), so the person's own words are an answer it can
 * already be given. This finds the card they are an answer to.
 */
import type { Message } from "@ag-ui/core";
import { RETRY_FIRST_MS, RETRY_MOST_MS } from "./client";

/** The Bot's question with options. Its tool is in `components/gallery/decisions.tsx`. */
const CHOICE = "askChoice";

/**
 * Whether a choice saves something on the person's press — who they are (`saves: "persona"`) — and
 * so is answered by a press, and only by one.
 *
 * ONE READING, for the card and for the composer. The card said "type your answer below" by one
 * test of `saves` and the composer took words by another, and for a value neither expected
 * (`null`) they disagreed: words taken, and nothing on the card saying so.
 */
export function isSavedByPress(saves: unknown): boolean {
  return typeof saves === "string";
}

function savesByPress(argumentsJson: string): boolean {
  try {
    const args = JSON.parse(argumentsJson) as { saves?: unknown } | null;
    return isSavedByPress(args?.saves);
  } catch {
    // Arguments that cannot be read are not known to be an ordinary question either.
    return true;
  }
}

/**
 * The question the turn is stopped on that words can answer: the newest choice card it waits on.
 *
 * Not a yes-or-no card (`askApproval`), which has its own place for a reason and must never take
 * words for a yes; not a connect card, whose answer is a switch — typing under that one means "not
 * now" ({@link openConnectCall}); and not the choice that saves who the person is, where what is
 * saved is one of four presses (`saves: "persona"`). Typed under those, words wait for the turn to
 * end, as they always did.
 *
 * AN ID IS DECIDED BY ITS NEWEST CALL, AND ONCE. The server keeps what waits by the call's id
 * alone, so what waits under an id is the newest call that carries it. A provider's ids are its
 * own to mint and nothing here makes them unique in a conversation: scanning on past a waiting
 * yes-or-no card to an older choice with the same id would hand that card the person's words —
 * and "응", filed as the result of an approval, reads as a yes.
 */
export function openChoiceCall(
  messages: readonly Message[],
  waiting: readonly string[],
): string | null {
  if (waiting.length === 0) return null;
  const undecided = new Set(waiting);
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    for (const call of [...(message.toolCalls ?? [])].reverse()) {
      if (!undecided.delete(call.id)) continue;
      if (
        call.function.name === CHOICE &&
        !savesByPress(call.function.arguments)
      ) {
        return call.id;
      }
    }
  }
  return null;
}

/** 연결's switches, put in the conversation. Its tool is in `components/gallery/connect.tsx`. */
const CONNECT = "showConnection";

/**
 * The connect card the turn is stopped on, where it is: the newest call it waits on, if that call
 * is one. Decided by the newest call under each id, as {@link openChoiceCall} is.
 *
 * WHAT IS TYPED UNDER IT MEANS "NOT NOW". The card is the Bot's usual answer to a request that
 * needs an account nobody connected, and its turn waits until a switch is on, 다음에 is pressed or
 * ten minutes pass. Somebody who ignored it and typed "됐고, 날씨 알려줘" had those words parked
 * behind that wait (mounted, 2026-10-05: nothing reached the card's door). So the card is told
 * what 다음에 tells it ({@link NOT_NOW}), and the words go when the turn is over — which is then.
 * They are never the card's answer: a switch is not answered in words.
 */
export function openConnectCall(
  messages: readonly Message[],
  waiting: readonly string[],
): string | null {
  if (waiting.length === 0) return null;
  const undecided = new Set(waiting);
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    for (const call of [...(message.toolCalls ?? [])].reverse()) {
      if (!undecided.delete(call.id)) continue;
      if (call.function.name === CONNECT) return call.id;
    }
  }
  return null;
}

/**
 * What a connect card is told when the person typed instead of pressing: not connecting now. The
 * server reads 연결 for itself once anything answers (`server/src/turns/chat-tools.ts`), so this
 * ends the wait and decides nothing — a switch turned on in the same second is still on.
 */
export const NOT_NOW = Object.freeze({ code: "laf:connection_off" });

/**
 * Where an offer of typed words to their card stands, on the screen that made it:
 *  - `out`: the door is being asked now;
 *  - `taken`: the door took them, and the conversation is about to show them as the card's answer;
 *  - `resting`: the door did not take them, or nothing came back — offered again after a wait;
 *  - `due`: that wait is over, or the connection came back;
 *  - `answered`: another answer to the same question reached the card first — these are what the
 *    person says next, no longer the card's (the settling lets go of the mark).
 * `tries` is how many offers the door has not taken, which the wait is counted from.
 */
export type Offer = {
  at: "out" | "taken" | "resting" | "due" | "answered";
  tries: number;
};

/**
 * Whether the card itself shows words kept for it (`useAnswerOnItsWay`), and so takes no press:
 * yes, for as long as they are kept for it — but not once another answer to the question reached
 * the card first (`answered`), when they are what the person says next.
 *
 * An answer is taken at once and filed only when the Bot is free again (`awaitPerson` in the
 * server's engine), which behind a routine is minutes: a page reloaded in that time read "보낼 예정
 * · 지금 일이 끝나면 전해요" under words the Bot already had.
 *
 * AND WHILE THE DOOR HAS NOT TAKEN THEM, TOO. They used to go back under the card as waiting once
 * the door had failed to take them, and the card's options came back with them: a press then went
 * to the door beside the words being offered again, either could win, and where the press did the
 * words went after the turn as a message nobody meant (review, thirteenth round). So the card
 * shows them, and takes no press, until the conversation says what became of them; a door that
 * stays down leaves the card showing them with nothing to press, and typing again is the way to
 * change the answer.
 */
export function isShownOnCard(offer: Offer | undefined): boolean {
  return offer?.at !== "answered";
}

/**
 * How long words rest before they are offered to their card again, after `tries` offers the door
 * did not take: the stream's own waits, half a second doubling to eight.
 */
let firstRestMs = RETRY_FIRST_MS;
export function restAfter(tries: number): number {
  return Math.min(RETRY_MOST_MS, firstRestMs * 2 ** Math.max(0, tries - 1));
}

/** Test seam: the first of those waits, and back to the real one with no argument. */
export function setFirstRest(ms: number = RETRY_FIRST_MS): void {
  firstRestMs = ms;
}

/** What the Bot is answered with when the person typed instead of pressing an option. */
export function typedAnswer(words: string): { answer: string } {
  return { answer: words };
}

/** Whether a message is the Bot's call under this id: the question itself, not what answered it. */
function isCall(message: Message, toolCallId: string): boolean {
  return (
    message.role === "assistant" &&
    (message.toolCalls ?? []).some((call) => call.id === toolCallId)
  );
}

/**
 * The message that asked under this id, as far as these messages say: the newest of them that
 * carries the call. It is what words kept for a card are kept with (`askedBy` in the outbox),
 * because the id alone does not say which question they were for.
 */
export function askerOf(
  messages: readonly Message[],
  toolCallId: string,
): string | undefined {
  return messages.findLast((message) => isCall(message, toolCallId))?.id;
}

/**
 * Whether these messages hold the call itself — the one `askedBy` made, where that is known. A
 * result is filed after its call, always: where they run from the call to the newest thing said,
 * they hold everything the conversation says of what became of it — which is how far back a
 * record is read for a question (`readRecord` in `server-channel-chat.tsx`).
 */
export function holdsCall(
  messages: readonly Message[],
  toolCallId: string,
  askedBy?: string,
): boolean {
  return messages.some(
    (message) =>
      isCall(message, toolCallId) &&
      (askedBy === undefined || message.id === askedBy),
  );
}

/**
 * The result of a call, as the conversation holds it: the tool message that answers it. Undefined
 * while the call has none.
 *
 * WHICH CALL, WHERE MORE THAN ONE CARRIES THE ID. A provider's ids are its own to mint, and an
 * older call that carried the same one has a result of its own — read for this call, it said the
 * question was over while it was still being asked. So it is the call the asking message made
 * (`askedBy`), where the words were kept with it, and the newest call under the id where they
 * were not; and a result is that call's only as far as the next call under the same id. Words
 * kept by the id alone were read off whichever question carried it last: kept for a question
 * whose turn died, they were its later namesake's answer, or its end (review, eighth round).
 *
 * A call these messages do not hold is above them, so what answers it is whatever stands before
 * any call they do hold.
 */
function resultOf(
  messages: readonly Message[],
  toolCallId: string,
  askedBy?: string,
): Message | undefined {
  const asked =
    askedBy === undefined
      ? messages.findLastIndex((message) => isCall(message, toolCallId))
      : messages.findIndex(
          (message) => message.id === askedBy && isCall(message, toolCallId),
        );
  for (const message of messages.slice(asked + 1)) {
    if (isCall(message, toolCallId)) return undefined;
    if (message.role === "tool" && message.toolCallId === toolCallId) {
      return message;
    }
  }
  return undefined;
}

/** Whether the conversation holds a result for a call: its question is over, however it ended. */
export function hasResult(
  messages: readonly Message[],
  toolCallId: string,
  askedBy?: string,
): boolean {
  return resultOf(messages, toolCallId, askedBy) !== undefined;
}

/**
 * The words a card was answered with, read off the conversation: the result of that call, where it
 * is a typed answer. Undefined while the call has no result, and for any other result — an option
 * pressed, a wait that ran out, a stop.
 */
export function answeredInWords(
  messages: readonly Message[],
  toolCallId: string,
  askedBy?: string,
): string | undefined {
  const content = resultOf(messages, toolCallId, askedBy)?.content;
  if (typeof content !== "string") return undefined;
  try {
    const result: unknown = JSON.parse(content);
    return result && typeof result === "object"
      ? typedAnswerIn(result as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The words of a typed answer, read back out of the call's result. Undefined for anything else. */
export function typedAnswerIn(
  result: Record<string, unknown> | undefined,
): string | undefined {
  const answer = result?.answer;
  return typeof answer === "string" && answer.trim() ? answer : undefined;
}
