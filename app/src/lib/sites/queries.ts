import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";

/**
 * What the 사이트 연결 section asks the server, and nothing else.
 *
 * Three calls, and the important one is not here: opening the login page goes through
 * `POST /api/computers/:botId/navigate`, the ordinary governed and audited door to a Bot's browser
 * — see `openSite` below. This module holds no words; every sentence a person reads about these
 * results is chosen in the component, in Korean.
 */

/** One row of `laf_site_connections`, as the browser sees it. */
export type SiteConnection = {
  siteId: string;
  /** Whose browser the session was last seen in. A browser profile is per Bot. */
  botId: string;
  connectedAt: string;
  lastSeenAt: string;
  /** The last look found the login wall instead of the shop. */
  needsLogin: boolean;
};

export const siteKeys = {
  all: ["sites"] as const,
  connections: () => ["sites", "connections"] as const,
};

export function siteConnectionsQueryOptions() {
  return queryOptions({
    queryKey: siteKeys.connections(),
    queryFn: async (): Promise<SiteConnection[]> => {
      const response = await fetch("/api/sites/connections", {
        credentials: "include",
      });
      /*
       * A deployment with no computer does not mount these routes, and that is not an error worth a
       * red line across somebody's settings screen — every card simply reads "아직 연결 안 됨",
       * which is true. A real failure still throws, so a broken deployment does not masquerade as an
       * empty one.
       */
      if (response.status === 404) return [];
      if (!response.ok)
        throw new Error(
          t("Could not load the connected sites. Refresh to try again."),
        );
      return ((await response.json()) as { connections: SiteConnection[] })
        .connections;
    },
  });
}

/**
 * Why opening the login page did not happen, in facts.
 *
 * Three genuinely different situations, and telling them apart is the difference between a button
 * that looks broken and one that explains itself: the boundary refused this address, a person has
 * to answer a question first, or the browser could not be reached at all.
 */
export type OpenSiteOutcome =
  | { ok: true }
  | { ok: false; kind: "refused" | "awaiting" | "unreachable" };

/**
 * Send the Bot's browser to a site's login page.
 *
 * THE SAME ROUTE THE BOT'S OWN NAVIGATION TAKES. A person pressing 연결 is opening a page on the
 * Bot's computer, which is exactly the act the boundary governs and the trail records; a private
 * side door for "safe" addresses would be a way past a control that the person's own screen offered
 * them, and it would be invisible in the audit trail afterwards.
 */
export async function openSite(
  botId: string,
  url: string,
): Promise<OpenSiteOutcome> {
  let response: Response;
  try {
    response = await fetch(
      `/api/computers/${encodeURIComponent(botId)}/navigate`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      },
    );
  } catch {
    return { ok: false, kind: "unreachable" };
  }
  if (response.ok) return { ok: true };
  if (response.status === 403) return { ok: false, kind: "refused" };
  if (response.status === 409) return { ok: false, kind: "awaiting" };
  return { ok: false, kind: "unreachable" };
}

/**
 * Ask the server to look at the page the browser is on and say whether it reads as signed in.
 *
 * Called on the way back from a handoff. Returns null when the deployment has no such surface or
 * the browser could not be read — the card then keeps saying what it said, which is better than
 * announcing a login failure that never happened.
 */
export async function checkSiteConnection(
  siteId: string,
  botId: string,
): Promise<{ signedIn: boolean; connection: SiteConnection | null } | null> {
  const response = await fetch(
    `/api/sites/${encodeURIComponent(siteId)}/check`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId }),
    },
  );
  if (!response.ok) return null;
  return (await response.json()) as {
    signedIn: boolean;
    connection: SiteConnection | null;
  };
}
