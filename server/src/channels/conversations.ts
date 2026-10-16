/**
 * Starting a conversation: the one a Bot already has, or a new channel with its own thread.
 */
import {
  AgentNotFoundError,
  type AgentProfileStore,
} from "../agents/profile-store";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
} from "../db/schema";
import type { Executor } from "../runner/thread-store";
import { conversationsOf } from "./conversations-of";
import { soloConversationOf } from "./solo-channel";
import type { ThreadIdentity } from "./thread-identity";
import type { AgentChannel } from "./types";
import { cutOnGraphemes } from "../../../shared/sound-text";
import { roomConversationId } from "../../../shared/hub/room-answers";

const PRIVATE_AGENT_CHANNEL_DESCRIPTION = "Private agent channel.";
const MAX_CHANNEL_NAME_CODE_POINTS = 120;

/**
 * A conversation is named after who is in it — its Bot — and cut to fit a roster row.
 *
 * Counted in code points and cut between characters as they are seen, so a name ending in an emoji
 * — a flag, a face with a skin tone — is never left with half of one.
 */
export function channelName(names: string[]) {
  const joined = names.join(", ");
  if (Array.from(joined).length <= MAX_CHANNEL_NAME_CODE_POINTS) return joined;
  return `${cutOnGraphemes(joined, MAX_CHANNEL_NAME_CODE_POINTS - 1)}…`;
}

export type ConversationDeps = {
  database: Database;
  profileStore: AgentProfileStore;
  threadIdentity: ThreadIdentity;
};

export function createConversation(
  { database, profileStore, threadIdentity }: ConversationDeps,
  actor: AgentActor,
  agentIds: string[],
): Promise<AgentChannel> {
  return database.transaction(
    async (transaction) => {
      const profilesById = await lockProfiles(
        transaction,
        profileStore,
        actor,
        agentIds,
      );

      /*
       * ONE CONVERSATION PER BOT, AND THIS IS WHERE THAT IS DECIDED.
       *
       * A Bot here is a colleague with a face, a standing role, its own routines and its own
       * seat at the account's computer — and every other table in this server is keyed on it:
       * policy identity, approvals, repetition counts, credentials, the audit trail. The
       * conversation was the one thing that was not, so every message from Home minted a fresh
       * channel and the roster filled up with the same colleague over and over. Three Bots had
       * thirteen channels between them, nine of them the same Bot.
       *
       * So a request for a single Bot resolves to that Bot's conversation if it has one. Inside
       * the transaction, after the profile lock above, so two sends racing from two tabs cannot
       * each decide there is no channel and make one.
       *
       * A request names one Bot: the route refuses more (`laf:channel_one_bot`) since rooms were
       * removed on 2026-09-24. The list shape is what the store has always taken.
       */
      const soleAgentId = agentIds.length === 1 ? agentIds[0] : undefined;
      if (soleAgentId) {
        const existing = await soloConversationOf(
          transaction,
          actor.id,
          soleAgentId,
        );
        if (existing) {
          return {
            id: existing.channelId,
            name: existing.name,
            agentIds,
            threadId: existing.threadId,
            active: true,
            kind: "main",
          };
        }
      }

      return writeConversation(transaction, threadIdentity, actor, {
        // Named from the caller's ordering, which is the order the channel presents its agents in.
        name: channelName(
          agentIds.map((agentId) => {
            const profile = profilesById.get(agentId);
            if (!profile) throw new AgentNotFoundError(agentId);
            return profile.name;
          }),
        ),
        // Said, not left to the column's default: this path makes a Bot's main conversation and
        // no other, having found none above. A project is made by a path of its own (piece 4-2).
        kind: "main",
        agentIds,
      });
    },
    { isolationLevel: "read committed" },
  );
}

/** How many projects one Bot may have beside its main conversation. */
export const PROJECTS_PER_BOT = 50;

/** A person asked for one more project than a Bot may have. */
export class ProjectLimitError extends Error {
  readonly code = "laf:project_limit" as const;
  readonly status = 409 as const;
  constructor() {
    super("laf:project_limit");
  }
}

/**
 * A PROJECT: ANOTHER CONVERSATION WITH THE SAME BOT, BESIDE ITS MAIN ONE (2026-10-10, record §3,
 * piece 4-2).
 *
 * A PATH OF ITS OWN, WHICH ALWAYS MAKES ONE. `createConversation` answers the conversation a Bot
 * already has, on purpose — that is what stopped every message from Home minting a channel. A
 * project is the thing that was refused there, asked for by name, so it does not go through that
 * door: it never returns an existing channel and it never makes a `main`.
 *
 * NAMED BY THE PERSON, in their words, as given: the route has cut it to size
 * (`parseProjectInput`). An empty name is stored empty — "이름 없는 프로젝트" is the surface's to say.
 *
 * COUNTED BEHIND A FENCE OF ITS OWN, so two presses from two windows cannot both be the fiftieth.
 * The count is of this person's channels with this Bot that say `project`.
 *
 * THE PROFILE LOCK IS NOT THAT FENCE. `lockProfiles` takes the Bot's row `FOR SHARE`, which holds
 * the Bot against deletion and holds nothing against another share — two creates hold it at once,
 * each reads forty-nine under its own snapshot, and each inserts: measured here with two presses
 * released from behind one row lock, fifty-one projects (review, 2026-10-11). The fence is the one
 * the seat count uses (`profile-store.ts` `reserveSeat`): an advisory lock keyed on this person
 * and this Bot, taken before anything is read, released with the transaction whichever way it
 * ends. The second press reads a table the first has already added to, and is refused.
 */
