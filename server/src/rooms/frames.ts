/**
 * What the browser is told while a room turn is running.
 *
 * These ride the socket the roster already keeps open, alongside `ChannelActivityEvent`. `kind` is
 * the discriminator that event deliberately does not have, which is what lets an old bundle survive
 * a deploy: it looks a frame up by `channelId`, finds the row, spreads unknown keys onto it and
 * touches nothing it draws.
 *
 * DELTAS DO NOT GO THROUGH `pg_notify`. That carrier caps a payload at 8000 bytes and costs a
 * round trip through the database for every keystroke-sized event; the settled message already goes
 * that way, because it must reach a second process. Deltas are instance-local by design — a person
 * whose tab is connected to another instance sees the message when it lands rather than as it is
 * typed, which is the same thing they see today.
 *
 * EVERY `text` IS THE WHOLE MESSAGE SO FAR, never an increment. A dropped frame heals on the next
 * one, a reconnecting tab is right as soon as one arrives, and the browser needs no reassembly.
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
  /** Who may receive it. Resolved by the writer, exactly as the activity event does. */
  memberIds: string[];
  turnId: string;
  /** The room's turn counter this frame belongs to. A frame from an older one is ignored. */
  epoch: number;
};

export type RoomFrame =
  /** A turn has started, and this is who was asked. */
  | (Base & {
      kind: "room.turn";
      members: Array<{ id: string; name: string }>;
    })
  /** A member has started saying something. The text may still be empty. */
  | (Base & {
      kind: "room.open";
      messageId: string;
      authorId: string;
      authorName: string;
    })
  /** Everything that member has said in this message so far. */
  | (Base & { kind: "room.delta"; messageId: string; text: string })
  /**
   * The message settled (`posted` true: swap the provisional bubble for the stored copy, in place)
   * or was refused — over its message limit, or empty — and should come off the screen.
   */
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
   *
   * `answered` true is the same frame arriving to take the card down, the way `room.end` carries
   * `posted`. It is sent when the WAIT ended in an answer, which is what a second tab needs: the tab
   * that pressed the button already took its own card down. A wait that timed out sends nothing,
   * because the question is still open and answering it late still counts.
   */
  | (Base & {
      kind: "room.approval";
      memberId: string;
      memberName: string;
      approvalId: string;
      question: string;
      rule: string;
      answered?: boolean;
    })
  /**
   * The whole turn is over, however it ended.
   *
   * `failures` is how many members could not take their turn at all — a dead provider, a Bot that
   * was deleted, a run that timed out. Without it a turn where everybody failed is delivered as a
   * turn where nobody had anything to say, which is the same screen and a completely different fact.
   */
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
