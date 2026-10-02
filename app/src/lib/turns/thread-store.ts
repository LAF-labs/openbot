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
  RETRY_FIRST_MS,
  RETRY_MOST_MS,
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
  /**
   * The first page is in. Before it, the transcript has only what the stream brought.
   *
   * NOT TRUE OF A PAGE THAT COULD NOT BE READ. It used to be set with `unreadable`, as "the open is
   * over", and what waits for the page went ahead without it: words kept on this device spent their
   * one automatic send on the same server that had just failed to answer the read.
   */
  loaded: boolean;
  /** The first page could not be read, and is being read again until it can. */
  unreadable: boolean;
  /** A read of it is out again right now: the press beside the line saying so is busy. */
  rereading: boolean;
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
  rereading: false,
  hasOlder: false,
  loadingOlder: false,
  live: false,
};

export type ThreadStoreDeps = {
  readHistory: typeof readHistoryOverHttp;
  watchTurn: typeof watchTurnOverHttp;
  /** Run something after a wait, and hand back the way to call it off. A test holds the clock here. */
  later?: (run: () => void, ms: number) => () => void;
};

const afterTimeout = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
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
  const later = deps.later ?? afterTimeout;
  /** Closed with the room: a read that answers after it must start nothing. */
  let closed = false;
  /** The wait before the first page is read again, and the way to call that wait off. */
  let retryMs = RETRY_FIRST_MS;
  let callOff: (() => void) | null = null;
  /** How many reads of the first page have gone out: only the newest one's failure sets a wait. */
  let firstReads = 0;
  /**
   * The words this window is sending, by id: drawn at once (`addLocal`), and not the record's until
   * a page or the stream brings its own copy. Where a page shares nothing with what is held they
   * are what stays under it.
   */
  const sending = new Set<string>();
  /**
   * A screen came back to this store and the stream has not yet said how the turn stands
   * (`resume`): the epoch it had before, which is how a server that restarted meanwhile is told.
   */
  let isResuming = false;
  let epochBefore: string | null = null;

  const set = (next: ServerThread) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const remember = (page: HistoryPage) => {
    for (const [id, seq] of Object.entries(page.seqs ?? {})) seqs.set(id, seq);
    // What the record holds is not this window's alone any more.
    for (const message of page.messages) sending.delete(message.id);
    if (page.oldestSeq !== null) {
      oldestSeq =
        oldestSeq === null
          ? page.oldestSeq
          : Math.min(oldestSeq, page.oldestSeq);
    }
  };

  /** The first page is in, by whichever read brought it: nothing waits to read it again. */
  const opened = () => {
    callOff?.();
    callOff = null;
    retryMs = RETRY_FIRST_MS;
    return { loaded: true, unreadable: false, rereading: false } as const;
  };

  /**
   * THE FIRST PAGE, READ UNTIL IT IS IN.
   *
   * It used to be read once. People reopen the app right after the server restarted, which is when
   * that one read is answered 503 by the front door: the store marked the page unreadable and never
   * read it again, the screen never looked at the mark, and the conversation was drawn empty under
   * the Bot's greeting until somebody reloaded the page (review, 2026-10-02). The stream beside it
   * has always reopened itself on a backoff; the page is read again on the same one.
   */
  const readFirstPage = async (): Promise<void> => {
    if (closed || state.loaded) return;
    firstReads += 1;
    const mine = firstReads;
    callOff?.();
    callOff = null;
    if (state.unreadable && !state.rereading) {
      set({ ...state, rereading: true });
    }
    const page = await deps.readHistory(threadId, null);
    // Closed meanwhile, or another read — a refresh, a restart's — already brought the page.
    if (closed || state.loaded) return;
    if (page) {
      remember(page);
      set({
        ...state,
        // The page first, and whatever the stream has already brought over it, by id.
        messages: mergeMessages(page.messages, state.messages),
        times: { ...page.times, ...state.times },
        hasOlder: page.hasOlder,
        ...opened(),
      });
      return;
    }
    // A newer read is out; what happens next is its answer's to say.
    if (mine !== firstReads) return;
    set({ ...state, unreadable: true, rereading: false });
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, RETRY_MOST_MS);
    callOff = later(() => {
      callOff = null;
      void readFirstPage();
    }, wait);
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
      // On a store whose first page never arrived, this page is it.
      ...(state.loaded ? {} : opened()),
    });
  };

  /**
   * A PAGE LAID OVER WHAT IS HELD, IN THE RECORD'S ORDER.
   *
   * The page is a stretch of the record in the order it was written, so that is the order its rows
   * are in afterwards — the held ones, in the places the held ones had, and each row the page adds
   * right after the row it follows in the record. A row only this window has stays where it
   * stands: above, a row an older page brought; below, words being sent.
   *
   * Two orders this did not keep, each met on coming back to a kept conversation:
   *  - what the page added was put at the end, under the words only this window holds: a routine's
   *    delivery drawn below what was typed after it (adversarial read, 2026-10-02);
   *  - and "before those words" was still after everything the stream had brought: held A, a
   *    snapshot bringing the going turn's C, and a page A·B·C made A·C·B — the turn missed while
   *    nobody looked, under the one being answered (review, second round).
   *
   * `keep` says whose copy stands for a row both have: the page's when the record is to replace
   * what was pieced together, the held one when the page is only read for what is missing.
   */
  const withPage = (
    held: readonly Message[],
    page: HistoryPage,
    keep: "page" | "held",
  ): readonly Message[] => {
    const inPage = new Set(page.messages.map((message) => message.id));
    const heldById = new Map(held.map((message) => [message.id, message]));
    // The page's rows that are held, in the page's order, and the rows it adds after each.
    const shared = page.messages.filter((message) => heldById.has(message.id));
    if (shared.length === 0) {
      // Nothing in common: the page goes after everything but the words this window is sending.
      let place = held.length;
      while (place > 0 && sending.has(held[place - 1]?.id ?? "")) place -= 1;
      return [...held.slice(0, place), ...page.messages, ...held.slice(place)];
    }
    const leading: Message[] = [];
    const following = new Map<string, Message[]>();
    let after: string | null = null;
    for (const message of page.messages) {
      if (heldById.has(message.id)) {
        after = message.id;
      } else if (after === null) {
        leading.push(message);
      } else {
        following.set(after, [...(following.get(after) ?? []), message]);
      }
    }
    const next: Message[] = [];
    let slot = 0;
    for (const message of held) {
      if (!inPage.has(message.id)) {
        next.push(message);
        continue;
      }
      // The places the held ones had, filled in the page's order.
      const row = shared[slot] ?? message;
      slot += 1;
      if (slot === 1) next.push(...leading);
      next.push(keep === "held" ? (heldById.get(row.id) ?? row) : row);
      next.push(...(following.get(row.id) ?? []));
    }
    return next;
  };

  /**
   * The newest page laid over what is held, by id, and the live turn over that: a window that
   * resumed past the frames the server still keeps is sent a snapshot, not what it missed.
   *
   * SAME PROCESS, FRAMES GONE (2026-09-27 code sprint). Only a restart used to re-read the page, so
   * a window that went quiet mid-answer (a phone in a pocket) and came back after the turn's frames
   * were swept kept the half it had streamed — under a turn the snapshot said was done. The stored
   * message replaces the half by id; nothing held is dropped.
   */
  const catchUp = async (going: readonly Message[]) => {
    const page = await deps.readHistory(threadId, null);
    if (!page) return;
    remember(page);
    set({
      ...state,
      messages: mergeMessages(withPage(state.messages, page, "page"), going),
      times: { ...state.times, ...page.times },
    });
  };

  const onFrame = (frame: TurnFrame) => {
    // The epoch a resuming store had is the one a restart is told against.
    const known = state.epoch ?? epochBefore;
    const restarted =
      frame.kind === "snapshot" && known !== null && frame.epoch !== known;
    /*
     * A store somebody came back to reads the page under the snapshot whatever its cursor was: a
     * conversation no turn has touched since the server started has no frames at all, and a
     * routine's delivery is not one.
     */
    const resumed =
      frame.kind === "snapshot" &&
      !restarted &&
      state.loaded &&
      (state.seq > 0 || isResuming);
    if (frame.kind === "snapshot") {
      isResuming = false;
      epochBefore = null;
    }
    set({ ...state, ...applyFrame(state, frame) });
    if (restarted && frame.kind === "snapshot") void resync(frame.messages);
    else if (resumed && frame.kind === "snapshot") void catchUp(frame.messages);
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
      // Opened again after a close — a development double-mount — starts over, not where it left off.
      closed = false;
      retryMs = RETRY_FIRST_MS;
      watch = deps.watchTurn(threadId, {
        cursor: () =>
          state.epoch && state.seq > 0 ? `${state.epoch}:${state.seq}` : null,
        onFrame,
        onLive: (live) => {
          if (live !== state.live) set({ ...state, live });
        },
      });
      await readFirstPage();
    },

    /** 다시 시도 beside the line saying the page could not be read: now, and the waits start over. */
    async retry(): Promise<void> {
      retryMs = RETRY_FIRST_MS;
      await readFirstPage();
    },

    /**
     * The newest page read again and whatever it holds that this window does not, added: something
     * other than a turn wrote to the conversation — a routine delivering its answer at seven in the
     * morning while the conversation sits open on a desk.
     */
    async refresh(): Promise<void> {
      /*
       * A store whose first page never arrived has nothing to add to, and this read is its open. It
       * used to append what it found under whatever the stream had brought — the conversation so
       * far, below the turn in flight — and leave `hasOlder` saying there was nothing above.
       */
      if (!state.loaded) {
        await readFirstPage();
        return;
      }
      const page = await deps.readHistory(threadId, null);
      if (!page) return;
      remember(page);
      const held = new Set(state.messages.map((message) => message.id));
      const missing = page.messages.filter((message) => !held.has(message.id));
      /*
       * THE TIMES OF WHAT IS ALREADY HELD COME WITH THE PAGE TOO. A frame carries no time, so a row
       * the stream brought has none until something reads the record — the screen does, when a turn
       * ends in front of it. A store kept while no screen was looking heard the answer and nobody
       * read its time: the person came back to a reply with no time, and so with no line saying
       * where they had stopped reading (adversarial read of the kept conversation, 2026-10-02).
       * This returned before the times whenever no message was missing.
       */
      const isUntimed = Object.keys(page.times).some(
        (id) => held.has(id) && !(id in state.times),
      );
      if (missing.length === 0 && !isUntimed) return;
      set({
        ...state,
        // What is missing goes where the record has it (`withPage`); what is held stays as held.
        messages:
          missing.length === 0
            ? state.messages
            : withPage(state.messages, page, "held"),
        times: { ...page.times, ...state.times },
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
      for (const message of messages) sending.add(message.id);
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
      for (const id of gone) sending.delete(id);
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

    /**
     * A SCREEN CAME BACK TO A STORE KEPT WITH NOBODY LOOKING (`kept-threads.ts`): what it holds of
     * the turn is not known to be current until the stream says so.
     *
     * Nothing woke the stream while no screen was there — a laptop asleep leaves a socket that
     * looks alive and hears nothing — and another window may have started a turn since. The store
     * went on saying its old idle turn, under an epoch that reads "the stream has spoken", and
     * what the device kept was sent by itself into that turn and refused (review, 2026-10-02): the
     * one send it gets, spent, and the words left under 보내지 못함.
     *
     * So the stream is opened again WITHOUT A CURSOR, which the server answers with a snapshot —
     * how the turn stands now — and until it has, the epoch is unknown again: whatever waits for
     * the stream to have spoken waits. Under the snapshot the newest page is read (`catchUp`):
     * what something other than a turn wrote meanwhile, and the times of what the stream brought.
     */
    resume(): void {
      if (closed || !watch) return;
      isResuming = true;
      if (state.epoch !== null) {
        epochBefore = state.epoch;
        set({ ...state, epoch: null });
      }
      watch.nudge();
      if (!state.loaded && state.unreadable) void readFirstPage();
    },

    /** Open a fresh stream now: the window came back into view, or back online. */
    nudge(): void {
      watch?.nudge();
      // And the page, if it is still owed: the connection that came back is the one it was missing.
      if (!state.loaded && state.unreadable) void readFirstPage();
    },

    close(): void {
      closed = true;
      callOff?.();
      callOff = null;
      watch?.close();
      watch = null;
      listeners.clear();
      frameListeners.clear();
    },
  };
}
