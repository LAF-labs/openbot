import { queryOptions } from "@tanstack/react-query";

export type AuthenticatedUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role: "admin" | "user";
  /** False until they have been through onboarding and their first Bot exists. */
  onboarded: boolean;
};

/**
 * What this deployment can do, as the app needs to know before it draws anything.
 *
 * One boolean so far. `effort` false means the model this deployment serves takes no effort
 * setting, so the control is not drawn — a slider that silently does nothing is worse than no
 * slider, and the surface has no other way to know: the model's name is never sent to it, and
 * knowing which names reason is not a thing a form should have to know.
 */
export type Deployment = {
  effort: boolean;
};

/** The signed-in person, and what the deployment they are on can do. */
export type CurrentUser = AuthenticatedUser & { deployment: Deployment };

export const authKeys = {
  all: ["auth"] as const,
  currentUser: () => [...authKeys.all, "current-user"] as const,
};

async function currentUser(): Promise<CurrentUser | null> {
  const response = await fetch("/api/me", { credentials: "include" });
  if (response.status === 401) {
    return null;
  }
  /*
   * NOT SIGNED IN AND CANNOT BE ARE THE SAME ANSWER HERE.
   *
   * A deployment with no sign-in configured answers 503 on every authenticated route, which is
   * exactly the state a first deployment is in before its OAuth client exists. Throwing sends the
   * router's beforeLoad into an unhandled rejection and renders nothing at all: the first thing
   * anybody saw after standing a deployment up was a blank white page. The sign-in screen already
   * knows how to say that no providers are configured, so the job here is only to let them reach it.
   */
  if (response.status === 503) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Could not load the current user (${response.status})`);
  }

  const body = (await response.json()) as {
    user: AuthenticatedUser;
    deployment?: Deployment;
  };
  // Absent reads as yes, matching the server's own default: an older server that does not say is
  // far more likely to be serving a model with an effort setting than one without.
  return { ...body.user, deployment: body.deployment ?? { effort: true } };
}

export function currentUserQueryOptions() {
  return queryOptions({
    queryKey: authKeys.currentUser(),
    queryFn: currentUser,
    staleTime: 60_000,
  });
}
