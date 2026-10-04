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
 * takes only an offer for the conversation it sits in (`DraftScope`, provided by `ServerChannelChat`).
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

/**
 * The compose screen's own key: before the first message there is no conversation to name. A
 * sentence offered under it is taken by the compose screen's composer and by nothing else — an 아이디어
 * pressed before the Bot was ever spoken to lands there (`channel/new.tsx`).
 */
export const COMPOSE_SCREEN_KEY = "(compose)";

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

/*
 * A SENTENCE ANOTHER SCREEN SENDS FOR THE PERSON, ON THEIR PRESS — 목표's [대화에서 시작]
 * (muse-shape plan §3.4): the sheet says the Bot will ask a few questions, and the press is the
 * person asking for that, so the sentence goes as their message rather than waiting in the box.
 *
 * IN MEMORY ONLY, NEVER FROM THE ADDRESS. `draft` comes in the address because a routine's 고치기
 * links to it; a sentence that SENDS must not, or any link — one a Bot wrote into its answer
 * included — would put words in the person's mouth. Only code on this page can offer one, and the
 * composer of the conversation it names takes it once.
 */
let toSend: Offer | null = null;
const sendWatchers = new Set<() => void>();

function announceSend(): void {
  for (const watcher of sendWatchers) watcher();
}

/** Send this sentence as the person's message once this conversation's composer can. */
export function offerSend(channelId: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  toSend = { channelId, text: trimmed };
  announceSend();
}

/** Take the sentence to send in this conversation, if there is one. Whoever takes it sends it. */
export function takeOfferedSend(channelId: string | undefined): string | null {
  if (!toSend || channelId === undefined || toSend.channelId !== channelId) {
    return null;
  }
  const { text } = toSend;
  toSend = null;
  announceSend();
  return text;
}

function subscribeSend(onChange: () => void): () => void {
  sendWatchers.add(onChange);
  return () => {
    sendWatchers.delete(onChange);
  };
}

/** The sentence waiting to be sent in this conversation, kept current, for its composer. */
export function useOfferedSend(channelId: string | undefined): string | null {
  return useSyncExternalStore(
    subscribeSend,
    () =>
      toSend && channelId !== undefined && toSend.channelId === channelId
        ? toSend.text
        : null,
    () => null,
  );
}
