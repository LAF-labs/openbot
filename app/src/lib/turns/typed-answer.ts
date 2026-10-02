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

/** The Bot's question with options. Its tool is in `components/gallery/decisions.tsx`. */
const CHOICE = "askChoice";

/** Whether a choice call is the one that saves who the person is: answered by a press, and only by one. */
function savesByPress(argumentsJson: string): boolean {
  try {
    const args = JSON.parse(argumentsJson) as { saves?: unknown } | null;
    return typeof args?.saves === "string";
  } catch {
    // Arguments that cannot be read are not known to be an ordinary question either.
    return true;
  }
}

/**
 * The question the turn is stopped on that words can answer: the newest choice card it waits on.
 *
 * Not a yes-or-no card (`askApproval`), which has its own place for a reason and must never take
 * words for a yes; not a connect card; and not the choice that saves who the person is, where what
 * is saved is one of four presses (`saves: "persona"`). Typed under those, words wait for the turn
 * to end, as they always did.
 */
export function openChoiceCall(
  messages: readonly Message[],
  waiting: readonly string[],
): string | null {
  if (waiting.length === 0) return null;
  const isWaiting = new Set(waiting);
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    for (const call of [...(message.toolCalls ?? [])].reverse()) {
      if (
        isWaiting.has(call.id) &&
        call.function.name === CHOICE &&
        !savesByPress(call.function.arguments)
      ) {
        return call.id;
      }
    }
  }
  return null;
}

/** What the Bot is answered with when the person typed instead of pressing an option. */
export function typedAnswer(words: string): { answer: string } {
  return { answer: words };
}

/** The words of a typed answer, read back out of the call's result. Undefined for anything else. */
export function typedAnswerIn(
  result: Record<string, unknown> | undefined,
): string | undefined {
  const answer = result?.answer;
  return typeof answer === "string" && answer.trim() ? answer : undefined;
}
