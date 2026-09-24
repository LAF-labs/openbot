/**
 * A room turn, from the message a person sends to the last thing a Bot says.
 *
 * The turn runs HERE and not in the browser, which is the whole point of the change. A tab that
 * closes mid-turn no longer kills it, two tabs cannot each drive their own version of it, and the
 * thing that decides whose turn it is has one implementation instead of one per open window.
 *
 * TWO FENCES, FOR TWO DIFFERENT RACES. The epoch column is the cross-process one: it counts up on
 * every message a person posts, and every checkpoint in the turn compares what it read at the start
 * against what is stored now, so a superseded turn stops wherever it had got to. The bot lane is
 * the in-process one: an account has a single browser, so a member's turn must not run while that
 * same Bot is doing something else with it.
 */
import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import { and, eq, sql } from "drizzle-orm";
import type { AuditStore } from "../audit";
import type { AnnounceChannelActivity } from "../channels/events";
import type { ActionActor } from "../computer/gateway";
import type { Database } from "../db/client";
import { channelMemberships, channels } from "../db/schema";
import { type BotLane, createBotLane } from "../runner/bot-lane";
import type { WorkInFlight } from "../runner/in-flight";
import type { RunLedger } from "../runner/run-ledger";
import type { UnattendedToolkit } from "../runner/unattended";
import { relayApprovals } from "./approval-relay";
import type { RoomFrame } from "./frames";
import { runMemberTurn } from "./member-turn";
import { log } from "../log";
import { namesOf, resolveRoomMembers } from "./members";
import { runRoomTurn } from "./orchestrator";
import type { MemberOutcome, MemberReceipt } from "./outcomes";
import { readPrivateHistory } from "./private-history";
import type { RoomMember } from "./prompt";
import {
  appendRoomMessage,
  readRoomLines,
  recordRoomReceipts,
} from "./transcript";
import { mentionsIn } from "./turn-taking";
import type { ApprovalWaiter } from "./wait-for-approval";

/** How long one member may take. Generous: it may open pages and read files before it answers. */
export const MEMBER_TURN_TIMEOUT_MS = 300_000;

/**
 * A room refusing a turn, as a code and a status.
 *
 * The code and never a sentence: it used to carry "Say something first." and "This room has one
 * Bot. It answers in the ordinary way." into a 400 and a 409 that the channel route passed to the
 * screen as they were. The surface owns the words (`CHANNEL_REFUSALS`,
 * app/src/lib/channels/mutations.ts); the boundary in `app.ts` reads the same two fields.
 */
export class RoomError extends Error {
  constructor(
    readonly code:
      | "laf:channel_not_found"
      | "laf:room_message_empty"
      | "laf:room_needs_two_bots",
    readonly status: 400 | 404 | 409,
  ) {
    super(code);
    this.name = "RoomError";
  }
}

export type RoomServiceOptions = {
  database: Database;
  lane: BotLane;
  ledger?: RunLedger;
  /** Fresh agents for this person, exactly as a routine resolves them. */
  resolveAgents: (actor: {
    id: string;
    role: "admin" | "user";
  }) => Promise<Record<string, AbstractAgent>>;
  /** The member's tools: the same gateway, grants, policy and audit a routine gets. */
  tools?: (botId: string, actor: ActionActor) => Promise<UnattendedToolkit>;
  /** Push a frame to whoever is watching this room. */
  emit: (frame: RoomFrame) => void;
  /**
   * Move the roster row on every member's screen, once the message that moved it has committed.
   *
   * Separate from `emit` because it is a different audience: `emit` reaches the room that is open,
   * this reaches the list of rooms in every other tab. Absent in tests. See `channels/events.ts`
   * for why the caller announces rather than the writer.
   */
  announce?: AnnounceChannelActivity;
  /**
   * Hold a member's turn while a person answers the question its action raised.
   *
   * Absent in tests and in any deployment with no computer: the member then reports that it is
   * waiting, exactly as it did before, and the question stays on screen to be answered late.
   */
  awaitApproval?: ApprovalWaiter;
  /**
   * Where each member's turn is written down: which round, why it spoke, what came of it.
   *
   * Absent in tests that are not about the trail. A row that cannot be written never fails the
   * turn — the trail is the record, the turn is the work, and losing the record must not lose the
   * work — but it is written before the next member is asked, so the rows read in the order the
   * room actually went.
   */
  auditStore?: AuditStore;
  memberTimeoutMs?: number;
  /**
   * Where a turn is listed while it runs, so `모두 멈추기` can reach it (`runner/stop-all.ts`).
   * Absent in the suites that never stop a room.
   */
  work?: WorkInFlight;
};

