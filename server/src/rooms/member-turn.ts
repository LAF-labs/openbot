/**
 * One Bot, one turn, in a room.
 *
 * The same loop a routine runs — `runUnattended` — in a different mode, with a way to speak and
 * somebody watching. That it is the same loop is the point: policy, grants, approvals, the audit
 * row, the step budget, the deadline and the "a stream that stopped is a failure" rule are all one
 * implementation, so a Bot in a room is governed exactly as a Bot on a schedule is.
 *
 * What this file adds is only what a room needs: the member is told where it is (the prompt
 * composer's room mode), asked for its turn (`roomTurnPrompt`), given `send_message`, and its
 * messages are posted AS IT SENDS THEM rather than at the end — so a member's first sentence
 * reaches the room while it is still deciding whether to add a second.
 */
import type { AbstractAgent, Message } from "@ag-ui/client";
import {
  classifyTurnFailure,
  TURN_FAILURE_CODES,
} from "../channels/turn-failures";
import { log } from "../log";
import type { RunLedger } from "../runner/run-ledger";
import {
  isRunDeadline,
  runUnattended,
  type UnattendedToolkit,
} from "../runner/unattended";
import type { MemberOutcome } from "./outcomes";
import {
  roomTurnPrompt,
  type RoomLine,
  type RoomMember,
  type SpeakReason,
} from "./prompt";
import { roomToolkit, SEND_MESSAGE } from "./send-message";
import { watchRoomSpeech } from "./stream";

export type MemberTurnResult = {
  /** How many messages this member put in the room. Zero is silence, and is a normal outcome. */
  spoke: number;
  /** Why it could not take its turn at all, if it could not. */
  failed: string | null;
  /** A person stopped it mid-turn (`모두 멈추기`). Not a failure: `failed` stays null. */
  stopped?: boolean;
  /**
   * The same three facts as one kind, which is what the room shows and keeps: silence and failure
   * were the same zero in `spoke`, and to the person a Bot that chose not to answer looked like a
   * Bot that was not in the room. See `outcomes.ts`.
   */
  outcome: MemberOutcome;
};

/**
 * One asking of one member, reduced to its kind.
 *
 * WORDS FIRST. A member that spoke and then failed — its stream cut after the message was delivered
 * — is a member whose words are in the room, and "could not answer" under its own answer would be a
 * false thing to say. The failure is still on the trail and in the ledger; it does not unsay anything.
 *
 * A timeout is told apart from every other failure by the classifier the transcript's own failure
 * line uses, so "ran out of time" means the same thing in both places: the member deadline's
 * sentence and agent-bot's `laf:model_timed_out` alike.
 */
export function outcomeOf(result: {
  spoke: number;
  failed: string | null;
  stopped?: boolean;
}): MemberOutcome {
  if (result.spoke > 0) return "spoke";
  if (result.stopped) return "stopped";
  if (result.failed !== null) {
    return classifyTurnFailure(result.failed) === TURN_FAILURE_CODES.timedOut
      ? "timed_out"
      : "failed";
  }
  return "passed";
}

