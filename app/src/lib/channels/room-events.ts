import type { Message } from "@ag-ui/core";
import {
  type AllowanceScope,
  type AskSubject,
  allowanceScopeOf,
  askSubjectOf,
} from "@/lib/approvals";
import { type CallPreview, callPreviewOf } from "@/lib/call-preview";
import type { RoomFrame } from "./room-frames";
import {
  type Heard,
  heardFromList,
  heardOf,
  memberOutcomeOf,
  settleOutcome,
} from "./room-receipts";

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
  /** What it is about, in facts. The card writes the Korean; see `lib/approvals.ts`. */
  subject: AskSubject | undefined;
  /** What an outward call will send, already checked. See `lib/call-preview.ts`. */
  preview?: CallPreview;
  rule: string;
  /** When it stops being answerable, for the countdown on the card. Empty when unknown. */
  expiresAt: string;
  /** What "always" would cover, or absent when only this once is on offer. See lib/approvals.ts. */
  scope?: AllowanceScope;
  /** Present when "for this conversation" — this room — is on offer. See lib/approvals.ts. */
  threadId?: string;
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
  /**
   * The member that has the floor: asked, and not finished. Null between turns.
   *
   * One at a time, because the turn asks one at a time. Cleared by `room.done` and by a reconnect,
   * both of which mean this tab no longer knows whether anybody is still working.
   */
  asked: { id: string; name: string } | null;
  epoch: number;
  /**
   * The person's message to how each member's part in the turn it started came out — the room's
   * read receipts. From the thread's marks on load and from `room.done` as each turn ends. See
   * `room-receipts.ts`.
   */
  receipts: Readonly<Record<string, Heard>>;
  /**
   * The turn in flight, member by member: who has been asked so far, and how the ones that finished
   * came out (`room.settled`). What lets a quiet member's face settle into the receipt the moment it
   * is done rather than when the whole turn is. Emptied when a turn starts and when one ends.
   */
  turnAsked: readonly string[];
  turnSettled: Heard;
};

export const EMPTY_ROOM: RoomState = {
  messages: [],
  approvals: [],
  speakers: {},
  times: {},
  turnId: null,
  asked: null,
  epoch: 0,
  receipts: {},
  turnAsked: [],
  turnSettled: {},
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
      // Nobody has been asked yet in the turn that is starting.
      asked: null,
      turnAsked: [],
      turnSettled: {},
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
    const { memberId, memberName, approvalId, rule } = frame;
    // Validated rather than spread through: the frame arrives over a socket, and neither a scope nor
    // a subject this surface cannot vouch for should reach a card — one would be a button whose
    // words it had to guess at, the other a sentence about an action nobody described.
    const scope = allowanceScopeOf(frame.scope);
    const preview = callPreviewOf(frame.preview);
    return {
      ...state,
      approvals: [
        ...state.approvals,
        {
          memberId,
          memberName,
          approvalId,
          subject: askSubjectOf(frame.subject),
          ...(preview ? { preview } : {}),
          rule,
          ...(scope ? { scope } : {}),
          ...(typeof frame.threadId === "string" && frame.threadId
            ? { threadId: frame.threadId }
            : {}),
          expiresAt: typeof frame.expiresAt === "string" ? frame.expiresAt : "",
        },
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
          // Whoever the old turn had asked belongs to a question nobody is answering any more.
          turnAsked: [],
          turnSettled: {},
        }
      : state.turnId === null
        ? { ...state, turnId: frame.turnId, epoch: frame.epoch }
        : state;

  switch (frame.kind) {
    case "room.asked": {
      if (adopted.asked?.id === frame.memberId) return adopted;
      return {
        ...adopted,
        asked: { id: frame.memberId, name: frame.memberName },
        turnAsked: adopted.turnAsked.includes(frame.memberId)
          ? adopted.turnAsked
          : [...adopted.turnAsked, frame.memberId],
      };
    }

    case "room.settled": {
      /*
       * THE FLOOR IS GIVEN UP HERE, NOT WHEN THE NEXT MEMBER IS ASKED. The working line and the
       * receipt are one face in two places: clearing `asked` in the same state change that puts the
       * member in the receipt is what lets the face travel from one to the other rather than
       * blinking out of one and, a moment later, into the other.
       */
      const asked = adopted.asked?.id === frame.memberId ? null : adopted.asked;
      const outcome = memberOutcomeOf(frame.outcome);
      if (!outcome)
        return asked === adopted.asked ? adopted : { ...adopted, asked };
      return {
        ...adopted,
        asked,
        turnAsked: adopted.turnAsked.includes(frame.memberId)
          ? adopted.turnAsked
          : [...adopted.turnAsked, frame.memberId],
        turnSettled: {
          ...adopted.turnSettled,
          [frame.memberId]: settleOutcome(
            adopted.turnSettled[frame.memberId],
            outcome,
          ),
        },
      };
    }

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
      /*
       * The turn's receipt, as the server summarised it, onto the question it answered — merged
       * member by member, because asking one colleague again hears from that colleague alone and
       * the others' receipts still stand.
       */
      const heard = heardFromList(frame.members);
      const receipts =
        frame.questionId && Object.keys(heard).length > 0
          ? {
              ...adopted.receipts,
              [frame.questionId]: {
                ...adopted.receipts[frame.questionId],
                ...heard,
              },
            }
          : adopted.receipts;
      return {
        ...adopted,
        messages,
        turnId: null,
        asked: null,
        receipts,
        turnAsked: [],
        turnSettled: {},
      };
    }
  }
}

