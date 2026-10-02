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
  isTurnGoing,
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
  /** The cursor of the newest row any page has brought: a page that ends before it was read earlier. */
  let newestSeq: number | null = null;
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
   * The words this window is sending, by id: drawn at once (`addLocal`), and this window's alone
   * until the server has them — which the stream says, by bringing its own copy of them or naming
   * them as what a turn was asked, and a page says by holding them.
   *
   * THE STREAM SAYING SO IS WHAT TAKES THEM OFF. Only a page did: a question asked before a long
   * task was still "being sent" when the lid was opened on the finished answer, a hundred rows
   * later, and a page put in place of what was held kept it — under its own answer (adversarial
   * read, 2026-10-03).
   */
  const sending = new Set<string>();
  /**
   * Those of them the server has answered for (`sent`), and the stream has not yet placed. Still
   * drawn last, under whatever the stream brings before it places them — but no longer this
   * window's alone: a page put in place of what is held does not keep them under it. A stream
   * that has gone quiet never says the server took them, and a question it had long since taken
   * was kept below its own answer.
   */
  const taken = new Set<string>();
  /**
   * WHAT THE STREAM HAS BROUGHT SINCE ITS NEWEST SNAPSHOT: that snapshot's own messages, and every
   * message a frame after it added or changed.
   *
   * It is what a page put in place of everything held (`putInPlace`) must not take with it: the
   * turn the server has going, or has had, since it last said how things stand — which a page read
   * before it cannot hold. Read off the store when the page arrives, not handed along from the
   * snapshot that started the read: handed along, a restart's read answering late put the page in
   * place of a turn a later snapshot had brought (review, fifth round).
   */
  const brought = new Set<string>();
  /**
   * THE ROWS OF IT THAT BELONG TO A TURN STILL IN FLIGHT. Frames are still arriving for these, so
   * the copy held is the one being written to, and the record's copy does not take its place: laid
   * over it, the snapshot's copies rolled an answer back to where the snapshot had it, and the next
   * pieces were added to the older copy (review, third round).
   *
   * ONLY WHILE THE TURN IS IN FLIGHT. Once the stream says it is over, the record's copy is the
   * whole of each row and the held one is whatever this window pieced together — the half of an
   * answer, where its frames were lost on the way. A page read after that replaces it.
   */
  const live = new Set<string>();
  /**
   * How many snapshots the stream has sent. A page whose read went out before the newest of them
   * was read across a break in the stream: what the stream brought between that read and the
   * snapshot is no longer `brought`, and may not be on the page either.
   */
  let snapshots = 0;
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

  /** The stream or a page has these words now: they are in their place, and not being sent. */
  const placed = (id: string) => {
    sending.delete(id);
    taken.delete(id);
  };

  const remember = (page: HistoryPage) => {
    for (const [id, seq] of Object.entries(page.seqs ?? {})) seqs.set(id, seq);
    // What the record holds is not this window's alone any more.
    for (const message of page.messages) placed(message.id);
    if (page.oldestSeq !== null) {
      oldestSeq =
        oldestSeq === null
          ? page.oldestSeq
          : Math.min(oldestSeq, page.oldestSeq);
    }
    if (page.newestSeq !== null) {
      newestSeq = Math.max(newestSeq ?? page.newestSeq, page.newestSeq);
    }
  };

  /**
   * THE PAGE DOES NOT REACH WHAT IS HELD: it begins on a row no page has brought, and the record
   * goes on above it.
   *
   * What is held is one stretch of the record and what the stream has brought since, and a page is
   * laid over it by the rows the two share (`withPage`). Where more than a page was written while
   * this window heard nothing — a laptop asleep through a long turn, an evening on the phone — the
   * newest page begins past everything held. Laid all the same, it sat under the old rows as if it
   * followed them: probed with rows 101–180 over a store holding 1–80, the store held 160 rows and
   * said nothing was above. Rows 81–100 were in neither, and were never asked for — the page above
   * is asked for from the oldest row held. An answer whose question nobody could scroll to.
   *
   * Told by the page's first row, not by whether the two share anything: the going turn's question
   * is held and stored, and a page that ends on it shares a row with a store it does not reach.
   *
   * AND ONLY A ROW A PAGE BROUGHT COUNTS (`seqs`). What the stream brought is the turns, and the
   * record is more than the turns: a routine delivers into it while a turn runs, and a snapshot
   * brings the turn in flight however much was written before it. Rows 1–80 held, a short turn
   * missed, a long one going: the snapshot brought rows 85–200, the page began on row 121 — held —
   * and rows 81–84 were in neither. And a delivery in the first minutes of a turn that then wrote
   * a page of rows was never drawn at all (adversarial read and model check, 2026-10-03).
   *
   * NOT A PAGE READ BEFORE ONE THAT IS ALREADY IN (`isOutrun`). Two reads can be out at once, and
   * the one that lands second may be the one read first: it begins above what the later page put
   * in place, and nothing is missing between them.
   */
  const isApart = (page: HistoryPage): boolean => {
    const first = page.messages[0];
    if (!first || !page.hasOlder || isOutrun(page)) return false;
    return !seqs.has(first.id);
  };

  /** The page ends before the newest row a page has already brought: it was read before that one. */
  const isOutrun = (page: HistoryPage): boolean =>
    page.newestSeq !== null && newestSeq !== null && page.newestSeq < newestSeq;

  /**
   * A page read before one that is already in, and sharing nothing with what is held now: older
   * than all of it. Laid, it went under the newer rows as if it followed them; it says nothing
   * that scrolling up will not read in its place.
   */
  const isLeftBehind = (page: HistoryPage): boolean => {
    if (!isOutrun(page)) return false;
    const held = new Set(state.messages.map((message) => message.id));
    return !page.messages.some((message) => held.has(message.id));
  };

  /** The first page is in, by whichever read brought it: nothing waits to read it again. */
  const opened = () => {
    callOff?.();
    callOff = null;
    retryMs = RETRY_FIRST_MS;
    return { loaded: true, unreadable: false, rereading: false } as const;
  };

  /** The held copies the record's do not replace: a turn in flight's, and words being sent. */
  const standing = (): readonly Message[] =>
    state.messages.filter(
      (message) => live.has(message.id) || sending.has(message.id),
    );

  /** Those copies put back over rows that were laid, each in its own place and nowhere else. */
  const inPlace = (
    rows: readonly Message[],
    copies: readonly Message[],
  ): readonly Message[] => {
    if (copies.length === 0) return rows;
    const byId = new Map(copies.map((message) => [message.id, message]));
    return rows.map((message) => byId.get(message.id) ?? message);
  };

  /** The page's copy of a row, or the held one where the two say the same: nothing to draw again. */
  const copyOf = (held: Message | undefined, stored: Message): Message =>
    held && JSON.stringify(held) === JSON.stringify(stored) ? held : stored;

  /**
   * A PAGE LAID OVER WHAT IS HELD, IN THE RECORD'S ORDER, AND IN THE RECORD'S WORDS.
   *
   * The page is a stretch of the record in the order it was written, so that is the order its rows
   * are in afterwards — the held ones, in the places the held ones had, and each row the page adds
   * right after the row it follows in the record. A row only this window has stays where it
   * stands: above, a row an older page brought; below, what the stream has brought and the record
   * does not hold yet, and words being sent.
   *
   * Two orders this did not keep, each met on coming back to a kept conversation:
   *  - what the page added was put at the end, under the words only this window holds: a routine's
   *    delivery drawn below what was typed after it (adversarial read, 2026-10-02);
   *  - and "before those words" was still after everything the stream had brought: held A, a
   *    snapshot bringing the going turn's C, and a page A·B·C made A·C·B — the turn missed while
   *    nobody looked, under the one being answered (review, second round).
   *
   * A row both have is the record's (`standing` is put back over it by whoever lays the page). It
   * was the held copy's wherever the page was only read for what was missing, and a window whose
   * frames were lost on the way kept half an answer under a turn that was over, for as long as it
   * stayed open.
   */
  const withPage = (
    held: readonly Message[],
    page: HistoryPage,
  ): readonly Message[] => {
    const inPage = new Set(page.messages.map((message) => message.id));
    const heldById = new Map(held.map((message) => [message.id, message]));
    // The page's rows that are held, in the page's order, and the rows it adds after each.
    const shared = page.messages.filter((message) => heldById.has(message.id));
    if (shared.length === 0) {
      if (page.messages.length === 0) return held;
      // Nothing in common: the page goes after everything but what the stream has brought since
      // it last said how things stand, and the words this window is sending — both newer than it.
      let place = held.length;
      while (place > 0) {
        const id = held[place - 1]?.id ?? "";
        if (!sending.has(id) && !brought.has(id)) break;
        place -= 1;
      }
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
    let isSame = leading.length === 0 && following.size === 0;
    for (const message of held) {
      if (!inPage.has(message.id)) {
        next.push(message);
        continue;
      }
      // The places the held ones had, filled in the page's order.
      const row = shared[slot] ?? message;
      slot += 1;
      if (slot === 1) next.push(...leading);
      const copy = copyOf(heldById.get(row.id), row);
      if (copy !== message) isSame = false;
      next.push(copy);
      next.push(...(following.get(row.id) ?? []));
    }
    return isSame ? held : next;
  };

  /** The page's times over the held ones, or the held ones themselves where it adds none. */
  const withTimes = (
    held: Readonly<Record<string, string>>,
    page: HistoryPage,
  ): Readonly<Record<string, string>> =>
    Object.entries(page.times).every(([id, at]) => held[id] === at)
      ? held
      : { ...held, ...page.times };

  /**
   * THE NEWEST PAGE, PUT IN PLACE OF WHAT IS HELD. After the server restarted, what this window
   * pieced together from a turn that process never finished is not the record. Where the page does
   * not reach what is held (`isApart`), nothing held can be laid beside it. And the first page of
   * all is this too: the record, and over it what the stream has brought.
   *
   * What stays with it is what the stream has brought since its newest snapshot (`brought`) — from
   * the first of those rows the page also holds, in the record's order, and after the page where
   * it holds none of them — and the words being sent, last. A row the stream brought that is older
   * than the page's own is above the page, with everything else that was: read again by scrolling
   * up, from the page's own first row. Put after the page, the first rows of a turn longer than a
   * page were drawn under its last.
   */
  const putInPlace = (page: HistoryPage, takenBefore: ReadonlySet<string>) => {
    const inPage = new Set(page.messages.map((message) => message.id));
    const stand = standing();
    const kept = state.messages.filter(
      (message) => brought.has(message.id) && !sending.has(message.id),
    );
    // Not the ones the server had answered for before this page was asked for (`takenBefore`):
    // the record held those when it was read, and where the page does not, they are above it.
    const sent = state.messages.filter(
      (message) =>
        sending.has(message.id) &&
        !takenBefore.has(message.id) &&
        !inPage.has(message.id),
    );
    const first = kept.findIndex((message) => inPage.has(message.id));
    const rows =
      first === -1
        ? [...page.messages, ...kept]
        : withPage(kept.slice(first), page);
    seqs.clear();
    oldestSeq = null;
    remember(page);
    set({
      ...state,
      messages: [...inPlace(rows, stand), ...sent],
      times: withTimes(state.times, page),
      hasOlder: page.hasOlder,
      // On a store whose first page never arrived, this page is it.
      ...(state.loaded ? {} : opened()),
    });
  };

  /**
   * THE NEWEST PAGE, LAID OVER WHAT IS HELD: what it holds that this window does not, where the
   * record has it; the record's copy of every row both hold, but for a turn in flight's and the
   * words being sent (`standing`); and the times the record stamped. Says so when the page cannot
   * be laid, because it does not reach what is held (`isApart`).
   *
   * One laying for every read of it — the one under a snapshot, the one when a turn ends in front
   * of somebody, the one when a routine delivers. They were two, and differed in whose copy stood.
   */
  const lay = (page: HistoryPage): "laid" | "apart" => {
    if (isLeftBehind(page)) return "laid";
    if (isApart(page)) return "apart";
    const stand = standing();
    remember(page);
    const messages = inPlace(withPage(state.messages, page), stand);
    const times = withTimes(state.times, page);
    // A page that says nothing new changes nothing: nobody is told.
    if (messages !== state.messages || times !== state.times) {
      set({ ...state, messages, times });
    }
    return "laid";
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
    const seen = snapshots;
    const takenBefore = new Set(taken);
    const page = await deps.readHistory(threadId, null);
    // Closed meanwhile, or another read — a refresh, a restart's — already brought the page.
    if (closed || state.loaded) return;
    if (page) {
      /*
       * The page, and over it what the stream has brought since it last said how things stand —
       * not everything held. It was everything: somebody who came back, while this page was still
       * being read, to a turn that had ended meanwhile kept the half of its answer the stream had
       * brought before, over the whole of it on the page (adversarial read, 2026-10-03).
       *
       * UNLESS THE STREAM BROKE WHILE THIS PAGE WAS BEING READ, with rows held from before the
       * break. Those are in the record by now and may not be on a page read before them: put in
       * place, it would take them off the screen. The page is read again, after the break.
       */
      const isAcrossBreak =
        seen < snapshots &&
        state.messages.some(
          (message) => !brought.has(message.id) && !sending.has(message.id),
        );
      if (isAcrossBreak) {
        if (mine === firstReads) void readFirstPage();
        return;
      }
      putInPlace(page, takenBefore);
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
   * THE NEWEST PAGE UNDER A SNAPSHOT, READ UNTIL IT IS IN — to be put in place of what is held
   * after a restart, or laid over it: a window that resumed past the frames the server still
   * keeps is sent a snapshot, not what it missed.
   *
   * SAME PROCESS, FRAMES GONE (2026-09-27 code sprint). Only a restart used to re-read the page, so
   * a window that went quiet mid-answer (a phone in a pocket) and came back after the turn's frames
   * were swept kept the half it had streamed — under a turn the snapshot said was done.
   *
   * It was read once. A snapshot does not hold what a routine delivered, nor a turn that ended
   * while nobody was looking: a store somebody came back to on the one request that failed went
   * without them for the rest of the visit, where the store it replaced — made again on every
   * visit — read its first page until it was in (review, fourth round). So this one is read again
   * on the same waits as that page, and the newest snapshot's read is the only one that waits.
   *
   * A restart that is still owed its page is not forgotten for a later snapshot of the same
   * process: what was pieced together before it is not the record, whichever read brings the page.
   */
  let snapshotReads = 0;
  let snapshotReadsOut = 0;
  let snapshotRetryMs = RETRY_FIRST_MS;
  let callOffSnapshotRead: (() => void) | null = null;
  let isResyncOwed = false;
  /** Whoever waits for the page under a snapshot to be in (`refresh`), told when one is. */
  const landings = new Set<() => void>();
  const tellLanded = () => {
    const waiting = [...landings];
    landings.clear();
    for (const tell of waiting) tell();
  };
  const readUnder = async (kind: "resync" | "catchUp"): Promise<void> => {
    if (kind === "resync") isResyncOwed = true;
    snapshotReads += 1;
    const mine = snapshotReads;
    callOffSnapshotRead?.();
    callOffSnapshotRead = null;
    const seen = snapshots;
    const takenBefore = new Set(taken);
    snapshotReadsOut += 1;
    const page = await deps.readHistory(threadId, null);
    snapshotReadsOut -= 1;
    if (closed) return;
    if (page) {
      // An older read answering late is as good as the newest: the page is the newest either way.
      if (mine === snapshotReads) snapshotRetryMs = RETRY_FIRST_MS;
      /*
       * BUT NOT ALWAYS TO BE PUT IN PLACE OF WHAT IS HELD. A page read before the newest snapshot
       * was read across a break: put in place, it takes with it what the stream brought before
       * that snapshot and the record wrote after the read — a restart's page, where the read began
       * before the restart. And a page that ends before one already in (`isOutrun`) takes that
       * one's newest rows with it. Such a page is only laid. A restart stays owed until a page read
       * under the newest snapshot, and no older than what is held, settles it — and where nothing
       * is on its way to do that, the page is read again.
       */
      const mayReplace = seen === snapshots && !isOutrun(page);
      if (isResyncOwed && mayReplace) {
        isResyncOwed = false;
        putInPlace(page, takenBefore);
      } else if (lay(page) === "apart" && mayReplace) {
        putInPlace(page, takenBefore);
      }
      if (
        isResyncOwed &&
        snapshotReadsOut === 0 &&
        callOffSnapshotRead === null
      ) {
        void readUnder("resync");
      }
      tellLanded();
      return;
    }
    // A newer read is out, or was: what happens next is its answer's to say — and where it has
    // already said it, nothing more is due, which whoever waits on that must hear.
    if (mine !== snapshotReads) {
      tellLanded();
      return;
    }
    const wait = snapshotRetryMs;
    snapshotRetryMs = Math.min(snapshotRetryMs * 2, RETRY_MOST_MS);
    callOffSnapshotRead = later(() => {
      callOffSnapshotRead = null;
      void readUnder(kind);
    }, wait);
  };
  /** The stream has been asked how the turn stands, or the page under its answer is still to come. */
  const isSnapshotReadDue = (): boolean =>
    isResuming || snapshotReadsOut > 0 || callOffSnapshotRead !== null;
  /** Until that page is in, or the conversation is closed. */
  const untilLanded = async (): Promise<void> => {
    while (!closed && isSnapshotReadDue()) {
      await new Promise<void>((resolve) => {
        landings.add(resolve);
      });
    }
  };

  /** The stream opened again without a cursor, and the epoch unknown until it answers (`resume`). */
  const askAgain = () => {
    if (closed || !watch) return;
    isResuming = true;
    if (state.epoch !== null) {
      epochBefore = state.epoch;
      set({ ...state, epoch: null });
    }
    watch.nudge();
    if (!state.loaded && state.unreadable) void readFirstPage();
  };

  /**
   * THE NEWEST PAGE READ AND LAID, FOR `refresh` — read until it is in, as every other read of it.
   *
   * AFTER THE PAGE UNDER A SNAPSHOT, NOT BESIDE IT. The screen asks for this when the turn it was
   * watching is over, and for somebody who left mid-turn that is the snapshot saying so: two reads
   * of one page, out together, and this one landing first laid it before the snapshot's read could
   * say it did not reach what was held.
   *
   * AND NOT INSTEAD OF IT. Standing aside for that read lost what this one was asked for: a routine
   * delivered while the snapshot's read was out, that read came back without the delivery, and
   * nothing read again — while the caller marked the conversation read (adversarial read,
   * 2026-10-03). So this waits for that page to be in, and then reads.
   *
   * IT WAS READ ONCE. A read that failed left the delivery it was asked for undrawn until the next
   * turn ended, in a conversation open on the screen.
   */
  let refreshing: Promise<void> | null = null;
  let isRefreshOwed = false;
  /** Its read has gone out: asked for again from here on, the page is read once more after it. */
  let isRefreshReadOut = false;
  let refreshRetryMs = RETRY_FIRST_MS;
  /** Ends the wait before the page is read again: its time has come, or the conversation closed. */
  let endRefreshWait: (() => void) | null = null;
  const readAndLay = async (): Promise<void> => {
    for (;;) {
      await untilLanded();
      if (closed) return;
      isRefreshReadOut = true;
      const page = await deps.readHistory(threadId, null);
      if (closed) return;
      if (page) {
        refreshRetryMs = RETRY_FIRST_MS;
        // A snapshot arrived while this was out: its read went out after this one, and brings more.
        if (isSnapshotReadDue()) {
          await untilLanded();
          return;
        }
        /*
         * A page that does not reach what is held is not laid by this (`isApart`), nor put in place
         * of it: what may stay over a page put in place is told from a snapshot (`brought`), so the
         * stream is asked for one, as when somebody comes back, and the read under it does that.
         */
        if (lay(page) === "apart") {
          askAgain();
          await untilLanded();
        }
        return;
      }
      // The next read is still to go out: whoever asks meanwhile is answered by it.
      isRefreshReadOut = false;
      const wait = refreshRetryMs;
      refreshRetryMs = Math.min(refreshRetryMs * 2, RETRY_MOST_MS);
      await new Promise<void>((resolve) => {
        const callOffWait = later(() => {
          endRefreshWait = null;
          resolve();
        }, wait);
        endRefreshWait = () => {
          callOffWait();
          endRefreshWait = null;
          resolve();
        };
      });
    }
  };

  /**
   * WHAT THE STREAM ADDS GOES BEFORE THE WORDS THIS WINDOW IS STILL SENDING. A row the stream
   * brings is the server's, and the words are not the server's yet: whatever turn takes them comes
   * after it. Added at the end, another window's question — heard late, after a stream that had
   * gone quiet came back — was drawn under what this person typed after it was asked.
   */
  const beforeSending = (messages: readonly Message[]): readonly Message[] => {
    if (sending.size === 0) return messages;
    const first = messages.findIndex((message) => sending.has(message.id));
    if (first === -1) return messages;
    const tail = messages.slice(first);
    if (tail.every((message) => sending.has(message.id))) return messages;
    return [
      ...messages.slice(0, first),
      ...tail.filter((message) => !sending.has(message.id)),
      ...tail.filter((message) => sending.has(message.id)),
    ];
  };

  const onFrame = (frame: TurnFrame) => {
    // The epoch a resuming store had is the one a restart is told against.
    const known = state.epoch ?? epochBefore;
    const restarted =
      frame.kind === "snapshot" && known !== null && frame.epoch !== known;
    /*
     * A SNAPSHOT TO A STORE THE STREAM HAS SPOKEN TO BEFORE is the stream starting over — somebody
     * came back, or the server no longer keeps the frames this window had got to — and the page is
     * read under it whatever the cursor was. It used to take a cursor past nought: a conversation
     * no turn has touched since the server started has no frames at all, a routine's delivery is
     * not one, and every conversation is such a one after a deploy.
     */
    const resumed =
      frame.kind === "snapshot" &&
      !restarted &&
      state.loaded &&
      (known !== null || state.seq > 0 || isResuming);
    const turnBefore = state.turn?.id;
    if (frame.kind === "snapshot") {
      isResuming = false;
      epochBefore = null;
      snapshots += 1;
      brought.clear();
      live.clear();
      // The stream has started over, past whatever turn took these: it will not place them now,
      // and they stay where they stand — above what it brings from here on.
      for (const id of [...taken]) placed(id);
    }
    const before = state.messages;
    const applied = applyFrame(state, frame);
    const isGoing = isTurnGoing(applied.turn);
    // A turn that is over, or another one beginning: nothing more is written to what was live.
    if (!isGoing || applied.turn?.id !== turnBefore) live.clear();
    // What this frame brought is the stream's: the server has it, and it is nothing a page put in
    // place of what is held may take along.
    const was =
      frame.kind === "snapshot"
        ? null
        : new Map(before.map((message) => [message.id, message]));
    const news =
      frame.kind === "snapshot"
        ? frame.messages
        : applied.messages === before
          ? []
          : applied.messages.filter(
              (message) => was?.get(message.id) !== message,
            );
    for (const message of news) {
      brought.add(message.id);
      placed(message.id);
      if (isGoing) live.add(message.id);
    }
    // And what a turn was asked is the server's from the moment it says so — the stream's, while
    // that turn is in flight, though the row itself may come a frame later.
    if (frame.kind === "snapshot" || frame.kind === "turn") {
      for (const id of frame.turn?.asked ?? []) {
        placed(id);
        if (!isGoing) continue;
        brought.add(id);
        live.add(id);
      }
    }
    set({ ...state, ...applied, messages: beforeSending(applied.messages) });
    if (restarted) void readUnder("resync");
    else if (resumed) void readUnder("catchUp");
    // Nothing is read under this one: whoever waited for a snapshot's page waits no longer.
    else if (frame.kind === "snapshot") tellLanded();
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
      closed = false;
      retryMs = RETRY_FIRST_MS;
      /*
       * OPENED AGAIN AFTER A CLOSE, what it holds is from an earlier look: a screen handed back the
       * store it had (`holdThread`), and nothing woke its stream in between. It used to pick up
       * where it left off — its old epoch, its old cursor, its old idle turn — which is the trust
       * `resume` exists to take back. So it is a coming back: the stream is asked afresh, without a
       * cursor, and the page is read under its answer.
       */
      if (state !== EMPTY) {
        isResuming = true;
        if (state.epoch !== null) {
          epochBefore = state.epoch;
          set({ ...state, epoch: null });
        }
      }
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
     * The newest page read again and laid over what is held (`lay`): something other than a turn
     * wrote to the conversation — a routine delivering its answer at seven in the morning while the
     * conversation sits open on a desk — or a turn ended, and the record has the whole of it.
     * Resolves once a page read after the call is in.
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
      /*
       * One at a time. Asked for again while one is waiting to read, that read is this one's too;
       * asked for after it has gone out, the page is read once more behind it — what this call
       * is for may have been written since.
       */
      if (refreshing) {
        if (isRefreshReadOut) isRefreshOwed = true;
        await refreshing;
        return;
      }
      refreshing = (async () => {
        do {
          isRefreshOwed = false;
          isRefreshReadOut = false;
          await readAndLay();
        } while (isRefreshOwed && !closed);
        isRefreshReadOut = false;
        refreshing = null;
      })();
      await refreshing;
    },

    /** The page above what is held, for a person scrolling up. */
    async loadOlder(): Promise<void> {
      if (!state.hasOlder || state.loadingOlder || oldestSeq === null) return;
      set({ ...state, loadingOlder: true });
      const above = oldestSeq;
      const page = await deps.readHistory(threadId, above);
      /*
       * Unreadable — or the page above rows that are no longer here. What is held was put in place
       * again while this was out (`resync`), or let go from the top (`letGo`): laid over it, this
       * page sat above a stretch nobody holds, and the next one was asked for from above that.
       */
      if (!page || oldestSeq !== above) {
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

    /**
     * The server answered for these: it has them (`taken`). The stream says the same when it
     * brings them — but a stream that has gone quiet says nothing.
     */
    sent(ids: readonly string[]): void {
      for (const id of ids) {
        if (sending.has(id)) taken.add(id);
      }
    },

    /** Messages that never reached the server, taken back off the screen. */
    removeLocal(ids: readonly string[]): void {
      const gone = new Set(ids);
      for (const id of gone) placed(id);
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
     * the stream to have spoken waits. Under the snapshot the newest page is read and laid (`lay`):
     * what something other than a turn wrote meanwhile, the whole of what the stream brought in
     * part, and the times the record stamped.
     */
    resume(): void {
      askAgain();
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
      callOffSnapshotRead?.();
      callOffSnapshotRead = null;
      watch?.close();
      watch = null;
      listeners.clear();
      frameListeners.clear();
      // Nobody waits on a page that will not be read.
      tellLanded();
      endRefreshWait?.();
    },
  };
}
