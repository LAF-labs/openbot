/**
 * One request for the whole 연결 screen.
 *
 * WHY IT EXISTS. The screen asks the same question in three shapes — an account consented to at a
 * vendor, a service LAF holds the contract for, a site somebody logs into on the Bot's own browser
 * — and it used to ask four endpoints on mount to find out. Four answers arriving separately is
 * four moments the page redraws with half of itself still guessing, and the sites half guessed
 * "아직 연결 안 됨" fifteen times before its answer landed, which is a statement and not a
 * placeholder. So the composition happens here, once, and the surface draws when it has the facts.
 *
 * THE FOUR OLD ENDPOINTS STAY. `/api/plugins/connections`, `/api/partners`, `/api/sites/connections`
 * and `/api/agents` are each still the door for something else — the admin Plugins page, a partner
 * card refreshing after a step, the site check on the way back from a handoff. This is a reader over
 * them, not a replacement, and nothing here writes.
 *
 * FACTS ONLY, AND FEWER OF THEM THAN THE PARTS SEND. No scope string (the surface says what a
 * connection lets a Bot do in its own Korean, from its own table), no token, no address anybody
 * typed. The mall id a person typed for Cafe24 does cross, because it is what the row shows them
 * back as their own shop and it is on that shop's address bar anyway.
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { BUSINESS_SITES } from "../../../shared/sites/catalogue";
import type { AppVariables } from "../auth/guards";
import type { SiteConnectionStore } from "../computer/site-connections";
import type { CatalogueEntry } from "./catalogue";
import type { PartnerRuntime } from "./partners";
import type { PluginStore } from "./store";

/** Whether a connection this deployment holds is still usable. */
export type ConnectionHealth = {
  status: "ok" | "needs_reconnect";
  lastOkAt: string | null;
  lastFailureAt: string | null;
  /** The `laf:` fact behind a refusal, when one is known. Never a sentence. */
  failureCode: string | null;
};

export type OverviewAccount =
  | {
      kind: "oauth";
      id: string;
      /** The server row this deployment made on the press, or null before there is one. */
      serverId: string | null;
      title: string;
      vendor: string;
      status: "not_connected" | "connected" | "needs_reconnect";
      connectedAt: string | null;
      /** What the row shows as whose account this is. A Cafe24 mall id, or nothing. */
      account: string | null;
      /** True for a vendor that gives every customer their own hostname. */
      needsInstanceName: boolean;
      health: ConnectionHealth;
    }
  | {
      kind: "partner";
      id: string;
      status: "not_connected" | "connected";
      /** Exactly what `GET /api/partners/:provider` answers with, so one shape decides the card. */
      partner: { status: unknown };
    };

