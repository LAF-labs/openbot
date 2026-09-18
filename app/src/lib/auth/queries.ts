import type { ShopProfile } from "@shared/shop/catalogue";
import { queryOptions } from "@tanstack/react-query";
import { DEFAULT_BOT_SEATS } from "@/lib/agents/seats";
import { parseShop } from "@/lib/shop/catalogue";
import { SESSION_REVOKED } from "./session-revoked";

export type AuthenticatedUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role: "admin" | "user";
  /** False until they have been through onboarding and their first Bot exists. */
  onboarded: boolean;
  /**
   * True when the terms and the privacy policy must be agreed to before anything else is drawn:
   * the deployment records consent, and this person's recorded version is not the current one —
   * which includes never having agreed at all. False on a deployment that records nothing, for
   * the same reason `onboarded` defaults to true there: a screen demanding an agreement the server
   * cannot keep is a wall with nothing behind it.
   */
  consentRequired: boolean;
  /**
   * What kind of business this person runs and where they work every day, as they answered on the
   * first run or in Settings → 내 가게. Catalogue keys only; the words are this surface's. The empty
   * answer when nothing was answered, and on a deployment that keeps none.
   */
  shop: ShopProfile;
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
  /**
   * A free trial, as the server described it — absent on every deployment that is not one, and then
   * no banner exists to draw. See `components/layout/trial-banner.tsx`.
   */
  trial?: Trial;
};

/** A free trial's four facts (`GET /api/me` → `deployment.trial`, self-serve contract §4.6). */
export type Trial = {
  /** ISO-8601 in UTC: the end of the trial's last day in Seoul. */
  endsAt: string;
  /** How long a stopped trial is kept before it is destroyed. */
  holdDays: number;
  /** What a Seoul day may spend, in tokens. */
  dailyTokenBudget: number;
  /** Whether today's is spent: the next question will be refused until midnight in Seoul. */
  budgetReachedToday: boolean;
  /**
   * What today has used, in tokens, by the same count the budget is judged on. Absent when the
   * server could not read it — and then nothing is drawn, rather than an empty meter that would
   * say plenty was left on a day that may be one question from the limit.
   */
  tokensUsedToday?: number;
};

/**
 * A trial out of what the server sent, or none.
 *
 * All four or nothing, like the server's own reading of `.env`: a banner drawn from half a trial
 * would count down to a date nobody set, and a missing key is exactly what a deployment that is not
 * a trial sends.
 */
export function parseTrial(value: unknown): Trial | undefined {
  if (!value || typeof value !== "object") return undefined;
  const {
    endsAt,
    holdDays,
    dailyTokenBudget,
    budgetReachedToday,
    tokensUsedToday,
  } = value as Record<string, unknown>;
  if (
    typeof endsAt !== "string" ||
    typeof holdDays !== "number" ||
    typeof dailyTokenBudget !== "number" ||
    typeof budgetReachedToday !== "boolean"
  ) {
    return undefined;
  }
  // Optional, unlike the four: a count that is not one drops the meter, never the whole trial.
  const used =
    typeof tokensUsedToday === "number" &&
    Number.isFinite(tokensUsedToday) &&
    tokensUsedToday >= 0
      ? { tokensUsedToday }
      : {};
  return { endsAt, holdDays, dailyTokenBudget, budgetReachedToday, ...used };
}

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

/**
 * The server answered, and said no.
 *
 * A session that is valid and a person the deployment no longer admits — removed as a member after
 * signing in (`server/src/auth/guards.ts`, the role check). MEASURED 2026-09-10: this landed on the
 * "cannot reach the server" screen, which told somebody whose access had been taken away that the
 * server was down and it would clear on its own. It will not. Its own answer, its own screen.
 */
export const FORBIDDEN = "forbidden";

/**
 * The server answered, and said this session was taken away — not that it expired.
 *
 * Its own value because it is its own sentence: somebody struck off the sign-in list, or removed by
 * an administrator, lands on the door being told so (`load-current-user.ts`). Read by the plain 401
 * it came with, it was the door with nothing on it, which is what an ordinary expiry looks like.
 */
export const REVOKED = "revoked";

export type CurrentUserResult =
  | CurrentUser
  | null
  | typeof UNREACHABLE
  | typeof FORBIDDEN
  | typeof REVOKED;

/** The `code` of a JSON refusal, or null for a body that has none or is not JSON. */
async function refusalCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { code?: unknown } | null;
    return typeof body?.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

async function currentUser(): Promise<CurrentUserResult> {
  let response: Response;
  try {
    response = await fetch("/api/me", { credentials: "include" });
  } catch {
    // No response at all: offline, DNS, or a proxy that closed the connection.
    return UNREACHABLE;
  }

  if (response.status === 401) {
    return (await refusalCode(response)) === SESSION_REVOKED ? REVOKED : null;
  }
  /*
   * NOT SIGNED IN AND CANNOT BE ARE THE SAME ANSWER HERE.
   *
   * A deployment with no sign-in configured answers 503 on every authenticated route, which is
   * exactly the state a first deployment is in before its OAuth client exists. The sign-in screen
   * already knows how to say that no providers are configured, in Korean, so the job is only to
   * let somebody reach it.
   *
   * BUT NOT EVERY 503 IS OURS. The front door answers 503 `laf:api_unreachable` when there is no API
   * behind it at all (`app/Caddyfile`, `handle_errors`) — it used to be an empty 502, which the line
   * below this block already read as unreachable. Read by status alone, the new answer would send
   * somebody who is signed in to the sign-in screen for the length of every restart. So the code
   * decides, and the status only when there is no code.
   */
  if (response.status === 503) {
    return (await refusalCode(response)) === "laf:api_unreachable"
      ? UNREACHABLE
      : null;
  }
  if (response.status === 403) {
    return FORBIDDEN;
  }
  if (!response.ok) {
    return UNREACHABLE;
  }

  const body = (await response.json()) as {
    user: Omit<AuthenticatedUser, "consentRequired" | "shop"> & {
      shop?: unknown;
    };
    deployment?: Partial<Omit<Deployment, "trial">> & { trial?: unknown };
    /** Two facts and no verdict; the verdict is drawn here. Absent when nothing records it. */
    consent?: { version: string | null; current: string };
  };
  const trial = parseTrial(body.deployment?.trial);
  // Absent reads as yes, field by field, matching the server's own default: a server that does not
  // say is far more likely to be one that has both than one that has neither, and the failure of
  // guessing wrong here is a control that is missing rather than a control that lies.
  return {
    ...body.user,
    // Read forgivingly: a deployment that keeps no answers sends no key, and that is no answer.
    shop: parseShop(body.user.shop),
    consentRequired:
      body.consent !== undefined &&
      body.consent.version !== body.consent.current,
    deployment: {
      effort: body.deployment?.effort !== false,
      autoReview: body.deployment?.autoReview !== false,
      // A server that does not say seats the product's five, which is what every deployment that
      // has not been told otherwise actually does.
      seats:
        typeof body.deployment?.seats === "number" && body.deployment.seats > 0
          ? body.deployment.seats
          : DEFAULT_BOT_SEATS,
      ...(trial ? { trial } : {}),
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
      result === UNREACHABLE || result === FORBIDDEN || result === REVOKED
        ? null
        : result,
  });
}