/**
 * The member to say is working, or null when saying so would be telling the reader what they can
 * already see.
 *
 * A MEMBER MID-SENTENCE NEEDS NO LINE. Once its words are arriving, the bubble itself is the
 * evidence; a "thinking" line under a reply that is visibly being written claims the room has
 * stalled. So this answers only for the stretch between being asked and the first word — which is
 * the stretch that used to be blank, and which is as long as that Bot takes to read the room, wait
 * for its lane and do whatever work it decided to do first.
 *
 * Separate from the reducer and exported so it can be asserted: what a frame does to the screen is
 * decided in this file, not in a component.
 */
export function memberWorking(
  state: RoomState,
): { id: string; name: string } | null {
  if (state.turnId === null || state.asked === null) return null;
  const writing = state.messages.some(
    (message) =>
      message.streaming &&
      typeof message.content === "string" &&
      message.content.length > 0,
  );
  return writing ? null : state.asked;
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
  if (
    state.turnId === null &&
    state.asked === null &&
    state.turnAsked.length === 0 &&
    !state.messages.some((m) => m.streaming)
  ) {
    return state;
  }
  return {
    ...state,
    messages: state.messages.filter((message) => !message.streaming),
    turnId: null,
    // Whoever had the floor may have finished while the socket was away; claiming otherwise would
    // leave a member "working" on screen for as long as the room stays open.
    asked: null,
    // And how the turn came out is the stored receipt's to say now, which the catch-up beside this
    // reads; a half-heard turn held here would stand in front of it.
    turnAsked: [],
    turnSettled: {},
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
  marks: {
    speakers: Record<string, string>;
    times: Record<string, string>;
    /** Question id to member id to outcome, as the server kept them. See `room-receipts.ts`. */
    receipts?: Readonly<Record<string, unknown>>;
  },
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
  /*
   * WHAT THIS TAB HEARD WINS, member by member. A catch-up that set off before a turn ended can land
   * after its `room.done`, carrying the receipt as it stood before — and letting it win would take
   * the turn's outcome back off the screen until the next read. The stored copy fills in the rest:
   * everything that happened before this tab opened.
   */
  const receipts: Record<string, Heard> = { ...state.receipts };
  for (const [questionId, stored] of Object.entries(marks.receipts ?? {})) {
    receipts[questionId] = {
      ...heardOf(stored),
      ...state.receipts[questionId],
    };
  }
  return {
    ...state,
    messages: merged,
    speakers: { ...state.speakers, ...marks.speakers },
    times: { ...state.times, ...marks.times },
    receipts,
  };
}
