/**
 * ONE HONEST READING OF REMOTE DATA, SO EVERY SCREEN SAYS THE SAME THING ABOUT THE SAME FACTS.
 *
 * Every screen used to read its query its own way — `isPending` here, `isError && !data` there,
 * `data ?? []` somewhere else — and each way had its own hole. MEASURED 2026-09-18 on a built app,
 * before this module: the roster said 아직 봇이 없습니다 when `/api/agents` failed; a Bot's profile
 * said 아직 없습니다 about what it had learned when its memories could not be read, and said the
 * same to the server's `laf:not_found` for a deployment with no memory store — the one thing that
 * 404 exists to prevent; a refetch that failed over a Bot's profile replaced the whole profile with
 * a red line; and Routines drew a red alert over the rows it was still showing. The connections
 * screen's comments record the same lesson being learnt once more, by hand, on one screen.
 *
 * So a query's facts go through one pure function and come out as exactly one of five answers, and a
 * screen draws that answer and reads nothing else:
 *
 *   - `loading`     nothing to show yet;
 *   - `ready`       data to show;
 *   - `empty`       it has been read, and there is nothing — a claim, so only made after an answer;
 *   - `unavailable` this place or this account cannot have it: a closed refusal (below). Asking
 *                   again changes nothing, so nothing on screen offers to;
 *   - `failed`      it could not be read. What was read before is kept, so a screen can go on
 *                   showing it with a quiet line saying it could not be refreshed — a dropped
 *                   connection for a second must not blank a working screen.
 *
 * The section boundaries (`components/layout/section-boundary.tsx`) are for what nobody expected —
 * a render that threw. Everything here is expected, and is said in the screen's own words instead.
 */

/** Why something cannot be had here, as far as the server has said. */
export type Unavailability = "not_configured" | "not_allowed";

/**
 * THE REFUSALS THAT MEAN "NOT HERE", AND ONLY THOSE — every one a code the server sends, never a
 * status guessed at. `reading.test.ts` walks `server/src` for each of them.
 *
 * Every other failure — a 500, a proxy's 502 or 503 (`laf:api_unreachable`, `app/Caddyfile`), a
 * fetch that never got an answer, a body with no code — is `failed`: the kind of thing that can
 * come right, and so the kind a 다시 시도 button is honest in front of.
 */
export const UNAVAILABLE_REFUSALS: Readonly<Record<string, Unavailability>> = {
  /*
   * Nothing is mounted at that path on this deployment (`app.notFound` in `server/src/app.ts`) — a
   * route whose store this deployment was started without. The memories route answers a deployment
   * without the memory store the same way, on purpose (`server/src/agents/routes.ts`).
   */
  "laf:not_found": "not_configured",
  // No sign-in is configured at all, so nobody can be asked who they are (`server/src/app.ts`).
  "laf:auth_not_configured": "not_configured",
  /*
   * The four every route can answer before it does anything (`server/src/auth/guards.ts`,
   * `session-revocation.ts`). The first two take the person to the door as well (`session-watch.ts`);
   * the screen still must not offer a retry in the moment before it goes.
   */
  "laf:unauthenticated": "not_allowed",
  "laf:session_revoked": "not_allowed",
  "laf:no_access": "not_allowed",
  "laf:admin_required": "not_allowed",
};

/** What a screen draws once something has been read: the data, and whether it is nothing. */
export type Settled<T> =
  | { state: "ready"; data: T }
  | { state: "empty"; data: T };

export type Reading<T> =
  | { state: "loading" }
  | Settled<T>
  | { state: "unavailable"; code: string; why: Unavailability }
  | {
      state: "failed";
      /** What was read before, drawn the way it was drawn then. Null when nothing ever was. */
      previous: Settled<T> | null;
      /** Asked again and not answered yet: the button that asks is busy. */
      isRetrying: boolean;
    };

/**
 * The part of a TanStack query this is made from — a `useQuery` result is one, and a test hands the
 * four facts without a query at all.
 */
export type QueryFacts<T> = {
  status: "pending" | "error" | "success";
  fetchStatus: "fetching" | "paused" | "idle";
  data: T | undefined;
  error: unknown;
};

