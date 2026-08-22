import type { Message } from "@ag-ui/core";
import type { RoomFrame } from "./room-frames";

/**
 * What a room looks like on screen, and how one frame changes it.
 *
 * Pure, so the whole set of rules can be tested without a socket or a component. The rules exist
 * because the frames arrive over a connection that drops, duplicates nothing but may replay, and
 * carries turns that are already over:
 *
 * A FRAME FROM A STALE TURN IS IGNORED. The person said something else; whatever the old turn's
 * members were typing is answering a question that has been superseded.
 *
 * A PROVISIONAL MESSAGE IS SWAPPED FOR ITS SETTLED COPY IN PLACE. While a member types, the
 * message is keyed by the tool call; when it lands, `room.end{posted:true}` names that id and
 * carries the stored id and final text, and the bubble is re-keyed where it stands. Removing it
 * and waiting for catch-up — which is what this did first — blinked every reply off the screen for
 * the second or two between stream end and the settled fetch.
 *
 * A DELTA FOR A MESSAGE NOBODY OPENED OPENS IT. The open frame can be the one that was dropped,
 * and a message whose first frame was lost should still appear rather than never.
 *
 * A FRAME FOR ANOTHER ROOM RETURNS THE SAME STATE OBJECT, so React renders nothing.
 */

export type RoomMessage = Message & {
  /** Set while the member is still typing. Cleared by `room.end`. */
  streaming?: boolean;
  /**
   * Set on the person's own message between showing it and the server confirming it.
   *
   * The room accepts a message with 202 AFTER writing it, so once the request has answered the
   * message is stored and catch-up will find it. Before that it exists only here, and a catch-up
   * landing in that window — a late frame from the previous turn is enough — would fetch a thread
   * that does not contain it yet and take the person's own words off the screen.
   */
  pending?: boolean;
};

/** A question one member is waiting on. Answered by approval id, like the line-level card. */
export type RoomApproval = {
  approvalId: string;
  memberId: string;
  memberName: string;
  question: string;
  rule: string;
};

export type RoomState = {
  messages: readonly RoomMessage[];
  /**
   * The questions members are waiting on. Not cleared by `room.done`: the server holds a question
   * for ten minutes and the person answers on their own time; `withoutApproval` takes one down.
   */
  approvals: readonly RoomApproval[];
  /** Message id → Bot id, for the name above a reply. */
  speakers: Readonly<Record<string, string>>;
  /** Message id → ISO-8601, for the time separators. */
  times: Readonly<Record<string, string>>;
  /** The turn in flight, or null when nobody is speaking. */
  turnId: string | null;
  epoch: number;
};

export const EMPTY_ROOM: RoomState = {
  messages: [],
  approvals: [],
  speakers: {},
  times: {},
  turnId: null,
  epoch: 0,
};

export function applyRoomFrame(
  state: RoomState,
  frame: RoomFrame,
  channelId: string,
): RoomState {
  if (frame.channelId !== channelId) return state;

  if (frame.kind === "room.turn") {
    /*
     * A NEW TURN TAKES THE OLD ONE'S HALF-DRAWN MESSAGES WITH IT. The person said something else,
     * so whatever a member was part-way through saying is never going to finish — its own
     * `room.end` belongs to the superseded turn and is dropped as stale. Left alone, the fragment
     * sat on screen until the next turn happened to end.
     */
    return {
      ...state,
      messages: state.messages.filter((message) => !message.streaming),
      turnId: frame.turnId,
      epoch: frame.epoch,
    };
  }

  // A question is not typing. It stands whatever turn it was raised in, until it is answered or
  // the server lets it expire, so it is not subject to the staleness rule below.
  if (frame.kind === "room.approval") {
    // The wait ended in an answer. The tab that pressed the button took its own card down; this is
    // for every other tab looking at the same room.
    if (frame.answered) return withoutApproval(state, frame.approvalId);
    if (state.approvals.some((a) => a.approvalId === frame.approvalId)) {
      return state;
    }
    const { memberId, memberName, approvalId, question, rule } = frame;
    return {
      ...state,
      approvals: [
        ...state.approvals,
        { memberId, memberName, approvalId, question, rule },
      ],
    };
  }

  // Anything from a turn older than the one we know about is a member answering a superseded
  // question. A turn newer than ours is one we missed the start of — adopt it rather than drop it.
  if (frame.epoch < state.epoch) return state;
  /*
   * A NEWER EPOCH TAKES THE OLD TURN'S HALF-DRAWN MESSAGES WITH IT. The person said something else,
   * so whatever a member was part-way through saying is never going to finish — its own `room.end`
   * belongs to the superseded turn and is dropped as stale. Left alone, the fragment sat on screen
   * until the NEXT turn happened to end.
   */
  const adopted =
    frame.epoch > state.epoch
      ? {
          ...state,
          messages: state.messages.filter((message) => !message.streaming),
          turnId: frame.turnId,
          epoch: frame.epoch,
        }
      : state.turnId === null
        ? { ...state, turnId: frame.turnId, epoch: frame.epoch }
        : state;

  switch (frame.kind) {
    case "room.open": {
      // An id already on screen — a replayed frame, or a settled message with the same id — is
      // left alone: re-opening it would wipe text the person has already read.
      if (adopted.messages.some((message) => message.id === frame.messageId)) {
        return adopted;
      }
      return {
        ...adopted,
        messages: [
          ...adopted.messages,
          {
            id: frame.messageId,
            role: "assistant",
            content: "",
            streaming: true,
          },
        ],
        speakers: { ...adopted.speakers, [frame.messageId]: frame.authorId },
      };
    }

    case "room.delta": {
      const at = adopted.messages.findIndex(
        (message) => message.id === frame.messageId,
      );
      if (at === -1) {
        return {
          ...adopted,
          messages: [
            ...adopted.messages,
            {
              id: frame.messageId,
              role: "assistant",
              content: frame.text,
              streaming: true,
            },
          ],
        };
      }
      const current = adopted.messages[at];
      if (!current || current.content === frame.text) return adopted;
      const messages = adopted.messages.slice();
      // A provisional message is always ours and always an assistant's; rebuilt rather than spread,
      // because spreading over AG-UI's message union lets the type pick any member of it.
      messages[at] = {
        id: current.id,
        role: "assistant",
        content: frame.text,
        streaming: true,
      };
      return { ...adopted, messages };
    }

    case "room.end": {
      const at = adopted.messages.findIndex(
        (message) => message.id === frame.messageId,
      );
      const { [frame.messageId]: author, ...rest } = adopted.speakers;

      if (!frame.posted || !frame.storedId) {
        // Refused, or never delivered: the words are not in the room and must not stay on screen.
        if (at === -1) return adopted;
        const messages = adopted.messages.filter((_, index) => index !== at);
        return { ...adopted, messages, speakers: rest };
      }

      // Settled. Already holding the stored copy (catch-up got there first) means nothing to do
      // beyond dropping the provisional one, if it is still there.
      const storedAt = adopted.messages.findIndex(
        (message) => message.id === frame.storedId,
      );
      const provisional = adopted.messages[at];
      const settled: RoomMessage = {
        id: frame.storedId,
        role: "assistant",
        content:
          frame.text ??
          (typeof provisional?.content === "string" ? provisional.content : ""),
      };
      const messages = adopted.messages.filter(
        (_, index) => index !== at && index !== storedAt,
      );
      const insertAt =
        at === -1 ? messages.length : Math.min(at, messages.length);
      messages.splice(insertAt, 0, settled);
      const speakers = author ? { ...rest, [frame.storedId]: author } : rest;
      const times = frame.at
        ? { ...adopted.times, [frame.storedId]: frame.at }
        : adopted.times;
      return { ...adopted, messages, speakers, times };
    }

    case "room.done": {
      // By here the frame's epoch equals ours (older returned early, newer was adopted), so there
      // is nothing left to check: the turn this frame ends is the one on screen.
      const messages = adopted.messages.filter((message) => !message.streaming);
      return { ...adopted, messages, turnId: null };
    }
  }
}

