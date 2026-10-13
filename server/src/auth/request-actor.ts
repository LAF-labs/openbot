import { DEV_ACTOR } from "./dev-actor";
import type { RoleRepository } from "./guards";
import type { createAuth } from "./index";
import type { UserRole } from "./roles";
import type { SessionAdmission } from "./session-revocation";

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
   * live-screen upgrade, and the runtime's thread routes until they closed (2026-10-06) — which
   * refuse rather than guess.
   */
  resolveOrNull: (request: Request) => Promise<RequestActor | null>;
};

/*
 * `identify` — the id-and-role projection, with a fallback to somebody who owns nothing — is gone
 * (2026-10-13). It ran inside the CopilotKit runtime's agent factory and then behind the roster
 * route that replaced it (`/api/copilotkit/info`), where a throw was a 500; that route went with
 * the app's library, and what is left refuses rather than guesses.
 */

/*
 * `identifyUser` — the name-and-id projection of the resolver — is gone. Its one caller was the
 * live-screen upgrade, which needed the ROLE it dropped in order to ask whose Bot was being
 * watched. `resolve` is called there directly now, and there was nothing else a name-without-a-role
 * was for.
 */

/**
 * Who is asking, for the request `requireUser` never sees: the WebSocket upgrade, which Bun hands
 * over before Hono runs. (CopilotKit's runtime, which resolved its agents inside a vendored
 * factory, was the other until it left the server on 2026-10-13.)
 */
export function createRequestActors(input: {
  devNoAuth: boolean;
  /** Absent on a deployment without sign-in, where only `devNoAuth` admits anybody. */
  auth: ReturnType<typeof createAuth> | undefined;
  roles: Pick<RoleRepository, "rolesForUser">;
  /**
   * The same question `requireUser` asks of every request, asked at the door it never sees: the
   * live-screen upgrade is not behind `requireUser`, and it is the socket a person watches their
   * Bot's screen through.
   */
  admission?: Pick<SessionAdmission, "admits" | "revoke">;
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
      throw new Error("This request requires a signed-in user.");
    }
    if (input.admission && !input.admission.admits(user.email)) {
      // Revoked here too, not only refused: the next request from this person anywhere is told why.
      await input.admission.revoke(user.id, "sign_in_list");
      throw new Error("This request requires an admitted user.");
    }
    const roles = await input.roles.rolesForUser(user.id);
    if (!roles.includes("admin") && !roles.includes("user")) {
      throw new Error("This request requires an authorized user.");
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
  };
}
