/**
 * One conversation, as a window holds it while the server owns its turns.
 *
 * The newest page of history, what the turn in flight has done so far, and nothing more (G2 in
 * `~/laf/docs/muse-2.2-architecture-teardown.md`). A conversation used to be downloaded whole on
 * every open, after the join, one request after the other; with one Bot per person there is one
 * conversation and it only grows. So the window opens on the last page and the live stream at the
 * same time, reads older pages as the person scrolls up, and lets go of what it holds past a few
 * pages once the person is back at the bottom.
 *
 * A plain store rather than React state: the stream, the pages and the cursor all move outside a
 * render, and the screen reads it through `useSyncExternalStore`.
 */
import type { Message } from "@ag-ui/core";
import {
  type HistoryPage,
  readHistory as readHistoryOverHttp,
  type TurnWatch,
  watchTurn as watchTurnOverHttp,
} from "./client";
import {
  applyFrame,
  EMPTY_THREAD,
  mergeMessages,
  type ThreadState,
  type TurnFrame,
} from "./frames";

/** Muse's in-memory window: three pages kept, a fourth of slack before letting go, a hard ceiling. */
export const KEEP_MESSAGES = 240;
export const LET_GO_AFTER = 320;
export const CEILING = 960;

export type ServerThread = ThreadState & {
  /** When each message was first seen, as the server's store stamped it. */
  times: Readonly<Record<string, string>>;
  /** The first page is in. Before it, the transcript has only what the stream brought. */
  loaded: boolean;
  /** The first page could not be read. */
  unreadable: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  /** The stream is open. */
  live: boolean;
};

const EMPTY: ServerThread = {
  ...EMPTY_THREAD,
  times: {},
  loaded: false,
  unreadable: false,
  hasOlder: false,
  loadingOlder: false,
  live: false,
};

export type ThreadStoreDeps = {
  readHistory: typeof readHistoryOverHttp;
  watchTurn: typeof watchTurnOverHttp;
};

export function createThreadStore(
  threadId: string,
  deps: ThreadStoreDeps = {
    readHistory: readHistoryOverHttp,
    watchTurn: watchTurnOverHttp,
  },
) {
  let state: ServerThread = EMPTY;
  const listeners = new Set<() => void>();
  /** The durable cursor of each message the pages brought: where the page above starts. */
  const seqs = new Map<string, number>();
  let oldestSeq: number | null = null;
  let watch: TurnWatch | null = null;
  const frameListeners = new Set<(frame: TurnFrame) => void>();

  const set = (next: ServerThread) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const remember = (page: HistoryPage) => {
    for (const [id, seq] of Object.entries(page.seqs ?? {})) seqs.set(id, seq);
    if (page.oldestSeq !== null) {
      oldestSeq =
        oldestSeq === null
          ? page.oldestSeq
          : Math.min(oldestSeq, page.oldestSeq);
    }
  };

  /**
   * The newest page read again and put in place of what is held: after the server restarted, what
   * this window pieced together from a turn that process never finished is not the record.
   */
  const resync = async (going: readonly Message[]) => {
    const page = await deps.readHistory(threadId, null);
    if (!page) return;
    seqs.clear();
    oldestSeq = null;
    remember(page);
    set({
      ...state,
      // The page, and over it the messages of a turn the new process has going, which it cannot hold.
      messages: mergeMessages(page.messages, going),
      times: { ...state.times, ...page.times },
      hasOlder: page.hasOlder,
    });
  };

  const onFrame = (frame: TurnFrame) => {
    const restarted =
      frame.kind === "snapshot" &&
      state.epoch !== null &&
      frame.epoch !== state.epoch;
    set({ ...state, ...applyFrame(state, frame) });
    if (restarted && frame.kind === "snapshot") void resync(frame.messages);
    for (const listener of frameListeners) listener(frame);
  };

  /** Let go of the oldest past what is kept, and say there is more above. */
  const letGo = (keep: number) => {
    if (state.messages.length <= keep) return;
    const kept = state.messages.slice(state.messages.length - keep);
    const firstKnown = kept.find((message) => seqs.has(message.id));
    if (firstKnown) oldestSeq = seqs.get(firstKnown.id) ?? oldestSeq;
    const keptIds = new Set(kept.map((message) => message.id));
    for (const id of seqs.keys()) if (!keptIds.has(id)) seqs.delete(id);
    set({ ...state, messages: kept, hasOlder: true });
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot(): ServerThread {
      return state;
    },

    /** Every frame as it is applied, for a caller that reacts to what happened rather than to state. */
    onFrame(listener: (frame: TurnFrame) => void): () => void {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },

    /** The newest page and the stream, together. */
    async open(): Promise<void> {
      watch = deps.watchTurn(threadId, {
        cursor: () =>
          state.epoch && state.seq > 0 ? `${state.epoch}:${state.seq}` : null,
        onFrame,
        onLive: (live) => {
          if (live !== state.live) set({ ...state, live });
        },
      });
      const page = await deps.readHistory(threadId, null);
      if (!page) {
        set({ ...state, loaded: true, unreadable: true });
        return;
      }
      remember(page);
      set({
        ...state,
        // The page first, and whatever the stream has already brought over it, by id.
        messages: mergeMessages(page.messages, state.messages),
        times: { ...page.times, ...state.times },
        hasOlder: page.hasOlder,
        loaded: true,
        unreadable: false,
      });
    },

    /** The page above what is held, for a person scrolling up. */
    async loadOlder(): Promise<void> {
      if (!state.hasOlder || state.loadingOlder || oldestSeq === null) return;
      set({ ...state, loadingOlder: true });
      const page = await deps.readHistory(threadId, oldestSeq);
      if (!page) {
        set({ ...state, loadingOlder: false });
        return;
      }
      remember(page);
      const held = new Set(state.messages.map((message) => message.id));
      set({
        ...state,
        messages: [
          ...page.messages.filter((message) => !held.has(message.id)),
          ...state.messages,
        ],
        times: { ...page.times, ...state.times },
        hasOlder: page.hasOlder,
        loadingOlder: false,
      });
    },

    /**
     * Messages this window is sending, drawn at once. The stream's own copies replace them by id.
     */
    addLocal(messages: readonly Message[], at: string): void {
      set({
        ...state,
        messages: mergeMessages(state.messages, messages),
        times: {
          ...Object.fromEntries(messages.map((message) => [message.id, at])),
          ...state.times,
        },
      });
    },

    /** Messages that never reached the server, taken back off the screen. */
    removeLocal(ids: readonly string[]): void {
      const gone = new Set(ids);
      set({
        ...state,
        messages: state.messages.filter((message) => !gone.has(message.id)),
      });
    },

    /** The turn's failure line is the window's to clear once a retry is on its way. */
    clearEnding(): void {
      if (state.failure === null && state.notice === null) return;
      set({ ...state, failure: null, notice: null });
    },

    /**
     * Let go of what is held past three pages. Called when the person sends — they are at the
     * bottom, reading the newest — and above the ceiling whatever they are doing.
     */
    compact(force = false): void {
      if (
        state.messages.length > CEILING ||
        (force && state.messages.length > LET_GO_AFTER)
      ) {
        letGo(KEEP_MESSAGES);
      }
    },

    /** Open a fresh stream now: the window came back into view, or back online. */
    nudge(): void {
      watch?.nudge();
    },

    close(): void {
      watch?.close();
      watch = null;
      listeners.clear();
      frameListeners.clear();
    },
  };
}

export type ThreadStore = ReturnType<typeof createThreadStore>;
