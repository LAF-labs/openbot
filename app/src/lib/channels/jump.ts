import { useSyncExternalStore } from "react";

/**
 * A PLACE IN A CONVERSATION ANOTHER PART OF THE SCREEN WANTS SHOWN.
 *
 * 오늘 in the sidebar lists what the Bot did; pressing a row goes to where it happened — the Bot's
 * first message of a turn, a routine's delivered answer, or the card an approval is waiting on. The
 * sidebar is not inside the transcript, and the transcript may not even be mounted yet when the
 * press lands (it is on another screen, or its history is still arriving). So the press is left
 * here, named for its conversation, and the transcript takes it once the row it names is drawn
 * (`chat-transcript.tsx`, `JumpToRow`) — through the scroller's own `scrollToMessage`, because a
 * plain `scrollIntoView` is undone by the scroller following the bottom the next time anything
 * arrives.
 *
 * The same shape as the composer's offered draft (`composer/prefill.ts`): one at a time, the latest
 * wins, and a conversation takes only what was left for it.
 */
export type Jump = {
  channelId: string;
  /** A transcript row, by the id the scroller keys it with (`data-message-id`). */
  messageId?: string;
  /** Or the card waiting on the person (`data-waiting-card`), whose first button gets the keyboard. */
  waitingCard?: string;
};

let pending: Jump | null = null;
const watchers = new Set<() => void>();

function announce(): void {
  for (const watcher of watchers) watcher();
}

export function requestJump(jump: Jump): void {
  if (!jump.messageId && !jump.waitingCard) return;
  pending = { ...jump };
  announce();
}

/** Taken: whoever showed it is the only one. */
export function settleJump(jump: Jump): void {
  if (pending !== jump) return;
  pending = null;
  announce();
}

/** The conversation left the screen with its jump untaken; it was for there and nowhere else. */
export function dropJump(channelId: string): void {
  if (pending?.channelId !== channelId) return;
  pending = null;
  announce();
}

function subscribe(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

/**
 * Bring an element into view once it is drawn: a routine's card, what the Bot remembers.
 *
 * The router scrolls to a `#hash` when the navigation resolves, and the screen it lands on draws its
 * list a moment later — measured from 오늘: the routine's card and the memory section were not in
 * the document yet, and the page stayed at its top. So the element is waited for, a few seconds at
 * most, and then shown and marked for a moment (`data-jumped`).
 */
export function revealWhenDrawn(id: string, withinMs = 6000): void {
  const show = (element: Element) => {
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    // Marked a moment, as a transcript row is: `:target` does not follow the router's pushState.
    element.setAttribute("data-jumped", "true");
    setTimeout(() => element.removeAttribute("data-jumped"), 2400);
  };
  const found = document.getElementById(id);
  if (found) {
    show(found);
    return;
  }
  const watcher = new MutationObserver(() => {
    const drawn = document.getElementById(id);
    if (!drawn) return;
    watcher.disconnect();
    clearTimeout(giveUp);
    show(drawn);
  });
  const giveUp = setTimeout(() => watcher.disconnect(), withinMs);
  watcher.observe(document.body, { childList: true, subtree: true });
}

export function usePendingJump(channelId: string | undefined): Jump | null {
  return useSyncExternalStore(
    subscribe,
    () => (pending && pending.channelId === channelId ? pending : null),
    () => null,
  );
}
