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
  /** `posted` false: refused, and the provisional message should come off the screen. */
  | (Base & { kind: "room.end"; messageId: string; posted: boolean })
  | (Base & { kind: "room.done"; reason: string });

export function isRoomFrame(value: unknown): value is RoomFrame {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return (
    typeof kind === "string" &&
    (ROOM_FRAME_KINDS as readonly string[]).includes(kind)
  );
}
