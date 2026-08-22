/**
 * What the browser is told while a room turn runs, as the server sends it.
 *
 * Declared here AND in `server/src/rooms/frames.ts`, on purpose. The app's tsconfig includes only
 * `src`, `agent-bot` imports `shared/` but is not a workspace the typecheck compiles, and a type
 * that quietly resolved across that boundary today would break the first time somebody tightened
 * the include. One test asserts the two kind lists are equal by value, which is the drift check.
 *
 * `kind` is the discriminator the roster's activity event does not have. An old bundle across a
 * deploy looks a frame up by `channelId`, finds the row, spreads unknown keys onto it and touches
 * nothing it draws — which is why the activity path must keep handling frames with no `kind`.
 */

export const ROOM_FRAME_KINDS = [
  "room.turn",
  "room.open",
  "room.delta",
  "room.end",
  "room.approval",
  "room.done",
] as const;

export type RoomFrameKind = (typeof ROOM_FRAME_KINDS)[number];

type Base = {
  channelId: string;
  turnId: string;
  /** The room's turn counter this frame belongs to. A frame from an older one is ignored. */
  epoch: number;
};

export type RoomFrame =
  | (Base & { kind: "room.turn"; members: Array<{ id: string; name: string }> })
  | (Base & {
      kind: "room.open";
      messageId: string;
      authorId: string;
      authorName: string;
    })
  /** Everything that member has said in this message so far — the whole text, never a delta. */
  | (Base & { kind: "room.delta"; messageId: string; text: string })
  /** `posted` true: swap the provisional bubble for the stored copy in place. False: take it down. */
  | (Base & {
      kind: "room.end";
      messageId: string;
      posted: boolean;
      /** Present when posted: the id the message was stored under, and the final text. */
      storedId?: string;
      at?: string;
      text?: string;
    })
  /**
   * A member's action met an ask rule. In a one-to-one conversation the question is drawn on the
   * tool call's own line; a room draws no tool calls — a member's working is private — so the
   * question is raised to the room, with who asked. The answer goes the usual way, by approval id.
   */
  /** `answered` true takes the card down — for a tab other than the one that pressed the button. */
  | (Base & {
      kind: "room.approval";
      memberId: string;
      memberName: string;
      approvalId: string;
      question: string;
      rule: string;
      answered?: boolean;
    })
  /** `failures`: members that could not take their turn at all. Silence is not the same thing. */
  | (Base & {
      kind: "room.done";
      reason: string;
      failures?: number;
      /** Messages put in the room this turn. Zero with no failures is everybody choosing silence. */
      posted?: number;
    });

export function isRoomFrame(value: unknown): value is RoomFrame {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return (
    typeof kind === "string" &&
    (ROOM_FRAME_KINDS as readonly string[]).includes(kind)
  );
}
