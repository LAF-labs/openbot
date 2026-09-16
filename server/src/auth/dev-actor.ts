import type { MiddlewareHandler } from "hono";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import {
  type AppVariables,
  type AuthenticatedActor,
  actorMayDriveBot,
  type BotOwnerLookup,
} from "./guards";

/**
 * A signed-in person, without signing in. Local development only.
 *
 * Local development can opt into a fixed administrator actor so the product can run without Google
 * OAuth credentials or an interactive consent screen. Hosted deployments must use real
 * authentication.
 *
 * Two independent locks:
 *
 *  1. `LAF_DEV_NO_AUTH=true` must be set. Absent, nothing here runs.
 *  2. `NODE_ENV` must not be `production`. A deployment that sets the flag by accident still refuses,
 *     and it refuses by refusing to start rather than by ignoring the flag, because a
 *     deployment believing it has authentication when it does not is the worst of the three states.
 *
 * The actor is an administrator so admin surfaces can be demonstrated too, and its id is fixed so
 * threads and memory stay attached to the same person across restarts.
 */

/**
 * The fixture, and the one thing routes elsewhere ask about it: its address.
 *
 * Four route modules used to carry the email as a literal of their own, guarded by a test that
 * walked the copies, on the stated grounds that `audit_events.actor_user_id` had a foreign key to
 * `users` and a stale copy would silently lose the row. That key does not exist — the trail is
 * append-only, so it never had one — and the copies were four chances to drift for a reason that
 * was not true. They import this now. What the comparison still buys is attribution: a fixture is
 * not a person, so its id does not become the actor of a row, and the payload names it either way.
 */
export const DEV_ACTOR: AuthenticatedActor = {
  id: "dev-local-user",
  email: "dev@laf.local",
  role: "admin",
};

type UserWriter = Pick<Database, "insert">;

export async function initializeDevActorUser(
  database: UserWriter,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false;

  const name = DEV_ACTOR.name ?? DEV_ACTOR.email;
  await database
    .insert(users)
    .values({
      id: DEV_ACTOR.id,
      email: DEV_ACTOR.email,
      name,
      emailVerified: false,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: DEV_ACTOR.email,
        name,
        updatedAt: new Date(),
      },
    });

  return true;
}

export function devAuthEnabled(
  environment: Record<string, string | undefined>,
): boolean {
  // The pre-rename spelling no longer ENABLES anything, but in production it
  // still REFUSES: a stale deployment .env that meant "no auth" must fail
  // loudly, not fall through to an authentication state nobody chose.
  const legacy = environment.OPENBOT_DEV_NO_AUTH?.trim() === "true";
  const enabled = environment.LAF_DEV_NO_AUTH?.trim() === "true";
  if ((enabled || legacy) && environment.NODE_ENV === "production") {
    throw new Error(
      "LAF_DEV_NO_AUTH cannot be used with NODE_ENV=production. Refusing to start without authentication.",
    );
  }
  return enabled;
}

/**
 * A guard that admits everybody as {@link DEV_ACTOR}. Only ever mounted when devAuthEnabled().
 *
 * It answers whose Bot it is the way `createRequireUser` does, with the same predicate. Until
 * 2026-09-16 it set the actor alone and the administrator exception in `actorMayDriveBot` let the
 * fixed administrator through anyway; when that exception went, every Bot-scoped route answered 404
 * to the developer's own Bots, because `requireBotAccess` reads a missing answer as "not here".
 */
export function createDevRequireUser(
  botOwner?: BotOwnerLookup,
): MiddlewareHandler<{
  Variables: AppVariables;
}> {
  return async (context, next) => {
    context.set("actor", DEV_ACTOR);
    context.set("mayDriveBot", async (botId: string) =>
      actorMayDriveBot(DEV_ACTOR, botOwner ? await botOwner(botId) : undefined),
    );
    await next();
  };
}
