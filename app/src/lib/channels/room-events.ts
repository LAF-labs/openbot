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
};

export type RoomState = {
  messages: readonly RoomMessage[];
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
    return { ...state, turnId: frame.turnId, epoch: frame.epoch };
  }

  // Anything from a turn older than the one we know about is a member answering a superseded
  // question. A turn newer than ours is one we missed the start of — adopt it rather than drop it.
  if (frame.epoch < state.epoch) return state;
  const adopted =
    frame.epoch > state.epoch || state.turnId === null
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
    if (message.streaming && !merged.some((m) => m.id === message.id)) {
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
