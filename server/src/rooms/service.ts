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
import { and, eq, sql } from "drizzle-orm";
import type { ActionActor } from "../computer/gateway";
import type { Database } from "../db/client";
import { channelAgents, channelMemberships, channels } from "../db/schema";
import type { BotLane } from "../runner/bot-lane";
import type { RunLedger } from "../runner/run-ledger";
import type { UnattendedToolkit } from "../runner/unattended";
import type { AbstractAgent } from "@ag-ui/client";
import type { RoomFrame } from "./frames";
import { namesOf, resolveRoomMembers } from "./members";
import { runMemberTurn } from "./member-turn";
import { runRoomTurn } from "./orchestrator";
import type { RoomMember } from "./prompt";
import {
  appendRoomMessage,
  readRoomLines,
  type StoredMessage,
} from "./transcript";

/** How long one member may take. Generous: it may open pages and read files before it answers. */
export const MEMBER_TURN_TIMEOUT_MS = 300_000;

export class RoomError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
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
  tools?: (
    botId: string,
    actor: ActionActor,
    actorLabel: string,
  ) => Promise<UnattendedToolkit>;
  /** Push a frame to whoever is watching this room. */
  emit: (frame: RoomFrame) => void;
  /** Keep the runner's rehydrated copy of the thread in step with what we wrote. */
  onAppended?: (
    threadId: string,
    agentId: string | null,
    messages: StoredMessage[],
  ) => void;
  memberTimeoutMs?: number;
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
  /** One turn at a time per room, in this process. The epoch is what covers the other one. */
  const lanes = new Map<string, Promise<unknown>>();

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
    if (!row) throw new RoomError("Channel not found.", 404);
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
      if (!text) throw new RoomError("Say something first.", 400);

      const room = await roomOf(input.actor, input.channelId);
      const members = await resolveRoomMembers(database, input.channelId);
      if (members.length < 2) {
        throw new RoomError(
          "This room has one Bot. It answers in the ordinary way.",
          409,
        );
      }

      const turnId = randomUUID();
      const posted = await database.transaction(async (transaction) => {
        const written = await appendRoomMessage(
          transaction,
          {
            channelId: input.channelId,
            threadId: input.threadId,
            agentId: null,
            text,
            ...(input.messageId ? { messageId: input.messageId } : {}),
          },
          options.onAppended,
        );
        const [bumped] = await transaction
          .update(channels)
          .set({ roomTurnEpoch: sql`${channels.roomTurnEpoch} + 1` })
          .where(eq(channels.id, input.channelId))
          .returning({ epoch: channels.roomTurnEpoch });
        return { written, epoch: Number(bumped?.epoch ?? room.epoch) };
      });

      const memberIds = await watchers(database, input.channelId);
      const addressed = input.addressedAgentIds ?? [];

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

      const finished = queue(input.channelId, () =>
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
        }),
      ).catch((error: unknown) => {
        console.error("[rooms] a turn failed:", error);
      });

      return {
        turnId,
        messageId: posted.written?.messageId ?? "",
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

  function queue<T>(channelId: string, task: () => Promise<T>): Promise<T> {
    const previous = lanes.get(channelId) ?? Promise.resolve();
    const started = previous.then(task, task);
    const settled = started.then(
      () => undefined,
      () => undefined,
    );
    lanes.set(channelId, settled);
    void settled.then(() => {
      if (lanes.get(channelId) === settled) lanes.delete(channelId);
    });
    return started;
  }

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
  }): Promise<void> {
    const names = namesOf(input.members);
    const agents = await options.resolveAgents(input.actor);

    const isCurrent = async () => {
      const [row] = await database
        .select({ epoch: channels.roomTurnEpoch })
        .from(channels)
        .where(eq(channels.id, input.channelId))
        .limit(1);
      return Number(row?.epoch ?? input.epoch) === input.epoch;
    };

    const outcome = await runRoomTurn({
      members: input.members,
      addressedIds: input.addressed,
      isCurrent,
      runMember: async ({ member, windingDown }) => {
        /*
         * The lines are read FRESH for every member, not once for the turn. A member speaking
         * third in a round has to see what the first two just said, or the room is three Bots
         * answering the same question in parallel rather than a conversation.
         */
        const lines = await readRoomLines(
          database,
          input.threadId,
          names,
          input.personName,
        );

        const toolkit = options.tools
          ? await options.tools(
              member.id,
              {
                id: input.actor.id,
                ...(input.actor.id.startsWith("dev-")
                  ? {}
                  : { userId: input.actor.id }),
              },
              input.actorLabel,
            )
          : { tools: [], execute: async () => ({ ok: false }) };

        const open = new Set<string>();
        const result = await options.lane.run(member.id, () =>
          runMemberTurn({
            room: { channelId: input.channelId, name: input.room.name },
            member,
            peers: input.members,
            lines,
            windingDown,
            agent: agents[member.id] ?? null,
            toolkit,
            userId: input.actor.id,
            timeoutMs,
            ...(options.ledger ? { ledger: options.ledger } : {}),
            deliver: async (text) => {
              const written = await appendRoomMessage(
                database,
                {
                  channelId: input.channelId,
                  threadId: input.threadId,
                  agentId: member.id,
                  text,
                },
                options.onAppended,
              );
              if (written) {
                options.emit({
                  kind: "room.end",
                  channelId: input.channelId,
                  memberIds: input.memberIds,
                  turnId: input.turnId,
                  epoch: input.epoch,
                  messageId: written.messageId,
                  posted: true,
                });
              }
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
               * The provisional message comes off the screen when the call ends. Either it was
               * delivered — in which case the settled message has already arrived under its own id
               * — or it was refused, and a refusal must not leave words on screen that are not in
               * the room.
               */
              close: (toolCallId) => {
                open.delete(toolCallId);
                options.emit({
                  kind: "room.end",
                  channelId: input.channelId,
                  memberIds: input.memberIds,
                  turnId: input.turnId,
                  epoch: input.epoch,
                  messageId: toolCallId,
                  posted: false,
                });
              },
            },
          }),
        );

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
        return result.spoke;
      },
    });

    options.emit({
      kind: "room.done",
      channelId: input.channelId,
      memberIds: input.memberIds,
      turnId: input.turnId,
      epoch: input.epoch,
      reason: outcome.ended,
    });
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

/** Whether this channel is a room: more than one Bot in it. */
export async function isRoom(
  database: Database,
  channelId: string,
): Promise<boolean> {
  const rows = await database
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(eq(channelAgents.channelId, channelId));
  return rows.length > 1;
}
