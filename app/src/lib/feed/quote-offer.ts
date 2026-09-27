import type { FeedQuotePart } from "@shared/feed";
import { useSyncExternalStore } from "react";

/**
 * 이야기하기: A POST WAITING TO GO INTO A CONVERSATION'S NEXT MESSAGE, BY ITS ID.
 *
 * The same shape as the composer's offered sentence (`composer/prefill.ts`): named for the
 * conversation it is for, taken once by that conversation's composer, the latest wins. What is
 * offered is not text — it is the post's reference (`shared/feed.ts`), which the composer holds as a
 * chip above the box and sends as a part of the message; the server reads the post again for the
 * model. Muse's pattern (teardown §2), in place of pasting "이 소식에 대해: {title}".
 */
type Offer = { channelId: string; part: FeedQuotePart };

let offered: Offer | null = null;
const watchers = new Set<() => void>();

function announce(): void {
  for (const watcher of watchers) watcher();
}

export function offerFeedQuote(channelId: string, part: FeedQuotePart): void {
  offered = { channelId, part };
  announce();
}

/** Take the offer for this conversation, if there is one. Whoever takes it is the only one. */
export function takeFeedQuote(channelId: string): FeedQuotePart | null {
  if (!offered || offered.channelId !== channelId) return null;
  const { part } = offered;
  offered = null;
  announce();
  return part;
}

function subscribe(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

/** The post on offer for this conversation, kept current, for its composer to take. */
export function useOfferedFeedQuote(
  channelId: string | undefined,
): FeedQuotePart | null {
  return useSyncExternalStore(
    subscribe,
    () =>
      offered && channelId !== undefined && offered.channelId === channelId
        ? offered.part
        : null,
    () => null,
  );
}