export type RoomTurnStart = {
  turnId: string;
  messageId: string;
  epoch: number;
  /** Resolves when the turn is over. Only a test waits on it. */
  finished: Promise<void>;
};

export function createRoomService(options: RoomServiceOptions) {
  const { database } = options;
  const timeoutMs = options.memberTimeoutMs ?? MEMBER_TURN_TIMEOUT_MS;
  /**
   * One turn at a time per room, in this process. The epoch is what covers the other one. The
   * same lane type the Bots use — a queue keyed by a string is a queue keyed by a string.
   */
  const roomLane = createBotLane();

  async function roomOf(actor: { id: string }, channelId: string) {
    const [row] = await database
      .select({
        id: channels.id,
        name: channels.name,
        epoch: channels.roomTurnEpoch,
      })
      .from(channels)
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, actor.id),
        ),
      )
      .where(eq(channels.id, channelId))
      .limit(1);
    // Not a member and no such room are the same answer, so belonging is not something to probe for.
    if (!row) throw new RoomError("laf:channel_not_found", 404);
    return row;
  }

  return {
    /**
     * Take the person's message and start the turn.
     *
     * The message is stored and the epoch bumped in ONE transaction, so a second message cannot
     * land between them and leave two turns each believing they are current. The turn itself runs
     * detached — the same shape a webhook trigger uses, and for the same reason: a caller kept on
     * the line for a minute of model work is a caller that times out and retries.
     */
    async post(input: {
      actor: { id: string; role: "admin" | "user" };
      actorLabel: string;
      channelId: string;
      threadId: string;
      text: string;
      messageId?: string;
      addressedAgentIds?: string[];
      personName: string;
    }): Promise<RoomTurnStart> {
      const text = input.text.trim();
      if (!text) throw new RoomError("laf:room_message_empty", 400);

      const room = await roomOf(input.actor, input.channelId);
      const members = await resolveRoomMembers(database, input.channelId);
      // A room with one Bot answers in the ordinary way, through the Bot's own conversation.
      if (members.length < 2) {
        throw new RoomError("laf:room_needs_two_bots", 409);
      }

      const turnId = randomUUID();
      const posted = await database.transaction(async (transaction) => {
        // Nothing outside this transaction is told about a message until the transaction that
        // wrote it has committed — hence the announcement below rather than in here.
        const written = await appendRoomMessage(transaction, {
          channelId: input.channelId,
          threadId: input.threadId,
          agentId: null,
          text,
          ...(input.messageId ? { messageId: input.messageId } : {}),
          /*
           * THE TURN IS THE RUN THAT ANSWERS THIS MESSAGE. A chat writes the person's message
           * under the run that answers it, and the failures reader finds "which message got no
           * reply" by that id. A room's turn is several runs — one per member — and the message
           * was written under none of them, so a room's failed turn could never be shown. The turn
           * itself now has a ledger row (see `run`), under this id, and the message names it.
           */
          runId: turnId,
        });
        const [bumped] = await transaction
          .update(channels)
          .set({ roomTurnEpoch: sql`${channels.roomTurnEpoch} + 1` })
          .where(eq(channels.id, input.channelId))
          .returning({ epoch: channels.roomTurnEpoch });
        return { written, epoch: Number(bumped?.epoch ?? room.epoch) };
      });
      if (posted.written.activity) options.announce?.(posted.written.activity);

      const memberIds = await watchers(database, input.channelId);
      /*
       * Who the person named: the composer's chips, which carry ids, and the `@`-mentions in the
       * text, which carry names — a person typing "@민수 이거 봐 줘" without picking the chip has
       * named 민수 exactly as clearly. Union, in the order the chips came and then the text.
       */
      const addressed = [
        ...new Set([
          ...(input.addressedAgentIds ?? []),
          ...mentionsIn(text, members),
        ]),
      ];

      options.emit({
        kind: "room.turn",
        channelId: input.channelId,
        memberIds,
        turnId,
        epoch: posted.epoch,
        members: members.map((member) => ({
          id: member.id,
          name: member.name,
        })),
      });

      const finished = roomLane
        .run(input.channelId, () =>
          run({
            actor: input.actor,
            actorLabel: input.actorLabel,
            channelId: input.channelId,
            threadId: input.threadId,
            room: { name: room.name },
            members,
            addressed,
            personName: input.personName,
            turnId,
            epoch: posted.epoch,
            memberIds,
            questionId: posted.written.messageId,
          }),
        )
        .catch((error: unknown) => {
          // The error as a bounded line, never the object: a failed transcript append is a
          // Drizzle error, and its message is the room's whole message array.
          log.error("room_turn_failed", {
            channel: input.channelId,
            turn: turnId,
            reason: error,
          });
        });

      return {
        turnId,
        messageId: posted.written.messageId,
        epoch: posted.epoch,
        finished,
      };
    },

    /**
     * End the current turn.
     *
     * Bumping the epoch is the whole mechanism: the turn stops at its next checkpoint, and any
     * member already thinking still gets to say what it produced. There is nothing to kill because
     * there is nothing the person is waiting on synchronously.
     */
    async stop(actor: { id: string }, channelId: string): Promise<void> {
      await roomOf(actor, channelId);
      await database
        .update(channels)
        .set({ roomTurnEpoch: sql`${channels.roomTurnEpoch} + 1` })
        .where(eq(channels.id, channelId));
    },
  };

  async function run(input: {
    actor: { id: string; role: "admin" | "user" };
    actorLabel: string;
    channelId: string;
    threadId: string;
    room: { name: string };
    members: RoomMember[];
    addressed: string[];
    personName: string;
    turnId: string;
    epoch: number;
    memberIds: string[];
    /** The person's message this turn answers: where its members' outcomes are kept. */
    questionId: string;
  }): Promise<void> {
    let ended = "failed";
    /** How each member that was asked came out, once per member. See `outcomes.ts`. */
    let heard: MemberReceipt[] = [];
    /*
     * A PERSON'S STOP FOR THE WHOLE TURN — `모두 멈추기`, not the room's own Stop.
     *
     * The room's Stop moves the epoch and lets a member already thinking finish, because a sentence
     * already paid for is worth keeping (see `stop` above). This one is the button for when
     * something looks wrong, so it also cuts the member mid-thought: a member can be driving the
     * Bot's browser, and "stop" that waited for the click to land would not be one. It moves the
     * epoch as well, so a turn the person queued behind this one in the same room does not start.
     */
    const stopping = new AbortController();
    const done = options.work?.track({
      kind: "room",
      userId: input.actor.id,
      agentId: null,
      threadId: input.threadId,
      stop: async () => {
        stopping.abort();
        await database
          .update(channels)
          .set({ roomTurnEpoch: sql`${channels.roomTurnEpoch} + 1` })
          .where(eq(channels.id, input.channelId))
          .catch(() => {
            // The turn in hand is stopped either way: `isCurrent` reads the signal first.
          });
        return true;
      },
    });
    // Members that could not take their turn at all, as opposed to members with nothing to add.
    let failures = 0;
    /** The first reason a member gave for not taking its turn: what the turn's own row says. */
    let firstFailure: string | null = null;
    let posted = 0;
    const names = namesOf(input.members);
    /*
     * THE TURN'S OWN ROW IN THE LEDGER, under the turn's id and with no Bot on it.
     *
     * Each member's run has a row of its own, for the roster ("is this Bot busy"). This one is for
     * the conversation: it is the run the person's message was written under, and a member failing
     * to take its turn ends it in error, which is what `GET /api/channels/:id/failures` reads to put
     * a line under the question that got no answer. No Bot, so the roster ignores it.
     */
    const turnRun = await options.ledger
      ?.begin({
        runId: input.turnId,
        threadId: input.threadId,
        agentId: null,
        userId: input.actor.id,
        origin: "room",
        label: input.room.name,
      })
      .catch(() => null);
    try {
      await drive();
      if (stopping.signal.aborted) ended = "stopped";
    } finally {
      done?.();
      if (turnRun) {
        /*
         * A stopped turn is `stopped`, the status the conversation's failure reader passes over —
         * whatever a member said before the stop stays said, and the question gets no red line.
         */
        await (stopping.signal.aborted
          ? options.ledger?.settle(turnRun, { status: "stopped", error: null })
          : options.ledger?.finish(turnRun, firstFailure)
        )?.catch(() => {});
      }
      /*
       * Written BEFORE `room.done`, so a tab that reads the thread's marks on hearing the turn end
       * finds them. Never allowed to fail the turn: what the members said is already in the room,
       * and a receipt that could not be kept costs a reload's worth of memory, not the answer.
       */
      await recordRoomReceipts(database, {
        threadId: input.threadId,
        messageId: input.questionId,
        members: heard,
      }).catch((error: unknown) => {
        log.error("room_receipts_unwritten", {
          channel: input.channelId,
          turn: input.turnId,
          reason: error,
        });
      });
      /*
       * ALWAYS, whatever threw. The browser was told the turn started and holds the composer
       * parked on it; a turn that failed before its first member — agents that would not resolve,
       * a plugin store that was down — used to leave the room stuck with Stop showing until a
       * reload. Stop cannot help either: it bumps the epoch, and nothing is running to notice.
       */
      options.emit({
        kind: "room.done",
        channelId: input.channelId,
        memberIds: input.memberIds,
        turnId: input.turnId,
        epoch: input.epoch,
        reason: ended,
        failures,
        posted,
        questionId: input.questionId,
        members: heard,
      });
    }

    async function drive(): Promise<void> {
      const agents = await options.resolveAgents(input.actor);

      const isCurrent = async () => {
        if (stopping.signal.aborted) return false;
        const [row] = await database
          .select({ epoch: channels.roomTurnEpoch })
          .from(channels)
          .where(eq(channels.id, input.channelId))
          .limit(1);
        return Number(row?.epoch ?? input.epoch) === input.epoch;
      };

      /**
       * One member's turn, on the trail. Written after the turn, before the next member is asked.
       *
       * `failed` is the member's own reason where it had one, and true where the turn threw before
       * the member was reached; `spoke` is what actually landed in the room. The round and the
       * reason are what make the rule in `turn-taking.ts` arguable with afterwards.
       */
      const record = async (
        ask: {
          member: RoomMember;
          round: number;
          reason: string;
          namedBy?: string;
        },
        result: {
          runId: string;
          spoke: number;
          failed: string | boolean | null;
          /** A person stopped the turn while this member had it. Not a failure. */
          stopped?: boolean;
          outcome: MemberOutcome;
        },
      ) => {
        /*
         * Said to the room the moment the member's turn is over, before the trail is written: the
         * face that was working settles into the turn's receipt while the next member is being
         * asked, rather than every quiet member appearing at once when the turn ends.
         */
        options.emit({
          kind: "room.settled",
          channelId: input.channelId,
          memberIds: input.memberIds,
          turnId: input.turnId,
          epoch: input.epoch,
          memberId: ask.member.id,
          outcome: result.outcome,
        });
        try {
          await options.auditStore?.insert({
            eventType: "room.member_turn",
            targetType: "channel",
            targetId: input.channelId,
            ...(input.actor.id.startsWith("dev-")
              ? {}
              : { actorUserId: input.actor.id }),
            payload: {
              bot: ask.member.id,
              actor: input.actor.id,
              thread: input.threadId,
              turn: input.turnId,
              run: result.runId,
              round: ask.round,
              reason: ask.reason,
              ...(ask.namedBy ? { namedBy: ask.namedBy } : {}),
              spoke: result.spoke,
              failed: result.failed !== null && result.failed !== false,
              ...(typeof result.failed === "string"
                ? { failure: result.failed }
                : {}),
              ...(result.stopped ? { stopped: true } : {}),
              outcome: result.outcome,
            },
          });
        } catch {
          // The trail being down is its own incident; the room's turn is not it.
        }
      };

      const outcome = await runRoomTurn({
        members: input.members,
        addressedIds: input.addressed,
        isCurrent,
        runMember: async ({
          member,
          windingDown,
          round,
          reason,
          namedBy,
          answeringNow,
        }) => {
          const ask = {
            member,
            round,
            reason,
            ...(namedBy ? { namedBy } : {}),
          };
          /*
           * The trail keeps the id — it is what a row is joined on — and the PROMPT gets the name,
           * because "a4f1c… 가 너를 불렀다" is not a sentence anybody can answer. A colleague that
           * has since left the room resolves to nothing, and the prompt then says only that this
           * member was called in.
           */
          const namedByName = namedBy ? names.get(namedBy) : undefined;
          // Minted here rather than in the member's turn, because the messages it delivers are
          // written under it before the turn returns. See `MemberTurnInput.runId`.
          const runId = randomUUID();
          /** What this member said, in order, for the next round to read who it named. */
          const said: string[] = [];
          try {
            const base: UnattendedToolkit = options.tools
              ? await options.tools(member.id, {
                  id: input.actor.id,
                  ...(input.actor.id.startsWith("dev-")
                    ? {}
                    : { userId: input.actor.id }),
                  // The room's thread, so "for this conversation" means this room: an allowance
                  // granted here answers for this member's actions in this room and nowhere else.
                  threadId: input.threadId,
                })
              : { tools: [], execute: async () => ({ ok: false }) };

            /*
             * A GATED ACTION IS RAISED TO THE ROOM. The loop already tells the member that a person
             * has to allow it and to say so. In a one-to-one conversation the question is then drawn
             * on the tool call's own line; a room draws no tool calls, so without this the question
             * sat in the registry for its ten minutes where nobody could see it, and the member's
             * "I'm waiting for your approval" had no buttons anywhere.
             */
            /*
             * The member's tools, with the boundary wired to the room: a question its action raises
             * is shown to the person, the turn holds for their answer, and the answer travels with
             * the retry. See `approval-relay.ts` for why those three belong together.
             */
            /*
             * Aborted the moment this member's turn returns, however it returned. What it stops is a
             * wait for a person's answer outliving the turn that raised the question.
             */
            const turnOver = new AbortController();
            const toolkit = relayApprovals(base, {
              memberId: member.id,
              signal: turnOver.signal,
              ...(options.awaitApproval ? { wait: options.awaitApproval } : {}),
              announce: (question, answered) =>
                options.emit({
                  kind: "room.approval",
                  channelId: input.channelId,
                  memberIds: input.memberIds,
                  turnId: input.turnId,
                  epoch: input.epoch,
                  memberId: member.id,
                  memberName: member.name,
                  approvalId: question.approvalId,
                  subject: question.subject,
                  // Written to the room's open sockets and nowhere else; a frame is never stored.
                  ...(question.preview ? { preview: question.preview } : {}),
                  rule: question.rule,
                  ...(question.scope ? { scope: question.scope } : {}),
                  ...(question.threadId ? { threadId: question.threadId } : {}),
                  expiresAt: question.expiresAt,
                  answered,
                }),
            });

            /*
             * SAID BEFORE THE LANE, NOT AFTER IT. Waiting for this Bot's lane is part of the wait
             * the person is watching — a member whose Bot is busy with a routine can sit here for
             * minutes — and a screen that only says "working" once the work starts is silent for
             * exactly the stretch that most needs explaining.
             */
            options.emit({
              kind: "room.asked",
              channelId: input.channelId,
              memberIds: input.memberIds,
              turnId: input.turnId,
              epoch: input.epoch,
              memberId: member.id,
              memberName: member.name,
            });

            const open = new Set<string>();
            const result = await options.lane.run(member.id, async () => {
              /*
               * CHECKED AGAIN HERE, INSIDE THE LANE. The orchestrator checks before asking a member to
               * speak, but the lane is a queue: a Bot busy with a routine can hold this for minutes,
               * and the person may well have said something else by the time it is this member's
               * turn. Answering then is answering a question nobody is still asking.
               */
              // Not asked at all, which is not the same as reading it and staying quiet.
              if (!(await isCurrent())) {
                return { spoke: 0, failed: null, outcome: "stopped" as const };
              }
              /*
               * READ INSIDE THE LANE, NOT BEFORE IT. Both of these are snapshots of a conversation
               * and both go stale: the lane is a queue, and a member whose Bot is busy with a routine
               * can wait minutes for its place. Read before the wait, a member speaking third in a
               * round would open with what the room looked like before the first two spoke — which is
               * the exact staleness reading them per member was for.
               *
               * The room's lines and the member's memory of the person, together because they are
               * independent: one query's latency, not two.
               */
              const [lines, history] = await Promise.all([
                readRoomLines(
                  database,
                  input.threadId,
                  names,
                  input.personName,
                ),
                readPrivateHistory(database, input.actor.id, member.id),
              ]);
              return runMemberTurn({
                room: { channelId: input.channelId, name: input.room.name },
                threadId: input.threadId,
                runId,
                member,
                peers: input.members,
                lines,
                history,
                windingDown,
                reason,
                answeringNow,
                ...(namedByName ? { namedBy: namedByName } : {}),
                agent: agents[member.id] ?? null,
                toolkit,
                userId: input.actor.id,
                timeoutMs,
                signal: stopping.signal,
                ...(options.ledger ? { ledger: options.ledger } : {}),
                deliver: async (text, toolCallId) => {
                  const written = await appendRoomMessage(database, {
                    channelId: input.channelId,
                    threadId: input.threadId,
                    agentId: member.id,
                    text,
                    runId,
                  });
                  said.push(text);
                  // No transaction here — the append is its own — so the roster row is announced
                  // as soon as it has moved.
                  if (written.activity) options.announce?.(written.activity);
                  open.delete(toolCallId);
                  /*
                   * THE SETTLED MESSAGE REPLACES THE PROVISIONAL ONE IN PLACE. The browser has been
                   * drawing this message under the tool call's id since its first fragment; this frame
                   * names that id and carries the stored id and the final text, so the bubble is swapped
                   * rather than removed-then-refetched. Measured before this: every reply blinked off
                   * the screen at stream end and came back a second or two later through catch-up.
                   */
                  options.emit({
                    kind: "room.end",
                    channelId: input.channelId,
                    memberIds: input.memberIds,
                    turnId: input.turnId,
                    epoch: input.epoch,
                    messageId: toolCallId,
                    posted: true,
                    storedId: written.messageId,
                    at: written.at,
                    text,
                  });
                },
                watch: {
                  open: (toolCallId) => {
                    open.add(toolCallId);
                    options.emit({
                      kind: "room.open",
                      channelId: input.channelId,
                      memberIds: input.memberIds,
                      turnId: input.turnId,
                      epoch: input.epoch,
                      messageId: toolCallId,
                      authorId: member.id,
                      authorName: member.name,
                    });
                  },
                  text: (toolCallId, text) => {
                    options.emit({
                      kind: "room.delta",
                      channelId: input.channelId,
                      memberIds: input.memberIds,
                      turnId: input.turnId,
                      epoch: input.epoch,
                      messageId: toolCallId,
                      text,
                    });
                  },
                  /*
                   * Deliberately NOT where the bubble comes down. This fires when the model has finished
                   * WRITING the call — the tool has not run yet, so the message is not in the room. A
                   * delivered call is settled by `deliver` above; one that was refused, or that the run
                   * died on, is still in `open` when the member's turn ends and the sweep below clears
                   * it. Nothing is emitted here.
                   */
                  close: () => {},
                },
              });
            });

            // A run that died mid-sentence leaves nothing half-drawn on anybody's screen.
            for (const toolCallId of open) {
              options.emit({
                kind: "room.end",
                channelId: input.channelId,
                memberIds: input.memberIds,
                turnId: input.turnId,
                epoch: input.epoch,
                messageId: toolCallId,
                posted: false,
              });
            }
            turnOver.abort();
            if (result.failed) {
              failures += 1;
              firstFailure ??= result.failed;
            }
            await record(ask, {
              runId,
              spoke: result.spoke,
              failed: result.failed,
              ...(result.stopped ? { stopped: true } : {}),
              outcome: result.outcome,
            });
            return { spoke: result.spoke, said, outcome: result.outcome };
          } catch (error) {
            // Whatever a stop interrupted on its way here is the stop, not this member failing.
            if (stopping.signal.aborted) {
              const outcome = said.length > 0 ? "spoke" : "stopped";
              await record(ask, {
                runId,
                spoke: said.length,
                failed: null,
                stopped: true,
                outcome,
              });
              return { spoke: said.length, said, outcome };
            }
            /*
             * ONE MEMBER'S BAD DAY IS NOT THE ROOM'S. Everything above can throw before the model
             * is ever reached — resolving a Bot's tools, reading its grants, reading the thread —
             * and unguarded, any of those took the whole turn down with it: the other members were
             * never asked, and the room ended with a failure nobody could attribute. Counted as
             * this member failing, which is what it is, and the turn goes on without it.
             */
            failures += 1;
            const reason =
              error instanceof Error ? error.message : String(error);
            firstFailure ??= reason;
            log.error("room_member_turn_failed", {
              channel: input.channelId,
              member: member.id,
              reason: error,
            });
            const outcome = said.length > 0 ? "spoke" : "failed";
            await record(ask, {
              runId,
              spoke: said.length,
              failed: reason,
              outcome,
            });
            return { spoke: said.length, said, outcome };
          }
        },
      });

      ended = outcome.ended;
      posted = outcome.posted;
      heard = outcome.members;
    }
  }
}

async function watchers(
  database: Database,
  channelId: string,
): Promise<string[]> {
  const rows = await database
    .select({ userId: channelMemberships.userId })
    .from(channelMemberships)
    .where(eq(channelMemberships.channelId, channelId));
  return rows.map((row) => row.userId);
}
