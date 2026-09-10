import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { BOT_ID_INVALID, isBotId } from "../computer/bot-id";
import type { Database } from "../db/client";
import { agentProfiles, agents, userRoles } from "../db/schema";
import type { UserRole } from "./roles";

export type AuthenticatedActor = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role: UserRole;
};

export type AuthService = {
  handler: (request: Request) => Response | Promise<Response>;
  api: {
    getSession: (input: {
      headers: Headers;
      query: { disableCookieCache: boolean };
    }) => Promise<{
      user: {
        id: string;
        email: string;
        name?: string | null;
        image?: string | null;
      };
    } | null>;
  };
};

/**
 * Whose a Bot is.
 *
 * A user id for a Bot somebody made; `null` for one nobody did — a Bot a package shipped, or an
 * `agents` row that never got a profile; `undefined` for a Bot this deployment does not have,
 * which a deleted one counts as. The three answers are kept apart because `actorMayDriveBot`
 * answers each differently, and a lookup that folded two of them together would decide by accident.
 */
export type BotOwner = string | null | undefined;

export type BotOwnerLookup = (botId: string) => Promise<BotOwner>;

/**
 * The two facts a guard asks the database for: what a person is, and whose a Bot is.
 *
 * `botOwner` is optional in the TYPE because nine suites stub the roles alone and none of them
 * reach a Bot — but a repository without it does not admit anybody to anything: `createRequireUser`
 * reads a missing lookup as "no such Bot", which refuses every non-administrator. The shipped
 * repository always has it, and `authorization-matrix.integration.test.ts` drives the real one.
 */
export type RoleRepository = {
  rolesForUser: (userId: string) => Promise<UserRole[]>;
  botOwner?: BotOwnerLookup;
};

export type AppVariables = {
  actor: AuthenticatedActor;
  /**
   * May the actor drive the named Bot — read its screen, press its controls, spend what it holds.
   *
   * Put beside the actor by `requireUser`, because the route factories that need to ask are handed
   * `requireUser` and nothing that can reach the database: `createComputerRoutes` takes a client, a
   * gateway and a policy, and none of those knows who owns what. Absent (a guard that only set the
   * actor) is read as "no" for anybody who is not an administrator — see `mayDriveBot`.
   */
  mayDriveBot?: (botId: string) => Promise<boolean>;
};

/** The fact a refused Bot answers with. The same word for "not yours" and "not here", deliberately. */
export const BOT_NOT_FOUND = "laf:bot_not_found";

/**
 * May this person act THROUGH this Bot?
 *
 * The rule `plugins/skills-and-grants.ts` wrote for tool calls, carried to every other door a Bot
 * id opens — the computer, its approvals, its routines, its live screen — so that they cannot
 * disagree. An administrator may; the owner may; a Bot nobody made is every signed-in person's,
 * because the only way it holds anything is an administrator giving it "for everybody here"; and
 * a Bot this deployment does not have is nobody's.
 *
 * VISIBILITY DOES NOT WIDEN THIS. The profile store's `get` lets a `public` Bot through to anybody,
 * which is right for a roster and was wrong for the live-screen socket that used it: being able to
 * see a Bot is not being able to type into the browser holding its owner's logins. This predicate
 * never reads visibility at all.
 */
export function actorMayDriveBot(
  actor: { id: string; role: UserRole },
  owner: BotOwner,
): boolean {
  if (actor.role === "admin") return true;
  if (owner === undefined) return false;
  return owner === null || owner === actor.id;
}

/**
 * Whose a Bot is, from the tables.
 *
 * `agents` first and the profile joined, rather than the profile alone: a Bot with an `agents` row
 * and no profile is one nobody made (`null`), while an id with no `agents` row is not a Bot at all
 * (`undefined`) — the two cases the predicate above keeps apart. A deleted profile is the second.
 */
export async function lookupBotOwner(
  database: Database,
  botId: string,
): Promise<BotOwner> {
  const [row] = await database
    .select({
      ownerUserId: agentProfiles.ownerUserId,
      deletedAt: agentProfiles.deletedAt,
    })
    .from(agents)
    .leftJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .where(eq(agents.id, botId))
    .limit(1);
  if (!row || row.deletedAt !== null) return undefined;
  return row.ownerUserId;
}

