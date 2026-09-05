import { queryOptions } from "@tanstack/react-query";
import { DEFAULT_BOT_SEATS } from "@/lib/agents/seats";

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
 * Two booleans, and each one decides whether a control exists at all. `effort` false means the model
 * this deployment serves takes no effort setting. `autoReview` false means it cannot judge a "do not
 * ask me about" instruction — the server asked it a trivial question and did not get a readable
 * answer in time. Either one drawn anyway is a control that saves, shows its state, and reaches
 * nothing, which is worse than not having it: the person most likely to use it is the one who most
 * needs it to work.
 *
 * The surface has no other way to know. It is never told which model this deployment serves, and
 * knowing which model names reason is not a thing a form should have to know.
 */
export type Deployment = {
  effort: boolean;
  autoReview: boolean;
  /**
   * How many Bots this person's computer seats.
   *
   * A number rather than a control, and the roster draws it as "내 봇 3/5" whether or not anybody
   * is near it — a cap somebody meets for the first time when they are refused is a cap they were
   * never told about. `BOT_SEATS_PER_ACCOUNT` is a deployment's to change, so the surface asks
   * rather than writing five into its own prose.
   */
  seats: number;
};

/** The signed-in person, and what the deployment they are on can do. */
export type CurrentUser = AuthenticatedUser & { deployment: Deployment };

export const authKeys = {
  all: ["auth"] as const,
  currentUser: () => [...authKeys.all, "current-user"] as const,
};

/**
 * The server did not answer in a way this app can use. Not the same as signed out.
 *
 * A distinct value rather than a thrown error, because throwing here cannot work: every route in
 * the app asks this question in `beforeLoad`, and a rejected `beforeLoad` does not reach any error
 * screen — measured, on this router version, against a build where `notFoundComponent` renders
 * fine. Worse, converting the rejection to a redirect inside `beforeLoad` loops: the router
 * restarts the load, the query is still in its error state, it rejects again. The observed shape
 * was /api/me requested six times and aborted six times, and a white page that never resolved.
 *
 * Resolving instead of rejecting is what breaks the loop. The answer is cached like any other, the
 * redirect fires once, and the screen that explains it renders.
 */
export const UNREACHABLE = "unreachable";

export type CurrentUserResult = CurrentUser | null | typeof UNREACHABLE;

async function currentUser(): Promise<CurrentUserResult> {
  let response: Response;
  try {
    response = await fetch("/api/me", { credentials: "include" });
  } catch {
    // No response at all: offline, DNS, or a proxy that closed the connection.
    return UNREACHABLE;
  }

  if (response.status === 401) {
    return null;
  }
  /*
   * NOT SIGNED IN AND CANNOT BE ARE THE SAME ANSWER HERE.
   *
   * A deployment with no sign-in configured answers 503 on every authenticated route, which is
   * exactly the state a first deployment is in before its OAuth client exists. The sign-in screen
   * already knows how to say that no providers are configured, in Korean, so the job is only to
   * let somebody reach it. This 503 is ours; a proxy with nothing behind it answers 502.
   */
  if (response.status === 503) {
    return null;
  }
  if (!response.ok) {
    return UNREACHABLE;
  }

  const body = (await response.json()) as {
    user: AuthenticatedUser;
    deployment?: Partial<Deployment>;
  };
  // Absent reads as yes, field by field, matching the server's own default: a server that does not
  // say is far more likely to be one that has both than one that has neither, and the failure of
  // guessing wrong here is a control that is missing rather than a control that lies.
  return {
    ...body.user,
    deployment: {
      effort: body.deployment?.effort !== false,
      autoReview: body.deployment?.autoReview !== false,
      // A server that does not say seats the product's five, which is what every deployment that
      // has not been told otherwise actually does.
      seats:
        typeof body.deployment?.seats === "number" && body.deployment.seats > 0
          ? body.deployment.seats
          : DEFAULT_BOT_SEATS,
    },
  };
}

export function currentUserQueryOptions() {
  return queryOptions({
    queryKey: authKeys.currentUser(),
    queryFn: currentUser,
    staleTime: 60_000,
    /*
     * Screens never see UNREACHABLE, because a screen only renders once a route decided there is
     * somebody to show it to. `select` is a render-time transform, so `ensureQueryData` in the
     * route guards still receives the raw answer and can act on it — one query, and the union
     * exists exactly where the decision is made.
     */
    select: (result: CurrentUserResult): CurrentUser | null =>
      result === UNREACHABLE ? null : result,
  });
}
