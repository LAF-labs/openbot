import type { Message } from "@ag-ui/core";
import { createTurnHub } from "../../../server/src/turns/hub";
import type { HistoryPage } from "../../src/lib/turns/client";
import type { TurnFrame } from "../../src/lib/turns/frames";
import { createThreadStore } from "../../src/lib/turns/thread-store";

/**
 * ONE CONVERSATION'S STORE, DRIVEN BY EVERYTHING THAT CAN HAPPEN TO IT, IN ANY ORDER.
 *
 * The real store (`lib/turns/thread-store.ts`) against the real hub (`server/src/turns/hub.ts`),
 * with a small engine between them that does what `engine.ts` does to a conversation: starts a
 * turn, streams an answer, writes the record at the end of a step, ends the turn — and beside it
 * the things that are not turns: a routine delivering, another window asking, the server
 * restarting. The window's side: frames delivered a few at a time or not at all, reads answered
 * late, as they were asked or as the record now stands, or not at all; a stream that dies without
 * saying so; coming back, coming online, scrolling up, typing.
 *
 * A seed picks the order. What must hold whatever the order:
 *
 *  - nothing held is rolled back, and no row the record has leaves the store but from the top —
 *    where a page was put in place of what was held, and the rest is read by scrolling up;
 *  - while the stream is whole, the store's copy of the turn in flight is the server's;
 *  - and once everything has settled: the newest page of the record is held, as the record has
 *    it, in the record's order, once each, with nothing missing between the rows held, and the
 *    store saying there is more above wherever there is.
 *
 * Six rounds of review found one interleaving each. This is where the seventh is looked for
 * (adversarial read of the kept conversation, 2026-10-03: the model found eleven).
 *
 * WHAT IT DOES NOT DO, BECAUSE NOTHING DOES. The store lays what the stream brought beside a page
 * by the rows the two share, and a page read under a snapshot shares one with the turn that
 * snapshot brought unless a page of rows was written after the turn's newest in the meantime:
 * between the snapshot being taken and the window hearing it, while the page was being read, and
 * by something other than the turn while it ran. None of the three is long — a frame on its way,
 * one request that is given up on after `HISTORY_WAIT_MS`, a routine that needs the Bot the turn
 * is holding — so each is kept under a third of a page here (`share`), which with pages of six
 * rows is one row, and with the pages a window reads is more than a run of this writes.
 */

type Row = { id: string; role: "user" | "assistant"; content: string };

export type ModelOptions = {
  /** Rows to a page. Small, and a page is outrun in a handful of steps. */
  limit: number;
  /** A turn that is over has its frames swept while the window is away. */
  sweeps: boolean;
  restarts: boolean;
  failReads: boolean;
  /** How the window is brought back before the end is checked: as a return, or as a reconnect. */
  heal: "nudge" | "resume";
  firstPageFails: boolean;
  /** A stream that died silently may still be listed by the server for a while. */
  zombies: boolean;
  /** The first page is in before anything else happens. */
  promptFirstPage: boolean;
  /** Refresh as the screen does: on a routine's delivery while no turn goes, and when a turn ends. */
  realRefresh: boolean;
};

const BASE: ModelOptions = {
  limit: 1000,
  sweeps: false,
  restarts: false,
  failReads: false,
  heal: "resume",
  firstPageFails: false,
  zombies: false,
  promptFirstPage: false,
  realRefresh: false,
};
const LOADED: ModelOptions = { ...BASE, promptFirstPage: true };
const REAL: ModelOptions = { ...LOADED, realRefresh: true, heal: "nudge" };

