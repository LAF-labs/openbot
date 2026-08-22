/**
 * Who is in a room, in one order, everywhere.
 *
 * `ChannelStore.get` returns `agentIds` sorted by id, the composer's `@` menu is built from that
 * list, and the turn rotates through it — so it is read the same way here. A room whose members
 * come back in a different order in two places is one where "the first member" means two things.
 */
import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentProfiles, agents, channelAgents } from "../db/schema";
import { ROOM_MEMBERS, type RoomMember } from "./prompt";

export type Executor = Pick<Database, "select">;

/**
 * The room's Bots, with the words that introduce them to each other.
 *
 * `title` and never `roleDescription`: the title is a phrase ("리스크·컴플라이언스") and the role
 * description is a paragraph written for the Bot itself. Six of those in a header would be most of
 * the prompt, and none of it is what a colleague needs to know about who else is here.
 *
 * A soft-deleted Bot stays in the list. It is dropped when the turn tries to resolve an agent for
 * it, which is the only place that knows WHY it could not answer — and a member silently missing
 * from the header is a room that lies about who is in it.
 */
export async function resolveRoomMembers(
  executor: Executor,
  channelId: string,
): Promise<RoomMember[]> {
  const rows = await executor
    .select({
      id: channelAgents.agentId,
      name: agents.name,
      title: agentProfiles.title,
    })
    .from(channelAgents)
    .innerJoin(agents, eq(agents.id, channelAgents.agentId))
    .leftJoin(agentProfiles, eq(agentProfiles.agentId, channelAgents.agentId))
    .where(eq(channelAgents.channelId, channelId))
    .orderBy(asc(channelAgents.agentId));

  /*
   * Cut to the cap rather than refused. The cap belongs to the turn — six Bots answering in rounds
   * is already a minute of work — and a room that somehow holds seven should still be readable and
   * still answer, with the extra members quiet, rather than erroring on every message.
   */
  return rows.slice(0, ROOM_MEMBERS).map((row) => ({
    id: row.id,
    name: row.name,
    ...(row.title?.trim() ? { description: row.title.trim() } : {}),
  }));
}

/** Member id to name, for rendering a room's lines. */
export function namesOf(members: readonly RoomMember[]): Map<string, string> {
  return new Map(members.map((member) => [member.id, member.name]));
}
