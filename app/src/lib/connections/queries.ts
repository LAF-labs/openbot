import { queryOptions } from "@tanstack/react-query";
import type { AlimtalkStatus, PartnerId } from "@/lib/partners/queries";

/**
 * The 연결 screen's one read.
 *
 * WHY ONE. The screen used to ask four endpoints on mount — the OAuth entries, the partners, the
 * site rows and the roster — and none of them said anything about the others. So it drew itself
 * four times, and the sites half spent the wait STATING "아직 연결 안 됨" fifteen times, which is
 * not a placeholder: somebody reading it while their answer was in flight was told their 배민
 * login had gone. One request, and the screen draws skeletons until it has the facts.
 *
 * THIS MODULE HOLDS NO WORDS. Every field here is a fact — connected or not, since when, whose
 * browser — and every sentence a person reads about them is written in the component, in Korean.
 * The server sends no scope string and no address anybody typed; what a connection lets a Bot do is
 * this surface's own table (`lib/plugins/catalogue-copy.ts`).
 */

/** Whether a connection this deployment holds is still usable. */
export type ConnectionHealth = {
  status: "ok" | "needs_reconnect";
  lastOkAt: string | null;
  lastFailureAt: string | null;
  /** The `laf:` fact behind a refusal. A code, never a sentence. */
  failureCode: string | null;
};

/** An account consented to at the vendor: one switch, one consent screen, done. */
export type OauthAccount = {
  kind: "oauth";
  id: string;
  serverId: string | null;
  /** The vendor's own brand name. Drawn through `t()` from the copy table, never as-is. */
  title: string;
  vendor: string;
  status: "not_connected" | "connected" | "needs_reconnect";
  connectedAt: string | null;
  /** Whose account, as far as this deployment knows it: a Cafe24 mall id, or nothing. */
  account: string | null;
  /** True for a vendor that gives every customer their own hostname. */
  needsInstanceName: boolean;
  health: ConnectionHealth;
};

/** A service the platform holds the contract for, where the shop registers its own thing under it. */
export type PartnerAccount = {
  kind: "partner";
  id: PartnerId;
  status: "not_connected" | "connected";
  partner: { status: AlimtalkStatus };
};

export type OverviewAccount = OauthAccount | PartnerAccount;

/** A site somebody logs into on a Bot's own browser. */
export type OverviewSite = {
  id: string;
  status: "not_connected" | "connected" | "needs_login";
  /** Whose browser the session was last seen in. A browser profile is per Bot. */
  botId: string | null;
  lastSeenAt: string | null;
  connectedAt: string | null;
};

export type ConnectionsOverview = {
  generatedAt: string;
  accounts: OverviewAccount[];
  sites: OverviewSite[];
  bots: { id: string; name: string }[];
};

export const connectionKeys = {
  all: ["connections"] as const,
  overview: () => ["connections", "overview"] as const,
};

/**
 * How often the screen re-asks while something is waiting on somebody else.
 *
 * A consent finishes in the person's OWN browser — in the desktop shell that is the whole point,
 * because Google refuses an embedded user agent outright — so this window gets no event at all when
 * it is over. Focus covers the ordinary path; this covers the one where the app window never lost
 * focus, which on a second monitor is the normal case.
 */
export const PENDING_POLL_MS = 3_000;

/**
 * How long that goes on before the screen stops asking.
 *
 * Not forever. A consent nobody finished is a tab somebody closed, and a page polling an endpoint
 * every three seconds for the rest of the day because of it is exactly the shape of thing that
 * shows up in a log as an outage. Five minutes, and then the 다시 확인 button is the way back.
 */
export const PENDING_WINDOW_MS = 5 * 60_000;

/**
 * The overview, and how often it is re-asked.
 *
 * `staleTime` is short rather than zero: crossing to this screen and back should not re-ask, and
 * fifteen seconds is under the time it takes to read one row. `isWaiting` is the only thing that
 * turns polling on — a screen that polled while nothing was pending would be a request every three
 * seconds for as long as somebody left the tab open on it.
 */
export function connectionsOverviewQueryOptions(isWaiting = false) {
  return queryOptions({
    queryKey: connectionKeys.overview(),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchInterval: isWaiting ? PENDING_POLL_MS : (false as const),
    // A hidden tab cannot see a consent finish, and its throttled timers only bank up requests.
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<ConnectionsOverview> => {
      const response = await fetch("/api/connections/overview", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("The connections could not be loaded.");
      return response.json();
    },
  });
}

/**
 * Whether anything on the screen is still waiting on somebody else.
 *
 * A pure function over the deadlines rather than a `setInterval` that clears state, because the
 * property worth pinning is that the polling STOPS: a window left open on a consent nobody finished
 * must go quiet on its own.
 */
export function isStillWaiting(
  waitingUntil: readonly number[],
  now = Date.now(),
): boolean {
  return waitingUntil.some((deadline) => deadline > now);
}

/** What each row is waiting on, by the account it belongs to. */
export type Waiting = Readonly<Record<string, number>>;

/**
 * One row starting, or stopping, its wait.
 *
 * BOTH DIRECTIONS AND THE SAME OBJECT BACK WHEN NOTHING CHANGED, and both halves were measured.
 * Reporting only the start left the screen polling every three seconds for the whole five minutes
 * after somebody pressed 취소 — forty requests to an endpoint with nothing new to say. And the rows
 * report from an effect, so returning a fresh object for an unchanged map would be a render loop.
 */
export function withWaiting(
  current: Waiting,
  accountId: string,
  until: number | null,
): Waiting {
  if (until === null) {
    if (!(accountId in current)) return current;
    const { [accountId]: gone, ...rest } = current;
    return rest;
  }
  return current[accountId] === until
    ? current
    : { ...current, [accountId]: until };
}

/**
 * Turn one site off.
 *
 * The row goes and the Bot stops being told there is a connection. The browser stays signed in —
 * the session is a cookie in its profile and nothing here can reach into it — which is why the
 * confirmation on the switch says so rather than letting the gesture imply otherwise.
 */
export async function forgetSite(siteId: string): Promise<boolean> {
  const response = await fetch(
    `/api/sites/${encodeURIComponent(siteId)}/connection`,
    { method: "DELETE", credentials: "include" },
  );
  if (!response.ok) throw new Error("That site could not be turned off.");
  const body = (await response.json().catch(() => null)) as {
    forgotten?: boolean;
  } | null;
  return body?.forgotten === true;
}