export type MemberTurnInput = {
  room: { channelId: string; name: string; description?: string };
  /**
   * The room's thread, so the ledger row this turn opens belongs to the conversation.
   *
   * It did not: `begin` was called with no thread, so a member's failed turn was a run in the
   * ledger that no conversation could claim, and `GET /api/channels/:id/failures` — which joins
   * the ledger to the thread — had nothing to show for a room. See `channels/turn-failures.ts`.
   */
  threadId: string;
  /**
   * The id the caller minted for this run, so the messages the member delivers can carry it.
   *
   * Minted by the caller rather than here because `deliver` writes rows before this function
   * returns, and the row has to name the run that wrote it. The ledger accepts a caller's id.
   */
  runId: string;
  member: RoomMember;
  peers: readonly RoomMember[];
  lines: readonly RoomLine[];
  windingDown: boolean;
  /**
   * Why this member is being asked, and who by — the same facts the audit row records.
   *
   * They used to stop at the audit row. The Bot was handed two dozen lines and left to work out
   * which of them was for it, which is what a member pulled in by a colleague's question did
   * instead of answering the question: greeted, agreed, and summarised. See `roomTurnPrompt`.
   */
  reason: SpeakReason;
  /** The colleague that called it in, BY NAME rather than by id — the prompt says it out loud. */
  namedBy?: string;
  /** How many members answer this same round, this one included. See `MemberAsk`. */
  answeringNow: number;
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
  /**
   * A person's stop for the whole turn (`모두 멈추기`), handed to the loop so it cuts this member
   * mid-thought and abandons a browser action on its way out, exactly as the deadline does.
   */
  signal?: AbortSignal;
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
    return {
      spoke: 0,
      failed: "This Bot is no longer available.",
      outcome: "failed",
    };
  }

  /*
   * WHAT THE MEMBER HAD FINISHED WRITING, AND WHAT HAS GONE OUT. A `send_message` is written by the
   * model and then run by the loop, and the deadline can fall between the two: the call is whole,
   * its words have been on the person's screen as the member typed them, and the clock runs out
   * before the loop gets to it — or while an earlier call in the same step is still running. The
   * deadline then threw, and the sweep in `service.ts` took the finished message off the screen.
   * Hermes keeps such a reply (`harvestStrandedGroupReply`); so does this, in the `catch` below.
   */
  const written = new Map<string, string>();
  const sent = new Set<string>();
  const toolkit = roomToolkit(input.toolkit, (text, toolCallId) => {
    // Marked before the append, not after: an append the deadline walked away from is still
    // landing, and delivering the same call a second time would say it twice.
    sent.add(toolCallId);
    return input.deliver(text, toolCallId);
  });
  const watch = {
    open: input.watch.open,
    text: input.watch.text,
    close: (toolCallId: string, text?: string) => {
      if (text !== undefined) written.set(toolCallId, text);
      input.watch.close(toolCallId);
    },
  };
  const runId = await input.ledger
    ?.begin({
      runId: input.runId,
      threadId: input.threadId,
      agentId: input.member.id,
      userId: input.userId,
      origin: "room",
      label: input.room.name,
    })
    .catch(() => null);

  let failed: string | null = null;
  let stopped = false;
  try {
    await runUnattended(input.agent, roomTurnPrompt(input), {
      toolkit,
      timeoutMs: input.timeoutMs,
      // How a room works is said by the prompt composer, from `shared/prompt/mode/room.ko.ts`.
      // This only says where the run is; `roomTurnPrompt` still ends the request with the turn.
      mode: "room",
      ...(input.history ? { history: input.history } : {}),
      watch: watchRoomSpeech(watch),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    // The signal, not the error's shape, says whether a person asked for this: see `routines/run.ts`.
    if (input.signal?.aborted) stopped = true;
    else {
      failed = error instanceof Error ? error.message : String(error);
      /*
       * ONLY THE CLOCK, AND ONLY WHOLE MESSAGES. A person's stop is a person saying "not now", and
       * a model whose stream failed has no finished call that the loop would not already have run.
       * Through the toolkit rather than around it, so the member's message limit still holds.
       */
      if (isRunDeadline(error)) {
        for (const [toolCallId, text] of written) {
          if (sent.has(toolCallId)) continue;
          try {
            await toolkit.execute(SEND_MESSAGE, { text }, { id: toolCallId });
          } catch (late) {
            log.error("room_late_reply_lost", {
              member: input.member.id,
              reason: late,
            });
          }
        }
      }
    }
  } finally {
    if (runId) {
      await (stopped
        ? input.ledger?.settle(runId, { status: "stopped", error: null })
        : input.ledger?.finish(runId, failed)
      )?.catch(() => {});
    }
  }

  /*
   * The run's `answer` is deliberately thrown away. In a room, prose is scratch space — what the
   * member said is what it sent, and that has already been posted. A failure that happened AFTER
   * the member spoke is still a failure worth recording, but it does not unsay anything.
   */
  const spoke = toolkit.spoken();
  return {
    spoke,
    failed,
    ...(stopped ? { stopped } : {}),
    outcome: outcomeOf({ spoke, failed, stopped }),
  };
}