export type OverviewSite = {
  id: string;
  status: "not_connected" | "connected" | "needs_login";
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

/**
 * Where each part of the answer comes from.
 *
 * Functions rather than the whole services, because the composition is the only thing worth pinning
 * here and a test that had to stand up a plugin store, a partner runtime and a profile store to
 * prove a row is hidden would be testing those instead.
 */
export type ConnectionsOverviewSources = {
  /** The entries this deployment can actually finish a consent for, in catalogue order. */
  catalogue: () => CatalogueEntry[];
  store: Pick<PluginStore, "connectionsFor" | "listServers">;
  /** Null on a deployment holding no partner key at all, and then no partner row is drawn. */
  partners: Pick<PartnerRuntime, "configured" | "alimtalk"> | null;
  /** Null where no computer is configured, so no site could be holding a session. */
  sites: Pick<SiteConnectionStore, "list"> | null;
  /** This person's Bots, name and id and nothing else. */
  bots: (userId: string) => Promise<{ id: string; name: string }[]>;
};

/**
 * A connection row as this reader takes it, with the health another part of the server may add.
 *
 * Optional on purpose: the field is being introduced alongside this and a reader that required it
 * would fail closed on every deployment that has not got it yet — as "다시 연결 필요" on every
 * healthy account, which is the worst possible way to be wrong about a connection.
 */
type HeldConnection = {
  serverId: string;
  connectedAt: string;
  health?: unknown;
};

const ISO = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

/** What a connection's health says, or the healthy reading when nothing says anything. */
function healthOf(row: HeldConnection | undefined): ConnectionHealth {
  const said = (row?.health ?? null) as Record<string, unknown> | null;
  const status = said?.status === "needs_reconnect" ? "needs_reconnect" : "ok";
  return {
    status,
    lastOkAt: ISO(said?.lastOkAt),
    lastFailureAt: ISO(said?.lastFailureAt),
    failureCode:
      typeof said?.failureCode === "string" && said.failureCode
        ? said.failureCode
        : null,
  };
}

/**
 * The first label of a stored per-instance URL — the mall id somebody typed, read back.
 *
 * Only for an entry that HAS one, the same guard `plugins/routes.ts` learned the hard way: every
 * hostname has a first label, so reading it unconditionally answers "sheets" for Google Sheets — a
 * name the person never typed, shown back to them as their own shop.
 */
function instanceNameOf(
  entry: CatalogueEntry,
  url: string | undefined,
): string | null {
  if (entry.host !== null || !url) return null;
  try {
    return new URL(url).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

/**
 * The composition itself, apart from the route, because a second reader needs the same facts.
 *
 * The routine suggestions (`routines/suggestions.ts`) decide what to offer from what a person has
 * connected, and "connected" has to mean what this screen says it means — a site row that is
 * `needs_login` is not a connection a routine can run on. Reading the four parts again over there
 * would be a second opinion about the same rows; this is the one.
 */
export async function readConnectionsOverview(
  sources: ConnectionsOverviewSources,
  userId: string,
): Promise<ConnectionsOverview> {
  const held: HeldConnection[] = await sources.store.connectionsFor(userId);
  const stored = await sources.store.listServers();
  const byServerId = new Map(held.map((row) => [row.serverId, row]));

  const accounts: OverviewAccount[] = sources.catalogue().map((entry) => {
    const connection = byServerId.get(entry.key);
    const health = healthOf(connection);
    const row = stored.find((server) => server.id === entry.key);
    return {
      kind: "oauth",
      id: entry.key,
      serverId: row?.id ?? null,
      title: entry.title,
      vendor: entry.vendor,
      status: connection
        ? health.status === "needs_reconnect"
          ? "needs_reconnect"
          : "connected"
        : "not_connected",
      connectedAt: connection ? ISO(connection.connectedAt) : null,
      account: instanceNameOf(entry, row?.url),
      needsInstanceName: entry.host === null,
      health,
    };
  });

  /*
   * Only the partners this machine actually holds a key for. A row for one it does not is a
   * switch that could only ever 503, which is the same lie as a 연결 button in front of a vendor
   * with no application behind it.
   */
  const partners = sources.partners;
  for (const provider of partners?.configured ?? []) {
    const connector = partners?.alimtalk;
    if (!connector) continue;
    const status = (await connector.status(userId)) as {
      connected?: unknown;
    };
    accounts.push({
      kind: "partner",
      id: provider,
      status: status?.connected === true ? "connected" : "not_connected",
      partner: { status },
    });
  }

  /*
   * NO COMPUTER, NO SITES — an empty list rather than fifteen rows saying "아직 연결 안 됨".
   *
   * The difference is what the screen can do with it: an empty list hides the section, and
   * fifteen not-connected rows are fifteen switches whose only possible outcome is a refusal from
   * a browser that does not exist on this deployment.
   */
  const siteRows = sources.sites ? await sources.sites.list(userId) : null;
  const bySiteId = new Map((siteRows ?? []).map((row) => [row.siteId, row]));
  const sites: OverviewSite[] = (siteRows === null ? [] : BUSINESS_SITES).map(
    (site) => {
      const row = bySiteId.get(site.id);
      return {
        id: site.id,
        status: !row
          ? "not_connected"
          : row.needsLogin
            ? "needs_login"
            : "connected",
        botId: row?.botId ?? null,
        lastSeenAt: row?.lastSeenAt ?? null,
        connectedAt: row?.connectedAt ?? null,
      };
    },
  );

  return {
    generatedAt: new Date().toISOString(),
    accounts,
    sites,
    bots: await sources.bots(userId),
  };
}

export function createConnectionsOverviewRoutes(
  sources: ConnectionsOverviewSources,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/overview", requireUser, async (context) =>
    context.json(await readConnectionsOverview(sources, context.var.actor.id)),
  );

  return routes;
}
