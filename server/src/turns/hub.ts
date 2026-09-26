/**
 * What a conversation's turn has done so far, for every window watching it.
 *
 * The turn runs on the server (`engine.ts`); windows only subscribe. Each conversation keeps a
 * numbered log of what its turn in flight has produced — AG-UI events, framed as ONE run however
 * many times the model is asked, plus the turn's own comings and goings — and a window names the
 * last number it saw to be handed what it missed. Two cursors, as Muse keeps them: the durable one
 * is the thread store's `seq` (history, `history.ts`); this is the live one, for the turn in flight.
 *
 * A NUMBER MEANS NOTHING TO ANOTHER PROCESS, so every frame is read against the process's epoch: a
 * window whose cursor came from a process that has since died is sent a snapshot, never a replay.
 * A cursor older than what is still held gets the same — the turn's messages as they stand, taken
 * from the live copy in the same tick — so a window is never handed the middle of a message whose
 * start it did not see.
 *
 * In memory by decision (`docs/laf/deployment-model.md`): one process per VM, and what this holds is
 * a turn in flight, which a restart ends honestly at boot rather than resumes.
 */
import { randomUUID } from "node:crypto";
import type { BaseEvent, Message } from "@ag-ui/client";

export type TurnStatus = "queued" | "running" | "done" | "error" | "stopped";

export type TurnState = {
  /** The run ledger's id for the turn. */
  id: string;
  status: TurnStatus;
  /** The person's messages that asked for it. */
  asked: string[];
  /** Why it ended, as a fact code, for an ending that is not `done`. */
  code?: string;
};

export type TurnFrame =
  | { seq: number; kind: "turn"; turn: TurnState }
  | { seq: number; kind: "event"; turn: string; event: BaseEvent }
  /** The server's own copies of messages the turn has written, which replace the window's by id. */
  | { seq: number; kind: "messages"; turn: string; messages: Message[] }
  /** Cards in the conversation waiting on a person's choice. */
  | { seq: number; kind: "waiting"; turn: string; toolCallIds: string[] };

/** What a window joining (or rejoining past what is held) is handed before the live frames. */
export type TurnSnapshot = {
  kind: "snapshot";
  epoch: string;
  seq: number;
  turn: TurnState | null;
  /** The turn's messages so far: what the person asked, and what the Bot has said and done. */
  messages: Message[];
  waiting: string[];
};

export type TurnListener = (frame: TurnFrame) => void;

type Conversation = {
  seq: number;
  frames: TurnFrame[];
  /** The oldest seq still held; a cursor before it gets a snapshot. */
  floor: number;
  turn: TurnState | null;
  /** The turn's messages as the server-side agent holds them right now. */
  live: (() => Message[]) | null;
  waiting: string[];
  listeners: Set<TurnListener>;
  /** Clears a finished turn's frames once late windows have had their chance. */
  sweep: ReturnType<typeof setTimeout> | null;
};

/** A long browsing turn streams thousands of deltas; past this, the oldest go and a join snapshots. */
const MAX_FRAMES = 4_000;

/** How long a finished turn's frames stay for a window that reconnects to read how it ended. */
const KEEP_ENDED_MS = 120_000;

