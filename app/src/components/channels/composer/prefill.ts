import { createContext, useSyncExternalStore } from "react";

/**
 * A SENTENCE ANOTHER SCREEN STARTED FOR THE PERSON, WAITING IN THE COMPOSER FOR THEM TO FINISH.
 *
 * The agreement between packages A and C for 0.5.3 (UI/UX audit, item 8): a routine's "고치기" does
 * not open a form. It goes to `/channel/{id}?draft=<sentence>` — "'주간 매출 요약'을 이렇게 바꿔 줘: " —
 * and the conversation puts that sentence in the box, gives it the caret, and takes the argument out
 * of the address, so a reload or a back button does not type it in a second time.
 *
 * The route reads the argument (`channel/$channelId.tsx`) and the composer takes it from here. A
 * store rather than a prop because the two are four components apart, and none of the ones between
 * has anything to do with it.
 *
 * FOR ONE CONVERSATION, AND TAKEN ONCE. The offer names the conversation it is for, and a composer
 * takes only an offer for the conversation it sits in (`DraftScope`, provided by `ChannelChat`).
 * Unscoped, the first composer to hear of it took it — measured in the full gate run, where a
 * composer another test had left mounted took the sentence and the conversation's box stayed empty.
 * The compose screen, which is in no conversation, never takes one; and the route withdraws an
 * offer nobody took when it leaves.
 */
type Offer = { channelId: string; text: string };

let offered: Offer | null = null;
const watchers = new Set<() => void>();

function announce(): void {
  for (const watcher of watchers) watcher();
}

/** The conversation a composer sits in, for the offers it may take. None: it takes nothing. */
export const DraftScope = createContext<string | undefined>(undefined);

/** Put a sentence in this conversation's composer once it can take it. The latest offer wins. */
export function offerDraft(channelId: string, text: string): void {
  const trimmed = text.trimStart();
  if (!trimmed) return;
  offered = { channelId, text: trimmed };
  announce();
}

/** Take the offer for this conversation, if there is one. Whoever takes it is the only one. */
export function takeOfferedDraft(channelId: string | undefined): string | null {
  if (!offered || channelId === undefined || offered.channelId !== channelId) {
    return null;
  }
  const { text } = offered;
  offered = null;
  announce();
  return text;
}

/** Nobody took it and the conversation it was for has gone from the screen. */
export function withdrawDraft(channelId: string): void {
  if (offered?.channelId !== channelId) return;
  offered = null;
  announce();
}

function subscribe(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

/** The sentence on offer for this conversation, kept current, for its composer to take. */
export function useOfferedDraft(channelId: string | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () =>
      offered && channelId !== undefined && offered.channelId === channelId
        ? offered.text
        : null,
    () => null,
  );
}
