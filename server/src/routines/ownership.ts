import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { manageableByActor } from "../agents/profile-policy";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import { agentProfiles, lafRoutines } from "../db/schema";
import { noSuchRoutine } from "./errors";

/**
 * Which routines this person may see and act on, as a WHERE clause.
 *
 * The rule is `canManageAgent`'s (agents/profile-policy.ts) carried across: whoever can manage
 * the Bot can manage the routines that drive it. So a routine is yours if you wrote it, or if the
 * Bot it names is one you may manage.
 *
 * The Bot's owner and not only the author, because a routine outlives the person who typed it:
 * staff leave, and a shop owner locked out of the routines running on their own Bot has no way in
 * that is not an administrator. `agent_id` is not a foreign key yet, so a routine naming a Bot
 * that no longer exists matches nobody by that half and stays with its author.
 *
 * AN ADMINISTRATOR NO LONGER REACHES ALL OF THEM, and that is the ownership rule arriving here.
 * This returned `undefined` for the role — every routine on the deployment, unfiltered — and a
 * routine row carries the name and the standing instruction its author wrote, beside the id of
 * the Bot it drives. That is somebody else's Bot named on a screen that is not theirs, which is
 * the whole of what the owner asked to stop. `manageableByActor` is still `canManageAgent`, only
 * asked of a Bot the actor may actually see, so an administrator keeps the routines they wrote
 * and the routines on their own Bots.
 */
export function scopeOf(database: Database, actor: AgentActor) {
  return or(
    eq(lafRoutines.createdById, actor.id),
    inArray(
      lafRoutines.agentId,
      database
        .select({ agentId: agentProfiles.agentId })
        .from(agentProfiles)
        .where(and(manageableByActor(actor), isNull(agentProfiles.deletedAt))),
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