export function createProject(
  { database, profileStore, threadIdentity }: ConversationDeps,
  actor: AgentActor,
  agentId: string,
  name: string,
): Promise<AgentChannel> {
  return database.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`laf_projects:${actor.id}:${agentId}`}))`,
      );
      await lockProfiles(transaction, profileStore, actor, [agentId]);
      const [{ count } = { count: 0 }] = await conversationsOf(
        transaction,
        { count: sql<number>`count(*)::int` },
        // One being deleted holds its rows, and its place, until it is gone (`deleting.ts`).
        { userId: actor.id, agentId, includingDeleting: true },
      ).where(eq(channels.kind, "project"));
      if (count >= PROJECTS_PER_BOT) throw new ProjectLimitError();

      return writeConversation(transaction, threadIdentity, actor, {
        name,
        kind: "project",
        agentIds: [agentId],
      });
    },
    { isolationLevel: "read committed" },
  );
}

/**
 * THE CONVERSATION A BOT ANSWERS ITS PERSON'S TEAM ROOM IN: one per room, made the first time the
 * person asks their 라피 there and found again every time after (`hub/room-answers.ts`).
 *
 * ITS ID IS MADE FROM THE ROOM AND THE BOT (`roomConversationId`), so no table holds which room it
 * is: the VM finds it again by the id, and a room's screen links to it from what it already knows.
 * The Bot is in the id because a Bot can be deleted and another made; the new one starts a room's
 * conversation of its own rather than being handed the old one's channel.
 *
 * NEITHER `main` NOR A PROJECT. It is not counted against the fifty, it is never taken for the main
 * conversation (`solo-channel.ts` reads `main` only), and what it writes goes in the Bot's own
 * folder — the person asked for it from their own account, with their own permissions.
 *
 * The advisory lock keeps two first questions from making it twice; the room's questions are taken
 * one at a time anyway, so it is a fence and not a queue.
 */
export function openRoomConversation(
  { database, profileStore, threadIdentity }: ConversationDeps,
  actor: AgentActor,
  agentId: string,
  room: { id: string; name: string },
): Promise<AgentChannel> {
  const id = roomConversationId(room.id, agentId);
  return database.transaction(
    async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`laf_room_conversation:${id}`}))`,
      );
      await lockProfiles(transaction, profileStore, actor, [agentId]);
      const [found] = await transaction
        .select({ name: channels.name, threadId: channelThreads.threadId })
        .from(channels)
        .innerJoin(
          channelThreads,
          and(
            eq(channelThreads.channelId, channels.id),
            eq(channelThreads.userId, actor.id),
          ),
        )
        .where(eq(channels.id, id))
        .limit(1);
      if (found) {
        return {
          id,
          name: found.name,
          agentIds: [agentId],
          threadId: found.threadId,
          active: true,
          kind: "room",
        };
      }
      return writeConversation(
        transaction,
        threadIdentity,
        actor,
        { name: room.name, kind: "room", agentIds: [agentId] },
        id,
      );
    },
    { isolationLevel: "read committed" },
  );
}

/**
 * Every Bot the conversation will hold, read and locked on the caller's transaction.
 *
 * Validated on this transaction, not through `profileStore.get`: the read has to share the
 * connection this transaction already holds, and has to hold the profile so an agent cannot be
 * deleted between passing the check and being linked to the new channel.
 *
 * Locks are taken in agent-ID order. Two channels selecting the same pair of agents in opposite
 * orders would otherwise be able to deadlock against each other.
 */
async function lockProfiles(
  transaction: Executor,
  profileStore: AgentProfileStore,
  actor: AgentActor,
  agentIds: readonly string[],
): Promise<Map<string, AgentProfile>> {
  const profilesById = new Map<string, AgentProfile>();
  for (const agentId of [...agentIds].sort()) {
    const profile = await profileStore.getWithin(transaction, actor, agentId);
    if (!profile) throw new AgentNotFoundError(agentId);
    profilesById.set(agentId, profile);
  }
  return profilesById;
}

/**
 * THE CHANNEL, ITS ONE MEMBER, ITS BOTS AND THE MEMBER'S THREAD, WRITTEN TOGETHER. A conversation
 * is these four rows and never fewer — every reader joins on them (`conversations-of.ts`) — and
 * the main conversation and a project are made by the one write, so neither path can be short a
 * row the other has.
 */
async function writeConversation(
  transaction: Executor,
  threadIdentity: ThreadIdentity,
  actor: AgentActor,
  { name, kind, agentIds }: Pick<AgentChannel, "name" | "kind" | "agentIds">,
  /** A room's conversation is found again by its id; every other one is given a fresh one. */
  id = `channel_${crypto.randomUUID()}`,
): Promise<AgentChannel> {
  // Minted rather than a bare random id, so the thread says which deployment it belongs to
  // in a project that may hold more than one. See thread-identity.ts.
  const threadId = threadIdentity.mint();

  await transaction.insert(channels).values({
    id,
    name,
    description: PRIVATE_AGENT_CHANNEL_DESCRIPTION,
    kind,
  });
  await transaction.insert(channelMemberships).values({
    channelId: id,
    userId: actor.id,
  });
  await transaction
    .insert(channelAgents)
    .values(agentIds.map((agentId) => ({ channelId: id, agentId })));
  await transaction.insert(channelThreads).values({
    userId: actor.id,
    channelId: id,
    threadId,
  });

  return { id, name, agentIds, threadId, active: true, kind };
}