export type ReadingOptions<T> = {
  /** Whether what arrived is nothing. A list is nothing when it is empty; anything else never is. */
  isEmpty?: (data: T) => boolean;
  /**
   * Refusals that mean "not here" for THIS read only, beside the shared ones — a Bot's own
   * `laf:agent_not_found`, which is the same answer for "deleted" and "not yours" on purpose.
   */
  unavailable?: Readonly<Record<string, Unavailability>>;
};

/** The `laf:` code a thrown error carries, whatever class threw it. */
export function refusalCodeOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const { code } = error as { code?: unknown };
  return typeof code === "string" && code.startsWith("laf:") ? code : null;
}

const isEmptyList = (data: unknown) => Array.isArray(data) && data.length === 0;

function settle<T>(data: T, isEmpty: (data: T) => boolean): Settled<T> {
  return isEmpty(data) ? { state: "empty", data } : { state: "ready", data };
}

/**
 * A query's facts, read as one answer.
 *
 * `fetchStatus` is read only where it decides something. A `useQuery` result re-renders its
 * component for each property the component has read, and a screen that never needed to know a
 * background refetch had started should not be drawn again twice for every one.
 */
export function readingOf<T>(
  query: QueryFacts<T>,
  { isEmpty = isEmptyList, unavailable }: ReadingOptions<T> = {},
): Reading<T> {
  const { status, data } = query;

  if (status === "error") {
    /*
     * "NOT HERE" OUTRANKS WHAT WAS READ BEFORE. An account this place no longer admits must not go
     * on being shown what it held, and a route that is not mounted is not coming back on a retry.
     */
    const code = refusalCodeOf(query.error);
    const why = code
      ? (unavailable?.[code] ?? UNAVAILABLE_REFUSALS[code])
      : null;
    if (code && why) return { state: "unavailable", code, why };
    return {
      state: "failed",
      previous: data === undefined ? null : settle(data, isEmpty),
      isRetrying: query.fetchStatus === "fetching",
    };
  }

  if (data !== undefined) return settle(data, isEmpty);

  /*
   * PAUSED IS NOT LOADING. With the machine offline, TanStack Query does not fail a first read — it
   * parks it, `pending` and `paused`, for as long as the network is gone. Read as loading, that is a
   * skeleton pulsing all afternoon on a shop PC whose wifi dropped; it is a read that could not be
   * made, and it says so.
   */
  if (query.fetchStatus === "paused") {
    return { state: "failed", previous: null, isRetrying: false };
  }
  return { state: "loading" };
}

/**
 * `readingOf`, as the hook a screen calls.
 *
 * FOR THE REACT COMPILER'S SAKE, NOT REACT'S: nothing here needs a hook. The compiler assumes a plain
 * function may change what it is handed, so a reading made by `readingOf` and then handed on — to
 * `settledOf`, to a screen's own notice — counted as still changing when a `useMemo` further down
 * read from it, and the compiler left the whole component uncompiled. Measured on `BotSidebar`:
 * five "existing memoization could not be preserved", one per `useMemo`. What a hook returns is
 * taken as settled — which a reading is.
 */
export function useReading<T>(
  query: QueryFacts<T>,
  options?: ReadingOptions<T>,
): Reading<T> {
  return readingOf(query, options);
}

/**
 * What to draw as the data: the answer itself, or — when refreshing it failed — what was read
 * before. Null while there is nothing to draw.
 */
export function settledOf<T>(reading: Reading<T>): Settled<T> | null {
  if (reading.state === "ready" || reading.state === "empty") return reading;
  if (reading.state === "failed") return reading.previous;
  return null;
}

/** A read that failed with nothing from before to show in its place. */
export function hasFailedOutright<T>(reading: Reading<T>): boolean {
  return reading.state === "failed" && reading.previous === null;
}

/** A read that failed over something already on screen, which goes on being shown. */
export function isStale<T>(reading: Reading<T>): boolean {
  return reading.state === "failed" && reading.previous !== null;
}