export function createTurnHub(options: { keepEndedMs?: number } = {}) {
  const epoch = randomUUID();
  const conversations = new Map<string, Conversation>();
  const keepEndedMs = options.keepEndedMs ?? KEEP_ENDED_MS;
  /*
   * ONE COUNTER FOR THE PROCESS, NOT ONE PER CONVERSATION. A conversation's log is let go of once
   * its turn has ended and nobody watches; numbered from zero again when it came back, a phone
   * returning with `epoch:57` was replayed frames 58 onward of a different turn as though they
   * followed what it held (review M3). Numbers never run backwards in one process, so a cursor
   * from before the let-go is always older than what is held, and gets a snapshot.
   */
  let counter = 0;

  const conversation = (threadId: string): Conversation => {
    let found = conversations.get(threadId);
    if (!found) {
      found = {
        seq: counter,
        frames: [],
        floor: counter + 1,
        turn: null,
        live: null,
        waiting: [],
        listeners: new Set(),
        sweep: null,
      };
      conversations.set(threadId, found);
    }
    return found;
  };

  /** Numbered, held and handed to everybody watching, in that order. */
  const publish = (
    threadId: string,
    frame: DistributiveOmit<TurnFrame, "seq">,
  ): void => {
    const at = conversation(threadId);
    counter += 1;
    at.seq = counter;
    const numbered = { ...frame, seq: at.seq } as TurnFrame;
    at.frames.push(numbered);
    if (at.frames.length > MAX_FRAMES) {
      at.frames.splice(0, at.frames.length - MAX_FRAMES);
      at.floor = at.frames[0]?.seq ?? at.seq + 1;
    }
    for (const listener of at.listeners) {
      try {
        listener(numbered);
      } catch {
        // One window's broken socket is not the turn's problem, nor another window's.
      }
    }
  };

  const snapshotOf = (threadId: string): TurnSnapshot => {
    const at = conversation(threadId);
    return {
      kind: "snapshot",
      epoch,
      seq: at.seq,
      turn: at.turn,
      messages: at.live ? [...at.live()] : [],
      waiting: [...at.waiting],
    };
  };

  return {
    epoch,

    /** A turn was accepted, started, or ended. */
    turn(threadId: string, turn: TurnState): void {
      const at = conversation(threadId);
      if (at.sweep) {
        clearTimeout(at.sweep);
        at.sweep = null;
      }
      const starting = at.turn?.id !== turn.id;
      if (starting) {
        // A new turn starts a new log: nothing of the last one is replayed into it.
        at.frames = [];
        at.floor = at.seq + 1;
        at.waiting = [];
        at.live = null;
      }
      at.turn = turn;
      publish(threadId, { kind: "turn", turn });
      if (turn.status !== "queued" && turn.status !== "running") {
        at.live = null;
        at.waiting = [];
        at.sweep = setTimeout(() => {
          const now = conversations.get(threadId);
          if (!now || now.turn?.id !== turn.id) return;
          if (now.listeners.size > 0) {
            // Watched still: keep the ending, drop the rest.
            now.frames = now.frames.filter((frame) => frame.kind === "turn");
            now.floor = now.frames[0]?.seq ?? now.seq + 1;
            return;
          }
          conversations.delete(threadId);
        }, keepEndedMs);
        at.sweep.unref?.();
      }
    },

    /** Where the turn's messages can be read from while it runs. */
    watchLive(threadId: string, live: () => Message[]): void {
      conversation(threadId).live = live;
    },

    event(threadId: string, turnId: string, event: BaseEvent): void {
      publish(threadId, { kind: "event", turn: turnId, event });
    },

    messages(threadId: string, turnId: string, messages: Message[]): void {
      if (messages.length === 0) return;
      publish(threadId, { kind: "messages", turn: turnId, messages });
    },

    waiting(threadId: string, turnId: string, toolCallIds: string[]): void {
      const at = conversation(threadId);
      at.waiting = [...toolCallIds];
      publish(threadId, { kind: "waiting", turn: turnId, toolCallIds });
    },

    /** How the conversation's turn stands, for a window that asks rather than watches. */
    state(threadId: string): { turn: TurnState | null; seq: number } {
      const at = conversations.get(threadId);
      return { turn: at?.turn ?? null, seq: at?.seq ?? 0 };
    },

    /**
     * Watch a conversation from a cursor: the frames after it when they are all still held and the
     * cursor is this process's, a snapshot otherwise — then everything live. Returns the way to
     * stop watching.
     */
    subscribe(
      threadId: string,
      from: { epoch: string | null; after: number | null },
      listener: (frame: TurnFrame | TurnSnapshot) => void,
    ): () => void {
      const at = conversation(threadId);
      const resumable =
        from.epoch === epoch &&
        from.after !== null &&
        from.after >= at.floor - 1 &&
        from.after <= at.seq;
      if (resumable) {
        for (const frame of at.frames) {
          if (frame.seq > (from.after ?? 0)) listener(frame);
        }
      } else {
        listener(snapshotOf(threadId));
      }
      at.listeners.add(listener);
      return () => {
        at.listeners.delete(listener);
      };
    },

    /** How many windows are watching a conversation right now. */
    watchers(threadId: string): number {
      return conversations.get(threadId)?.listeners.size ?? 0;
    },
  };
}

export type TurnHub = ReturnType<typeof createTurnHub>;

/** `Omit` over each member of a union rather than over the union's common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
