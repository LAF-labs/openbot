/**
 * A CONVERSATION KEPT WHILE THE PERSON LOOKS AT ANOTHER PLACE.
 *
 * Pressed on the running app, 2026-10-02: from 대화 to 소식 and back. The conversation's screen is
 * one of the places that take turns in the app's one outlet, so leaving it unmounted it, and its
 * store (`thread-store.ts`) was made by the screen and closed with it. Coming back built the
 * conversation again from nothing: the Bot's greeting drawn first — "안녕하세요, 저는 새벽이에요",
 * for a third of a second on the local stack, where the server is a millisecond away — then the
 * history read again, and the newest rows cascading in. The screen a person returns to most said
 * hello again every time, and a turn still being answered came back without the half already said.
 *
 * So the store outlives the screen. It is kept, stream open, for a while after the screen leaves,
 * and the screen that comes back is handed the same one: what it draws first is the conversation
 * as it stands. One Bot per person is one conversation, so this is one open stream on the other
 * places of the app, for at most `KEPT_FOR_MS` after the last look.
 *
 * HELD BY THE SCREEN'S EFFECT, NOT BY ASKING. `threadFor` only finds or makes the store, because a
 * render can ask and never be committed (a development double render, a transition thrown away);
 * `holdThread` and `releaseThread` are the effect and its cleanup. Nothing is opened for a render
 * that was thrown away, and a screen that mounts twice in a breath — development again — neither
 * closes nor reads anything a second time.
 */
import { isTurnGoing, type TurnState } from "./frames";
import { createThreadStore } from "./thread-store";

/** How long a conversation nobody is looking at is kept, with its stream open. */
export const KEPT_FOR_MS = 10 * 60_000;

/** As much of the store as keeping it takes. The real one is `createThreadStore`'s. */
type Keepable = {
  open(): Promise<void>;
  close(): void;
  nudge(): void;
  refresh(): Promise<void>;
  snapshot(): { turn: TurnState | null };
};

type Deps<Store extends Keepable> = {
  create: (threadId: string) => Store;
  /** Run something after a wait, and hand back the way to call it off. A test holds the clock here. */
  later: (run: () => void, ms: number) => () => void;
};

const REAL: Deps<ReturnType<typeof createThreadStore>> = {
  create: (threadId) => createThreadStore(threadId),
  later: (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

type Kept = {
  store: Keepable;
  /** Screens showing it right now. */
  holders: number;
  isOpen: boolean;
  /** Calls off the wait that would let go of it. */
  callOff: (() => void) | null;
};

const kept = new Map<string, Kept>();

function entryFor<Store extends Keepable>(
  threadId: string,
  deps: Deps<Store>,
): Kept {
  let entry = kept.get(threadId);
  if (!entry) {
    entry = {
      store: deps.create(threadId),
      holders: 0,
      isOpen: false,
      callOff: null,
    };
    kept.set(threadId, entry);
  }
  return entry;
}

/** The store of a conversation: the one being kept, or a new one. Opens nothing and holds nothing. */
export function threadFor(
  threadId: string,
): ReturnType<typeof createThreadStore>;
export function threadFor<Store extends Keepable>(
  threadId: string,
  deps: Deps<Store>,
): Store;
export function threadFor(
  threadId: string,
  deps: Deps<Keepable> = REAL,
): Keepable {
  return entryFor(threadId, deps).store;
}

/**
 * A screen is showing the conversation. Whether it was being kept open — true for somebody coming
 * back, false for the first look.
 *
 * Coming back, the stream is opened afresh from where it was: nothing woke it while no screen was
 * there to hear the window come back into view or the connection return. And what something other
 * than a turn wrote meanwhile — a routine's delivery — is read in, unless a turn is going, whose
 * end reads it in under itself (`server-channel-chat.tsx`).
 *
 * `store` IS THE ONE THE SCREEN HAS IN ITS HAND, and it is the one that is kept. Everything kept can
 * be forgotten under a screen that is still mounted — signing out; a development remount, which
 * tears every effect down and sets it up again — and holding by name alone then made a second
 * store that no screen was reading, and left the screen with a closed one. The screen's store is
 * put back and opened again.
 */
export function holdThread(
  threadId: string,
  deps: Deps<Keepable> = REAL,
  store?: Keepable,
): boolean {
  let entry = kept.get(threadId);
  if (store && entry?.store !== store) {
    // What is kept under this name is not the screen's — made after a forgetting. Unheld, it goes.
    entry?.callOff?.();
    if (entry?.holders === 0 && entry.isOpen) entry.store.close();
    entry = { store, holders: 0, isOpen: false, callOff: null };
    kept.set(threadId, entry);
  }
  entry ??= entryFor(threadId, deps);
  entry.callOff?.();
  entry.callOff = null;
  entry.holders += 1;
  if (!entry.isOpen) {
    entry.isOpen = true;
    void entry.store.open();
    return false;
  }
  if (entry.holders === 1) {
    entry.store.nudge();
    if (!isTurnGoing(entry.store.snapshot().turn)) void entry.store.refresh();
  }
  return true;
}

/** The screen left. Kept for a while, in case they come back; then closed and forgotten. */
export function releaseThread(
  threadId: string,
  deps: Deps<Keepable> = REAL,
  store?: Keepable,
): void {
  const entry = kept.get(threadId);
  // Forgotten meanwhile, or another store is kept under this name now: nothing of this screen's.
  if (!entry || (store && entry.store !== store)) return;
  entry.holders = Math.max(0, entry.holders - 1);
  if (entry.holders > 0) return;
  entry.callOff?.();
  entry.callOff = deps.later(() => {
    // Asked for again and held meanwhile, or already forgotten: not this wait's to close.
    if (kept.get(threadId) !== entry || entry.holders > 0) return;
    kept.delete(threadId);
    entry.store.close();
  }, KEPT_FOR_MS);
}

/** Every kept conversation closed and forgotten: on signing out, and between tests. */
export function forgetKeptThreads(): void {
  for (const entry of kept.values()) {
    entry.callOff?.();
    entry.store.close();
  }
  kept.clear();
}
