/**
 * One Bot, one turn, in a room.
 *
 * The same loop a routine runs — `runUnattended` — with a different note at the top, a way to
 * speak, and somebody watching. That it is the same loop is the point: policy, grants, approvals,
 * the audit row, the step budget, the deadline and the "a stream that stopped is a failure" rule
 * are all one implementation, so a Bot in a room is governed exactly as a Bot on a schedule is.
 *
 * What this file adds is only what a room needs: the member is told where it is (`roomConduct`),
 * asked for its turn (`roomTurnPrompt`), given `send_message`, and its messages are posted AS IT
 * SENDS THEM rather than at the end — so a member's first sentence reaches the room while it is
 * still deciding whether to add a second.
 */
import type { AbstractAgent, Message } from "@ag-ui/client";
import type { RunLedger } from "../runner/run-ledger";
import { runUnattended, type UnattendedToolkit } from "../runner/unattended";
import {
  roomConduct,
  roomTurnPrompt,
  type RoomLine,
  type RoomMember,
} from "./prompt";
import { roomToolkit } from "./send-message";
import { watchRoomSpeech } from "./stream";

export type MemberTurnResult = {
  /** How many messages this member put in the room. Zero is silence, and is a normal outcome. */
  spoke: number;
  /** Why it could not take its turn at all, if it could not. */
  failed: string | null;
};

export type MemberTurnInput = {
  room: { channelId: string; name: string; description?: string };
  member: RoomMember;
  peers: readonly RoomMember[];
  lines: readonly RoomLine[];
  windingDown: boolean;
  /** The tail of this Bot's private conversation with the person. See `private-history.ts`. */
  history?: Message[];
  /** The Bot itself, resolved for the person whose room it is. Null when it can no longer answer. */
  agent: AbstractAgent | null;
  toolkit: UnattendedToolkit;
  /** Put a message in the room. Given the call's id so the settled copy can replace the bubble. */
  deliver: (text: string, toolCallId: string) => Promise<void>;
  /** Report what the member is typing, before it has finished. */
  watch: {
    open: (toolCallId: string) => void;
    text: (toolCallId: string, text: string) => void;
    close: (toolCallId: string) => void;
  };
  timeoutMs: number;
  ledger?: RunLedger;
  userId: string;
};

export async function runMemberTurn(
  input: MemberTurnInput,
): Promise<MemberTurnResult> {
  /*
   * A Bot absent from the resolved map is skipped, not an error. The room still lists it — a
   * member missing from the header is a room that lies about who is in it — and the turn goes on
   * without it. A Bot that was soft-DELETED is not this case: the runtime resolves it to an
   * `UnavailableAgent` whose run throws, so it reaches the `catch` below with a ledger row opened
   * and closed against it every round. That is honest — the ledger records that the room tried —
   * but it is a cost worth knowing about, and the place to stop paying it is `resolveRoomMembers`.
   */
  if (!input.agent) {
    return { spoke: 0, failed: "This Bot is no longer available." };
  }

  const toolkit = roomToolkit(input.toolkit, input.deliver);
  const runId = await input.ledger
    ?.begin({
      agentId: input.member.id,
      userId: input.userId,
      origin: "room",
      label: input.room.name,
    })
    .catch(() => null);

  let failed: string | null = null;
  try {
    await runUnattended(input.agent, roomTurnPrompt(input), {
      toolkit,
      timeoutMs: input.timeoutMs,
      preamble: roomConduct(input.member),
      ...(input.history ? { history: input.history } : {}),
      watch: watchRoomSpeech(input.watch),
    });
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error);
  } finally {
    if (runId) {
      await input.ledger?.finish(runId, failed).catch(() => {});
    }
  }

  /*
   * The run's `answer` is deliberately thrown away. In a room, prose is scratch space — what the
   * member said is what it sent, and that has already been posted. A failure that happened AFTER
   * the member spoke is still a failure worth recording, but it does not unsay anything.
   */
  return { spoke: toolkit.spoken(), failed };
}
