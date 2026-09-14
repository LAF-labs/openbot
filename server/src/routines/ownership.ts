import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import { agentProfiles, lafRoutines } from "../db/schema";
import { noSuchRoutine } from "./errors";

/**
 * Which routines this person may see and act on, as a WHERE clause.
 *
 * The rule is `canManageAgent`'s (agents/profile-policy.ts) carried across: whoever can manage
 * the Bot can manage the routines that drive it. So a routine is yours if you wrote it, or if the
 * Bot it names is yours, and an administrator reaches all of them — the same three cases, in the
 * same order, that decide a Bot.
 *
 * The Bot's owner and not only the author, because a routine outlives the person who typed it:
 * staff leave, and a shop owner locked out of the routines running on their own Bot has no way in
 * that is not an administrator. `agent_id` is not a foreign key yet, so a routine naming a Bot
 * that no longer exists matches nobody by that half and stays with its author.
 */
export function scopeOf(database: Database, actor: AgentActor) {
  if (actor.role === "admin") return undefined;
  return or(
    eq(lafRoutines.createdById, actor.id),
    inArray(
      lafRoutines.agentId,
      database
        .select({ agentId: agentProfiles.agentId })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.ownerUserId, actor.id),
            isNull(agentProfiles.deletedAt),
          ),
        ),
    ),
  );
}

/** One routine, if it is this person's. Anything else did not exist; see `noSuchRoutine`. */
export async function mine(database: Database, actor: AgentActor, id: string) {
  const [row] = await database
    .select()
    .from(lafRoutines)
    .where(and(eq(lafRoutines.id, id), scopeOf(database, actor)));
  if (!row) throw noSuchRoutine();
  return row;
}