export function createRoleRepository(
  database: Database,
): Required<RoleRepository> {
  return {
    rolesForUser: async (userId) => {
      const records = await database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, userId));

      return records.map((record) => record.role);
    },
    botOwner: (botId) => lookupBotOwner(database, botId),
  };
}

export function createRequireUser(
  auth: AuthService,
  roleRepository: RoleRepository,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
      query: { disableCookieCache: true },
    });

    if (!session) {
      return context.json({ error: "Authentication required." }, 401);
    }

    const roles = await roleRepository.rolesForUser(session.user.id);
    const role = roles.includes("admin")
      ? "admin"
      : roles.includes("user")
        ? "user"
        : undefined;

    if (!role) {
      return context.json({ error: "Authorization required." }, 403);
    }

    const actor: AuthenticatedActor = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image,
      role,
    };
    context.set("actor", actor);
    context.set("mayDriveBot", async (botId: string) => {
      if (actor.role === "admin") return true;
      const owner = roleRepository.botOwner
        ? await roleRepository.botOwner(botId)
        : undefined;
      return actorMayDriveBot(actor, owner);
    });
    await next();
  };
}

/**
 * The question, asked from inside a handler that took the Bot from a body rather than the path.
 *
 * Refuses when nothing on the context can answer: a guard that put an actor there without saying
 * whose Bots they may drive is a stub or a guard written later, and either way a person it admitted
 * to somebody else's Bot would be the failure this exists to close.
 */
export async function mayDriveBot(
  context: Context<{ Variables: AppVariables }>,
  botId: string,
): Promise<boolean> {
  const actor = context.var.actor;
  if (actor.role === "admin") return true;
  const ask = context.var.mayDriveBot;
  return ask ? ask(botId) : false;
}

/**
 * The ownership rule as a middleware, for every route that names a Bot in its path.
 *
 * The SHAPE first, before any lookup, the way `streamBotAccess` does it: an id this deployment
 * could never have minted has no business reaching a query, and the routers that used to check
 * it inside each handler (approvals) or in a `use` of their own (the computer) now get the same
 * 400 from here, ahead of anything else. Then whose it is.
 *
 * A 404 and not a 403, and the same 404 for a Bot that is not there: the question "does this Bot
 * exist" is a fact about somebody else's roster, and a refusal that answered it would hand a
 * colleague the list of ids worth trying. The code is the fact; the surface owns the words.
 *
 * MUST COME AFTER `requireUser`, like `requireAdminRoute`: it reads the actor that guard put there.
 * And BEFORE `requireAdminRoute` where both apply, so that a Bot that is not yours is "not here"
 * whether or not the route behind it is an administrator's.
 */
export function requireBotAccess(
  param = "botId",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const botId = context.req.param(param) ?? "";
    if (!isBotId(botId)) {
      return context.json({ error: BOT_ID_INVALID, code: BOT_ID_INVALID }, 400);
    }
    if (!(await mayDriveBot(context, botId))) {
      return context.json({ error: BOT_NOT_FOUND, code: BOT_NOT_FOUND }, 404);
    }
    await next();
  };
}

export function requireAdmin(context: Context<{ Variables: AppVariables }>) {
  if (context.var.actor.role !== "admin") {
    return context.json({ error: "Administrator access required." }, 403);
  }

  return undefined;
}

/**
 * The same rule, as a middleware, for routes where it is the whole of the guard.
 *
 * `requireAdmin` returns a response the handler has to remember to return, and a handler that forgets
 * runs anyway — the check is a line of code in the middle of a function that does something else,
 * which is exactly where an unrelated edit drops it. As a middleware it sits in the route's own
 * declaration, beside `requireUser`, where it can be read without opening the body.
 *
 * MUST COME AFTER `requireUser`, which is what puts the actor on the context. Registered before it,
 * this reads an actor that is not there.
 */
export const requireAdminRoute: MiddlewareHandler<{
  Variables: AppVariables;
}> = async (context, next) => {
  const denied = requireAdmin(context);
  if (denied) return denied;
  await next();
};