/** The ways the model is run: each a mix of what may happen. */
export const MODEL_CONFIGS: Record<string, ModelOptions> = {
  "a first page still out": BASE,
  "a first page still out, reconnecting": { ...BASE, heal: "nudge" },
  "a first page that fails": {
    ...BASE,
    firstPageFails: true,
    failReads: true,
  },
  "reads that fail": { ...BASE, failReads: true },
  "the server restarting": { ...BASE, restarts: true, failReads: true },
  "frames swept, and streams that linger": {
    ...BASE,
    sweeps: true,
    zombies: true,
  },
  "a conversation that is in": LOADED,
  "a conversation that is in, reconnecting": { ...LOADED, heal: "nudge" },
  "in, with reads that fail": { ...LOADED, failReads: true, heal: "nudge" },
  "in, with the server restarting": {
    ...LOADED,
    restarts: true,
    failReads: true,
  },
  "in, with frames swept": {
    ...LOADED,
    sweeps: true,
    zombies: true,
    heal: "nudge",
  },
  "pages of six rows": { ...LOADED, limit: 6 },
  "pages of six rows, with reads that fail": {
    ...LOADED,
    limit: 6,
    failReads: true,
  },
  "as the screen refreshes": REAL,
  "as the screen refreshes, with reads that fail": { ...REAL, failReads: true },
  "as the screen refreshes, pages of six rows": { ...REAL, limit: 6 },
  "as the screen refreshes, pages of six rows, coming back": {
    ...REAL,
    limit: 6,
    heal: "resume",
  },
  "as the screen refreshes, with the server restarting": {
    ...REAL,
    restarts: true,
  },
};

/** The same order for the same seed, on every machine. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Everything queued behind a promise that has settled gets to run. */
async function flush() {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}

type Read = {
  resolve: (page: HistoryPage | null) => void;
  before: number | null;
  /** The page as the record stood when the read went out. */
  asRequested: HistoryPage;
  /** How many rows the record had been given by then. */
  writtenBefore: number;
};

type Stream = {
  /** Which server process it was opened to. */
  process: number;
  queue: { id: string; frame: TurnFrame }[];
  isDead: boolean;
  unsubscribe: (() => void) | null;
  lastId: string | null;
  /** How many rows the record had been given when it was opened. */
  writtenBefore: number;
};

