import type { IdentifyActor } from "../copilot";
import { DEV_ACTOR } from "./dev-actor";
import type { RoleRepository } from "./guards";
import type { createAuth } from "./index";
import type { UserRole } from "./roles";

/** A person, as a request that reached the server outside Hono's `requireUser` resolves them. */
export type RequestActor = { id: string; name: string; role: UserRole };

export type RequestActors = {
  /**
   * Who is asking, or a throw.
   *
   * One resolver, because a run has two questions to answer about the same person: whose threads
   * and memory these are, and which coworkers they may run. Answering them from different places is
   * how one person ends up running another's private coworker, or reading their thread.
   */
  resolve: (request: Request) => Promise<RequestActor>;
  /**
   * The same person, or null. For the reads that decide WHOSE data is about to be served — the
   * runtime's thread routes and the live-screen upgrade — which refuse rather than guess.
   */
  resolveOrNull: (request: Request) => Promise<RequestActor | null>;
  /** The authorization projection, with the anonymous fallback. See {@link ANONYMOUS_ACTOR}. */
  identify: IdentifyActor;
};

/**
 * The authorization projection of the same person: agent visibility is decided from this.
 *
 * THE FALLBACK IS NOT THE GUARD AND NEVER WAS. It used to be justified by `/info` answering an
 * anonymous deployment check; `/api/copilotkit/*` is behind `requireUser` now (app.ts), so no
 * unauthenticated request reaches this at all. What is left is the transient case — a session read
 * or a role lookup failing under an authenticated request — and it is kept here, and only here,
 * because this one runs INSIDE the vendored runtime's agent factory: throwing there takes the run
 * down with a 500, while resolving to somebody who owns nothing takes it down by name. It grants
 * nothing — no private profile matches, and it is not an administrator — and the two places that
 * decide whose data is served (the live-screen upgrade and the thread priming) refuse instead.
 */
const ANONYMOUS_ACTOR = { id: "", role: "user" } as const;

/*
 * `identifyUser` — the name-and-id projection of the resolver — is gone. Its one caller was the
 * live-screen upgrade, which needed the ROLE it dropped in order to ask whose Bot was being
 * watched. `resolve` is called there directly now, and there was nothing else a name-without-a-role
 * was for.
 */

/**
 * Who is asking, for the requests `requireUser` never sees: CopilotKit's runtime, which resolves its
 * agents inside a vendored factory, and the WebSocket upgrade, which Bun hands over before Hono runs.
 */
export function createRequestActors(input: {
  devNoAuth: boolean;
  /** Absent on a deployment without sign-in, where only `devNoAuth` admits anybody. */
  auth: ReturnType<typeof createAuth> | undefined;
  roles: Pick<RoleRepository, "rolesForUser">;
}): RequestActors {
  const resolve = async (request: Request): Promise<RequestActor> => {
    if (input.devNoAuth) {
      return { id: DEV_ACTOR.id, name: DEV_ACTOR.email, role: DEV_ACTOR.role };
    }
    const session = await input.auth?.api.getSession({
      headers: request.headers,
    });
    const user = session?.user;
    if (!user) {
      throw new Error("A CopilotKit run requires a signed-in user.");
    }
    const roles = await input.roles.rolesForUser(user.id);
    if (!roles.includes("admin") && !roles.includes("user")) {
      throw new Error("A CopilotKit run requires an authorized user.");
    }
    return {
      id: user.id,
      name: user.name ?? user.email ?? user.id,
      role: roles.includes("admin") ? "admin" : "user",
    };
  };

  return {
    resolve,
    resolveOrNull: (request) => resolve(request).catch(() => null),
    identify: async (request) => {
      try {
        const { id, role } = await resolve(request);
        return { id, role };
      } catch {
        return ANONYMOUS_ACTOR;
      }
    },
  };
}