/**
 * The connection was away, so whatever it missed is gone — including, possibly, the end of the turn.
 *
 * A turn is only ever ended by a `room.done` frame, and frames are not replayed. A socket that drops
 * during a turn therefore leaves the room believing a turn is still running forever: the composer
 * stays disabled and Stop stays showing, and nothing the person does brings it back. So a reconnect
 * lets the turn go. If one really is still running, its very next frame says so and the room adopts
 * it again — the frames carry the turn and the epoch, which is exactly what makes that safe.
 *
 * The questions are left alone: those are not carried by frames alone, and the catch-up that runs
 * beside this reads them from the server.
 */
export function turnLost(state: RoomState): RoomState {
  if (state.turnId === null && !state.messages.some((m) => m.streaming)) {
    return state;
  }
  return {
    ...state,
    messages: state.messages.filter((message) => !message.streaming),
    turnId: null,
  };
}

/**
 * Reconcile the questions on screen with the ones the server says are open.
 *
 * The frames are how a question ARRIVES, and they only reach a mounted room on the instance running
 * the turn. Everything else — opening the room after a member had already stopped at a boundary,
 * reloading the tab, a question raised on another server behind the load balancer — has no frame to
 * carry it, and before this the person saw nothing while the member waited.
 *
 * Authoritative in both directions: a question the server no longer lists has expired or been
 * answered somewhere else, and its card comes down. So the caller must pass the WHOLE open set, and
 * must not call at all if it could not read part of it.
 */
export function mergeApprovals(
  state: RoomState,
  open: readonly RoomApproval[],
): RoomState {
  const wanted = new Map(
    open.map((approval) => [approval.approvalId, approval]),
  );
  const kept = state.approvals.filter((approval) =>
    wanted.has(approval.approvalId),
  );
  const known = new Set(kept.map((approval) => approval.approvalId));
  const added = open.filter((approval) => !known.has(approval.approvalId));
  if (added.length === 0 && kept.length === state.approvals.length) {
    return state;
  }
  return { ...state, approvals: [...kept, ...added] };
}

/** The question was answered (or dismissed); its card comes down. */
export function withoutApproval(
  state: RoomState,
  approvalId: string,
): RoomState {
  if (!state.approvals.some((a) => a.approvalId === approvalId)) return state;
  return {
    ...state,
    approvals: state.approvals.filter((a) => a.approvalId !== approvalId),
  };
}

/**
 * Fold stored messages into the state without losing what is still being typed.
 *
 * The catch-up fetch returns the thread as the server holds it; provisional messages are not in it
 * and must survive the merge, and a stored message already on screen keeps its identity so the
 * transcript's memo does not redraw it.
 */
export function mergeStored(
  state: RoomState,
  stored: readonly Message[],
  marks: { speakers: Record<string, string>; times: Record<string, string> },
): RoomState {
  const known = new Map(state.messages.map((message) => [message.id, message]));
  const merged: RoomMessage[] = stored.map(
    (message) => known.get(message.id) ?? message,
  );
  for (const message of state.messages) {
    // Still being typed, or not yet acknowledged: either way the server does not have it to return.
    const local = message.streaming || message.pending;
    if (local && !merged.some((m) => m.id === message.id)) {
      merged.push(message);
    }
  }
  return {
    ...state,
    messages: merged,
    speakers: { ...state.speakers, ...marks.speakers },
    times: { ...state.times, ...marks.times },
  };
}