export async function runModel(
  seed: number,
  steps: number,
  options: ModelOptions,
): Promise<{ problems: string[]; trace: string[] }> {
  const random = seeded(seed);
  const pick = (below: number) => Math.floor(random() * below);
  const trace: string[] = [];
  const say = (line: string) => trace.push(line);
  const problems: string[] = [];
  const THREAD = "thread-1";
  let made = 0;
  const newId = (prefix: string) => {
    made += 1;
    return `${prefix}${made}`;
  };

  // ---------------- the server: a record, a hub, and the turn in flight
  let hub = createTurnHub({ keepEndedMs: 0 });
  let process = 0;
  const record: { seq: number; row: Row }[] = [];
  let nextSeq = 1;
  const persist = (row: Row) => {
    const at = record.findIndex((entry) => entry.row.id === row.id);
    if (at === -1) {
      record.push({ seq: nextSeq, row: { ...row } });
      nextSeq += 1;
    } else {
      record[at] = { seq: record[at]?.seq ?? 0, row: { ...row } };
    }
  };
  const seqOf = () => new Map(record.map((entry) => [entry.row.id, entry.seq]));
  /** A third of a page: how much is written in any of the short whiles the header names. */
  const share = Math.floor((options.limit - 1) / 3);
  type Turn = { id: string; asked: string[]; live: Row[]; writing: Row | null };
  // Asserted, not annotated: what is set from inside a closure is not narrowed away at its uses.
  let turn = null as Turn | null;
  let turnsStarted = 0;
  /** What a routine has delivered while the turn in flight has been running. */
  let deliveredInTurn = 0;
  const pageOf = (before: number | null): HistoryPage => {
    const rows = record.filter(
      (entry) => before === null || entry.seq < before,
    );
    const page = rows.slice(Math.max(0, rows.length - options.limit));
    return {
      messages: page.map((entry) => ({ ...entry.row }) as Message),
      times: Object.fromEntries(
        page.map((entry) => [entry.row.id, `t${entry.seq}`]),
      ),
      seqs: Object.fromEntries(page.map((entry) => [entry.row.id, entry.seq])),
      oldestSeq: page[0]?.seq ?? null,
      newestSeq: page.at(-1)?.seq ?? null,
      hasOlder: rows.length > page.length,
    };
  };
  /** What the hub is handed: its own types are the server's, and the rows are plain. */
  const wire = <T>(rows: Row[]) => rows.map((row) => ({ ...row })) as T;
  let onActivity = null as (() => void) | null;
  const startTurn = (asked: Row[]) => {
    for (const row of asked) persist(row);
    turnsStarted += 1;
    deliveredInTurn = 0;
    const mine: Turn = {
      id: newId("t"),
      asked: asked.map((row) => row.id),
      live: asked.map((row) => ({ ...row })),
      writing: null,
    };
    turn = mine;
    hub.turn(THREAD, { id: mine.id, status: "queued", asked: mine.asked });
    hub.watchLive(THREAD, () => wire(mine.live));
    hub.messages(THREAD, mine.id, wire(asked));
    hub.turn(THREAD, { id: mine.id, status: "running", asked: mine.asked });
  };
  const writeMore = () => {
    if (!turn) return;
    if (!turn.writing) {
      turn.writing = { id: newId("a"), role: "assistant", content: "" };
      turn.live.push(turn.writing);
      hub.event(THREAD, turn.id, {
        type: "TEXT_MESSAGE_START",
        messageId: turn.writing.id,
        role: "assistant",
      } as Parameters<typeof hub.event>[2]);
    }
    made += 1;
    const delta = `<${made}>`;
    turn.writing.content += delta;
    hub.event(THREAD, turn.id, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: turn.writing.id,
      delta,
    } as Parameters<typeof hub.event>[2]);
  };
  const endStep = () => {
    if (!turn?.writing) return;
    hub.messages(
      THREAD,
      turn.id,
      wire(turn.live.filter((row) => row.role === "assistant")),
    );
    for (const row of turn.live) persist(row);
    turn.writing = null;
  };
  const endTurn = () => {
    if (!turn) return;
    hub.messages(THREAD, turn.id, wire(turn.live));
    for (const row of turn.live) persist(row);
    hub.event(THREAD, turn.id, { type: "RUN_FINISHED" } as Parameters<
      typeof hub.event
    >[2]);
    hub.turn(THREAD, { id: turn.id, status: "done", asked: turn.asked });
    const hasSaid = turn.live.some((row) => row.role === "assistant");
    turn = null;
    // The engine tells every open tab what the Bot said: the roster's news of it.
    if (hasSaid) onActivity?.();
  };

  // ---------------- the wire between them
  let handlers: {
    cursor: () => string | null;
    onFrame: (frame: TurnFrame) => void;
  } | null = null;
  let stream = null as Stream | null;
  const cursorOf = (raw: string | null) => {
    if (!raw) return { epoch: null, after: null };
    const at = raw.lastIndexOf(":");
    return { epoch: raw.slice(0, at), after: Number(raw.slice(at + 1)) };
  };
  const connect = (cursor: string | null) => {
    if (stream?.unsubscribe) {
      // A stream that died silently may still be listed by the server for a while.
      if (!(stream.isDead && options.zombies && random() < 0.5)) {
        stream.unsubscribe();
      }
    }
    const opened: Stream = {
      process,
      queue: [],
      isDead: false,
      unsubscribe: null,
      lastId: cursor,
      writtenBefore: nextSeq,
    };
    const to = hub;
    opened.unsubscribe = to.subscribe(THREAD, cursorOf(cursor), (frame) => {
      opened.queue.push({
        id: `${to.epoch}:${frame.seq}`,
        frame: structuredClone(frame) as unknown as TurnFrame,
      });
    });
    stream = opened;
  };
  const deliver = (most: number) => {
    if (!stream || stream.isDead || !handlers) return 0;
    let delivered = 0;
    while (delivered < most) {
      const next = stream.queue.shift();
      if (!next) break;
      stream.lastId = next.id;
      handlers.onFrame(next.frame);
      delivered += 1;
    }
    return delivered;
  };
  const restart = (isFlushed: boolean) => {
    if (turn && isFlushed) for (const row of turn.live) persist(row);
    turn = null;
    hub = createTurnHub({ keepEndedMs: 0 });
    process += 1;
    if (stream) {
      stream.isDead = true;
      stream.unsubscribe = null;
    }
  };

  // ---------------- the window
  const reads: Read[] = [];
  const timers: { run: () => void; isCancelled: boolean; hasFired: boolean }[] =
    [];
  let hasFirstReadAnswered = false;
  const store = createThreadStore(THREAD, {
    readHistory: (_thread, before) =>
      new Promise((resolve) => {
        reads.push({
          resolve,
          before,
          asRequested: pageOf(before),
          writtenBefore: nextSeq,
        });
      }),
    watchTurn: (_thread, given) => {
      handlers = given;
      connect(given.cursor());
      return { close: () => {}, nudge: () => connect(given.cursor()) };
    },
    later: (run) => {
      const timer = { run, isCancelled: false, hasFired: false };
      timers.push(timer);
      return () => {
        timer.isCancelled = true;
      };
    },
  });
  const held = () => store.snapshot().messages as unknown as Row[];
  const drawn = () =>
    held()
      .map((row) => `${row.id}=${String(row.content).length}`)
      .join(" ");
  const sends: Row[] = [];
  const typedAt = new Map<string, number>();

  // A few rows to begin with.
  for (let old = 0; old < 3; old += 1) {
    persist({ id: newId("h"), role: "user", content: `old${old}` });
  }
  if (options.realRefresh) {
    // A turn before anybody looked: the process's counter is past nought, as on any day but the first.
    startTurn([{ id: newId("w"), role: "user", content: "warm" }]);
    writeMore();
    endTurn();
  }
  void store.open();
  await flush();
  if (options.promptFirstPage) {
    const read = reads.shift();
    read?.resolve(pageOf(read.before));
    hasFirstReadAnswered = true;
    await flush();
    // And the stream's first word with it.
    deliver(1);
    await flush();
  }

  const isGoingInStore = () => {
    const status = store.snapshot().turn?.status;
    return status === "queued" || status === "running";
  };
  let wasGoing = false;
  /** What the screen does when the turn it was watching is over (`server-channel-chat.tsx`). */
  const onTurnEnd = () => {
    const isGoing = isGoingInStore();
    if (wasGoing && !isGoing && options.realRefresh) {
      say("  (turn ended) refresh()");
      void store.refresh();
    }
    wasGoing = isGoing;
  };
  onActivity = () => {
    if (options.realRefresh && !isGoingInStore()) {
      say("  (activity: the turn's answer) refresh()");
      void store.refresh();
    }
  };
  /**
   * What a read is answered with when the server gets to it late: the record as it is now — but
   * not past what little is written in the time one read takes (`share`). A request that waits
   * longer is one the page has given up on (`HISTORY_WAIT_MS`).
   */
  const lateAnswer = (read: Read): HistoryPage =>
    nextSeq - read.writtenBefore <= share
      ? pageOf(read.before)
      : read.asRequested;
  const answerRead = (isRead: boolean, isLate: boolean) => {
    if (reads.length === 0) return;
    const at = pick(reads.length);
    const [read] = reads.splice(at, 1);
    if (!read) return;
    const page = isRead ? (isLate ? lateAnswer(read) : read.asRequested) : null;
    say(
      `read#${at} answers ${
        page
          ? `${isLate ? "late" : "as asked"} [${page.messages.map((row) => row.id).join(",")}]`
          : "FAILED"
      }`,
    );
    read.resolve(page);
  };
  const fireTimers = () => {
    let fired = 0;
    for (const timer of timers) {
      if (timer.isCancelled || timer.hasFired) continue;
      timer.hasFired = true;
      timer.run();
      fired += 1;
    }
    return fired;
  };

  // ---------------- what must hold at every step
  const everHeld = new Set<string>();
  const lastSaid = new Map<string, string>();
  const checkNothingLost = () => {
    const snapshot = store.snapshot();
    const seqs = seqOf();
    const now = new Map(held().map((row) => [row.id, row]));
    const heldSeqs = [...now.keys()]
      .map((id) => seqs.get(id))
      .filter((seq): seq is number => seq !== undefined);
    const lowest = heldSeqs.length
      ? Math.min(...heldSeqs)
      : Number.POSITIVE_INFINITY;
    for (const id of everHeld) {
      if (!seqs.has(id) || now.has(id)) continue;
      // Let go from the top is the design: a page put in place of what was held, as on a first
      // open — the newest page, and more above. Never from the middle, never from the end.
      if ((seqs.get(id) ?? -1) < lowest) {
        if (heldSeqs.length > 0 && !snapshot.hasOlder) {
          problems.push(`row ${id} let go from the top, and hasOlder is false`);
        }
        continue;
      }
      problems.push(`record row ${id} vanished from the store`);
    }
    for (const [id, row] of now) {
      if (seqs.has(id)) everHeld.add(id);
      const truth =
        turn?.live.find((live) => live.id === id)?.content ??
        record.find((entry) => entry.row.id === id)?.row.content;
      const was = lastSaid.get(id);
      const is = String(row.content);
      // The same words as the server's, as far as each goes: no piece twice, none of another's.
      if (
        truth !== undefined &&
        !truth.startsWith(is) &&
        !is.startsWith(truth)
      ) {
        problems.push(
          `row ${id} says ${JSON.stringify(is)}, and the server ${JSON.stringify(truth)}`,
        );
      }
      if (
        truth !== undefined &&
        was !== undefined &&
        truth.startsWith(was) &&
        was.startsWith(is) &&
        is.length < was.length
      ) {
        problems.push(
          `row ${id} rolled back from ${was.length} to ${is.length}`,
        );
      }
      lastSaid.set(id, is);
    }
  };
  const checkLiveTurn = () => {
    checkNothingLost();
    const snapshot = store.snapshot();
    // Only while the stream is whole: alive, to this process, with nothing on its way.
    if (!stream || stream.isDead || stream.process !== process) return;
    if (stream.queue.length > 0 || snapshot.epoch !== hub.epoch || !turn) {
      return;
    }
    const seqs = seqOf();
    const now = new Map(held().map((row) => [row.id, row]));
    const heldSeqs = [...now.keys()]
      .map((id) => seqs.get(id))
      .filter((seq): seq is number => seq !== undefined);
    const lowest = heldSeqs.length
      ? Math.min(...heldSeqs)
      : Number.NEGATIVE_INFINITY;
    for (const live of turn.live) {
      const mine = now.get(live.id);
      // Above the page that was put in place, with the rest of what was there.
      const isAbove =
        snapshot.hasOlder &&
        (seqs.get(live.id) ?? Number.POSITIVE_INFINITY) < lowest;
      if (!mine && isAbove) continue;
      if (!mine) problems.push(`live row ${live.id} missing from the store`);
      else if (mine.content !== live.content) {
        problems.push(
          `live row ${live.id} differs: store ${JSON.stringify(mine.content)}, server ${JSON.stringify(live.content)}`,
        );
      }
    }
  };

  // ---------------- anything, in any order
  for (let step = 0; step < steps && problems.length === 0; step += 1) {
    // A snapshot reaches the window within moments of being taken: before much is written.
    if (
      stream &&
      !stream.isDead &&
      stream.queue[0]?.frame.kind === "snapshot" &&
      nextSeq - stream.writtenBefore > share
    ) {
      deliver(1);
      say(`the snapshot arrives -> [${drawn()}]`);
      await flush();
      onTurnEnd();
      await flush();
      checkLiveTurn();
      if (problems.length > 0) break;
    }
    const roll = pick(100);
    if (roll < 22) {
      const delivered = deliver(1 + pick(4));
      if (delivered) say(`deliver ${delivered} -> [${drawn()}]`);
    } else if (roll < 34) {
      if (turn) {
        writeMore();
        say("the answer goes on");
      }
    } else if (roll < 37) {
      if (turn?.writing) {
        endStep();
        say("a step ends, and is written to the record");
      }
    } else if (roll < 38) {
      /*
       * The engine writes the turn's messages when a tool answers, on a queue — and by the time
       * that write runs the next message may have begun: the record holds part of a row, under
       * the cursor it keeps, until the step's own write makes it whole (`engine.ts`, `persistNow`).
       */
      if (turn?.writing) {
        for (const row of turn.live) persist(row);
        say("the record is written mid-answer: part of a row");
      }
    } else if (roll < 44) {
      if (turn) {
        say("the turn ends");
        endTurn();
      }
    } else if (roll < 50) {
      if (!turn) {
        const row: Row = { id: newId("o"), role: "user", content: "other" };
        startTurn([row]);
        say(`another window asks ${row.id}`);
      }
    } else if (roll < 56) {
      const row: Row = { id: newId("u"), role: "user", content: "mine" };
      // What a live stream has already said is on the screen before anybody types.
      if (options.realRefresh && deliver(1000)) await flush();
      if (options.realRefresh && isGoingInStore()) continue;
      store.addLocal([row as Message], "now");
      sends.push(row);
      typedAt.set(row.id, turn ? -1 : turnsStarted);
      say(`typed ${row.id}`);
    } else if (roll < 62) {
      const row = sends.shift();
      if (row) {
        if (!turn && typedAt.get(row.id) === turnsStarted && random() < 0.8) {
          startTurn([row]);
          // The screen tells the store what the server took (`handOver`), when it hears so.
          store.sent([row.id]);
          say(`send of ${row.id} taken`);
        } else {
          store.removeLocal([row.id]);
          say(`send of ${row.id} refused`);
        }
      }
    } else if (roll < 66) {
      /*
       * Few of them while one turn is in flight (`share`). A routine needs the Bot, and a turn
       * holds it but for the minutes it may wait on a person (`PERSON_WAIT_MS`): nothing writes a
       * page of rows under a turn's question while the turn runs. Where something did, a page
       * that holds nothing of the turn could not tell the store its question is above it.
       */
      if (!turn || deliveredInTurn < share) {
        const row: Row = {
          id: newId("r"),
          role: "assistant",
          content: "routine",
        };
        persist(row);
        if (turn) deliveredInTurn += 1;
        say(`a routine delivers ${row.id}`);
        if (options.realRefresh && !isGoingInStore()) {
          say("  (activity) refresh()");
          void store.refresh();
        }
      }
    } else if (roll < 78) {
      if (!hasFirstReadAnswered && options.firstPageFails && random() < 0.7) {
        answerRead(false, false);
      } else {
        answerRead(!(options.failReads && random() < 0.3), random() < 0.5);
      }
      hasFirstReadAnswered = true;
    } else if (roll < 82) {
      const timer = timers.find(
        (waiting) => !waiting.isCancelled && !waiting.hasFired,
      );
      if (timer) {
        timer.hasFired = true;
        say("a wait runs out");
        timer.run();
      }
    } else if (roll < 85) {
      if (stream && !stream.isDead) {
        stream.isDead = true;
        say("the stream dies silently");
      }
    } else if (roll < 88) {
      if (stream?.isDead || random() < 0.3) {
        say(`the stream reconnects from ${stream?.lastId ?? "nothing"}`);
        connect(stream?.lastId ?? null);
      }
    } else if (roll < 91) {
      say("nudge()");
      store.nudge();
    } else if (roll < 95) {
      say("resume()");
      store.resume();
    } else if (roll < 97) {
      if (!options.realRefresh) {
        say("refresh()");
        void store.refresh();
      }
    } else if (roll < 98 && options.limit < 100 && random() < 0.5) {
      say("loadOlder()");
      void store.loadOlder();
    } else if (roll < 98) {
      if (options.restarts) {
        const isFlushed = random() < 0.5;
        say(
          `THE SERVER RESTARTS (${isFlushed ? "having written" : "without writing"} the turn)`,
        );
        restart(isFlushed);
      }
    } else if (options.sweeps) {
      say("the sweep's time passes");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await flush();
    onTurnEnd();
    await flush();
    checkLiveTurn();
  }
  if (problems.length > 0) return { problems, trace };

  // ---------------- everything settles
  say(`--- settling (loaded=${store.snapshot().loaded})`);
  if (turn) endTurn();
  for (const row of sends.splice(0)) store.removeLocal([row.id]);
  // A stream that is alive delivers what it has; only a dead one is opened again.
  deliver(1000);
  await flush();
  onTurnEnd();
  await flush();
  if (options.heal === "resume") store.resume();
  else if (!stream || stream.isDead || stream.process !== process)
    store.nudge();
  /** Every read answered with the record, every wait run out, every frame delivered. */
  const settle = async (isOver: () => boolean) => {
    for (let round = 0; round < 200 && !isOver(); round += 1) {
      await flush();
      let hasMoved = deliver(1000) > 0;
      for (let read = reads.shift(); read; read = reads.shift()) {
        read.resolve(lateAnswer(read));
        hasMoved = true;
        await flush();
      }
      if (fireTimers() > 0) hasMoved = true;
      await flush();
      onTurnEnd();
      await flush();
      checkNothingLost();
      if (!hasMoved && reads.length === 0) return;
    }
  };
  await settle(() => false);
  if (!options.realRefresh) {
    // What a mounted screen does when the turn ends in front of it — and it is read until it is in.
    let isDone = false;
    void store.refresh().then(() => {
      isDone = true;
    });
    await flush();
    await settle(() => isDone);
    await flush();
    if (!isDone) problems.push("the refresh never resolved");
  }

  // ---------------- what must hold in the end
  const snapshot = store.snapshot();
  const seqs = seqOf();
  const now = new Map(held().map((row) => [row.id, row]));
  for (const row of pageOf(null).messages as unknown as Row[]) {
    const mine = now.get(row.id);
    if (!mine) problems.push(`record row ${row.id} is missing from the store`);
    else if (mine.content !== row.content) {
      problems.push(
        `row ${row.id} differs: store ${JSON.stringify(mine.content)}, record ${JSON.stringify(row.content)}`,
      );
    }
  }
  let last = -1;
  const seen = new Set<string>();
  for (const row of held()) {
    const seq = seqs.get(row.id);
    if (seq === undefined) {
      problems.push(`store row ${row.id} is not in the record`);
      continue;
    }
    if (seq < last) problems.push(`store row ${row.id} is out of order`);
    last = Math.max(last, seq);
    if (seen.has(row.id)) problems.push(`row ${row.id} is held twice`);
    seen.add(row.id);
  }
  // What is held of the record is one stretch of it: nothing missing between its ends.
  const heldSeqs = held()
    .map((row) => seqs.get(row.id))
    .filter((seq): seq is number => seq !== undefined);
  if (heldSeqs.length > 0) {
    const lowest = Math.min(...heldSeqs);
    const highest = Math.max(...heldSeqs);
    const has = new Set(heldSeqs);
    const missing = record.find(
      (entry) =>
        entry.seq > lowest && entry.seq < highest && !has.has(entry.seq),
    );
    if (missing) {
      problems.push(
        `a hole: record row ${missing.row.id} is between held rows`,
      );
    }
    // And what is above can be asked for: the store says so.
    if (record.some((entry) => entry.seq < lowest) && !snapshot.hasOlder) {
      problems.push("rows above what is held, and hasOlder is false");
    }
  }
  if (snapshot.epoch === null) problems.push("the epoch is still unknown");
  if (!snapshot.loaded) problems.push("the first page never came in");
  if (problems.length > 0) {
    say(`store:  [${drawn()}]`);
    say(
      `record: [${record.map((entry) => `${entry.row.id}=${entry.row.content.length}`).join(" ")}]`,
    );
  }
  store.close();
  return { problems, trace };
}
