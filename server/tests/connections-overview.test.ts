import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { CATALOGUE, type CatalogueEntry } from "../src/plugins/catalogue";
import {
  type ConnectionsOverview,
  type ConnectionsOverviewSources,
  createConnectionsOverviewRoutes,
} from "../src/plugins/overview-routes";

/**
 * The 연결 screen's one read: what it composes, whose rows it composes, and what it refuses to send.
 *
 * WHY THIS IS A COMPOSITION TEST AND NOT AN INTEGRATION ONE. Every part it reads is already tested
 * against a real Postgres somewhere else — `plugin-store.integration.test.ts` for the grants,
 * `partner-routes.test.ts` for the partner listing, `site-connections.test.ts` for the site rows.
 * What only THIS file can get wrong is the joining: a status decided from the wrong field, a
 * partner row drawn on a machine holding no key for it, somebody else's user id reaching a store,
 * and a scope string or a token riding along into a payload aimed at a shop owner's screen.
 *
 * THE PAYLOAD ASSERTION IS THE POINT OF THE WHOLE FILE. The four endpoints this reads from send
 * more than the screen needs — `/api/plugins/connections` sends the vendor's scope string verbatim
 * — and a composition that forwards everything it was handed is how a secret ends up on a surface
 * nobody meant to put it on. So the serialised answer is searched, rather than the fields being
 * checked one at a time and the ones nobody thought of going unlooked at.
 */

const OWNER = {
  id: "owner-user",
  email: "owner@laf.test",
  role: "user",
} as const;

/** A scope string of the kind `connectionsFor` really returns, so its absence means something. */
const A_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

const sheets = CATALOGUE.find((entry) => entry.key === "google-sheets");
const cafe24 = CATALOGUE.find((entry) => entry.key === "cafe24");
if (!sheets || !cafe24)
  throw new Error("The catalogue lost an entry this test names.");

type Held = {
  serverId: string;
  scope: string;
  connectedAt: string;
  health?: unknown;
};

function surface(
  overrides: {
    catalogue?: CatalogueEntry[];
    held?: Held[];
    servers?: { id: string; url: string }[];
    partners?: ConnectionsOverviewSources["partners"];
    sites?: ConnectionsOverviewSources["sites"];
    bots?: { id: string; name: string }[];
  } = {},
) {
  /** Every user id any source was asked about, so "own rows only" is measured and not assumed. */
  const askedAbout: string[] = [];

  const sources = {
    catalogue: () => overrides.catalogue ?? [sheets, cafe24],
    store: {
      connectionsFor: async (userId: string) => {
        askedAbout.push(userId);
        return overrides.held ?? [];
      },
      listServers: async () => (overrides.servers ?? []) as never,
    },
    partners: overrides.partners ?? null,
    sites: overrides.sites ?? null,
    bots: async (userId: string) => {
      askedAbout.push(userId);
      return overrides.bots ?? [];
    },
  } as unknown as ConnectionsOverviewSources;

  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", OWNER);
    await next();
  };

  const app = new Hono<{ Variables: AppVariables }>().route(
    "/api/connections",
    createConnectionsOverviewRoutes(sources, requireUser),
  );
  return { app, askedAbout };
}

const read = async (app: Hono<{ Variables: AppVariables }>) => {
  const response = await app.request("/api/connections/overview");
  return {
    response,
    body: (await response.json()) as ConnectionsOverview,
  };
};

describe("the 연결 screen's one read", () => {
  test("draws every connectable entry, connected or not", async () => {
    const { body } = await read(
      surface({
        held: [
          {
            serverId: "google-sheets",
            scope: A_SCOPE,
            connectedAt: "2026-09-01T09:00:00.000Z",
          },
        ],
      }).app,
    );

    expect(
      body.accounts.map((account) => [account.id, account.status]),
    ).toEqual([
      ["google-sheets", "connected"],
      ["cafe24", "not_connected"],
    ]);
    const sheetsRow = body.accounts[0];
    expect(sheetsRow?.kind).toBe("oauth");
    if (sheetsRow?.kind !== "oauth") throw new Error("unreachable");
    expect(sheetsRow.connectedAt).toBe("2026-09-01T09:00:00.000Z");
    // Absent health is the HEALTHY reading. Fail-closed here would put "다시 연결 필요" on every
    // working account of every deployment that has not grown the field yet.
    expect(sheetsRow.health).toEqual({
      status: "ok",
      lastOkAt: null,
      lastFailureAt: null,
      failureCode: null,
    });
  });

  test("a connection the server calls unhealthy reads as needing reconnection", async () => {
    const { body } = await read(
      surface({
        held: [
          {
            serverId: "google-sheets",
            scope: "",
            connectedAt: "2026-09-01T09:00:00.000Z",
            health: {
              status: "needs_reconnect",
              lastOkAt: "2026-09-01T09:00:00.000Z",
              lastFailureAt: "2026-09-04T06:00:00.000Z",
              failureCode: "laf:refresh_refused",
            },
          },
        ],
      }).app,
    );

    const row = body.accounts[0];
    if (row?.kind !== "oauth") throw new Error("unreachable");
    expect(row.status).toBe("needs_reconnect");
    expect(row.health.failureCode).toBe("laf:refresh_refused");
  });

  test("the mall id is read back only for the vendor that has one", async () => {
    const { body } = await read(
      surface({
        servers: [
          { id: "cafe24", url: "https://sunnymart.cafe24api.com/api/v2/mcp" },
          { id: "google-sheets", url: "https://sheets.googleapis.com/mcp" },
        ],
      }).app,
    );

    const rows = new Map(
      body.accounts.map((account) => [
        account.id,
        account.kind === "oauth" ? account : null,
      ]),
    );
    expect(rows.get("cafe24")?.account).toBe("sunnymart");
    expect(rows.get("cafe24")?.needsInstanceName).toBe(true);
    /*
     * "sheets" is the failure this guard exists for: every hostname has a first label, and reading
     * it unconditionally showed a person a name they never typed as though it were their own shop.
     */
    expect(rows.get("google-sheets")?.account).toBe(null);
    expect(rows.get("google-sheets")?.needsInstanceName).toBe(false);
    expect(rows.get("google-sheets")?.serverId).toBe("google-sheets");
  });

  test("a partner this machine holds no key for is not a row", async () => {
    const { body } = await read(
      surface({
        partners: {
          configured: ["kakao-alimtalk"],
          alimtalk: {
            status: async () => ({ connected: true, searchId: "@내가게" }),
          },
          // 팝빌's key is absent, which is why `configured` does not name it.
          tax: null,
        } as unknown as ConnectionsOverviewSources["partners"],
      }).app,
    );

    const partnerRows = body.accounts.filter(
      (account) => account.kind === "partner",
    );
    expect(partnerRows.map((row) => [row.id, row.status])).toEqual([
      ["kakao-alimtalk", "connected"],
    ]);
  });

  test("no partner runtime at all is no partner rows, and not an error", async () => {
    const { response, body } = await read(surface().app);
    expect(response.status).toBe(200);
    expect(body.accounts.every((account) => account.kind === "oauth")).toBe(
      true,
    );
  });

  test("every site in the catalogue gets a row, with its state said once", async () => {
    const { body } = await read(
      surface({
        sites: {
          list: async () => [
            {
              siteId: "naver-smartstore",
              botId: "bot-1",
              connectedAt: "2026-08-20T01:00:00.000Z",
              lastSeenAt: "2026-09-04T01:00:00.000Z",
              needsLogin: false,
            },
            {
              siteId: "baemin-ceo",
              botId: "bot-1",
              connectedAt: "2026-08-20T01:00:00.000Z",
              lastSeenAt: "2026-09-04T01:00:00.000Z",
              needsLogin: true,
            },
          ],
        },
      }).app,
    );

    const sites = new Map(body.sites.map((site) => [site.id, site]));
    expect(sites.get("naver-smartstore")?.status).toBe("connected");
    expect(sites.get("baemin-ceo")?.status).toBe("needs_login");
    // A site nobody has touched is a row too, so the surface never has to invent one.
    expect(sites.get("hometax")?.status).toBe("not_connected");
    expect(sites.get("hometax")?.botId).toBe(null);
    expect(body.sites.length).toBeGreaterThan(10);
  });

  test("no computer means no site rows at all, and still no error", async () => {
    const { response, body } = await read(surface().app);
    expect(response.status).toBe(200);
    // Not fifteen rows reading "아직 연결 안 됨": on a deployment with no browser those are fifteen
    // switches whose only possible outcome is a refusal, and the screen hides the section instead.
    expect(body.sites).toEqual([]);
  });

  test("every source is asked about the person in the session and nobody else", async () => {
    const { app, askedAbout } = surface({
      bots: [{ id: "bot-1", name: "가게봇" }],
    });
    const { body } = await read(app);

    expect(new Set(askedAbout)).toEqual(new Set([OWNER.id]));
    expect(body.bots).toEqual([{ id: "bot-1", name: "가게봇" }]);
  });

  test("nothing a shop owner must never be handed rides along", async () => {
    const { body } = await read(
      surface({
        held: [
          {
            serverId: "google-sheets",
            scope: A_SCOPE,
            connectedAt: "2026-09-01T09:00:00.000Z",
          },
        ],
        servers: [
          { id: "cafe24", url: "https://sunnymart.cafe24api.com/api/v2/mcp" },
        ],
        partners: {
          configured: ["kakao-alimtalk"],
          alimtalk: { status: async () => ({ connected: false }) },
          tax: null,
        } as unknown as ConnectionsOverviewSources["partners"],
      }).app,
    );

    const wire = JSON.stringify(body);
    // The scope string the vendor granted, which `/api/plugins/connections` does send and this
    // deliberately does not: the surface says what a connection lets a Bot do from its own table.
    expect(wire).not.toContain(A_SCOPE);
    expect(wire).not.toContain("googleapis.com/auth");
    // The stored server URL. The mall id crosses; the address built out of it does not.
    expect(wire).not.toContain("cafe24api.com");
    expect(wire).toContain("sunnymart");
    for (const forbidden of ["clientSecret", "refreshToken", "access_token"]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  test("without a person there is nothing to compose", async () => {
    const refuse: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
    ) => context.json({ error: "Sign in first." }, 401);
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/connections",
      createConnectionsOverviewRoutes(
        {
          catalogue: () => [sheets],
          store: {
            connectionsFor: async () => {
              throw new Error("the store must not be reached without a person");
            },
            listServers: async () => [],
          },
          partners: null,
          sites: null,
          bots: async () => [],
        } as unknown as ConnectionsOverviewSources,
        refuse,
      ),
    );

    const response = await app.request("/api/connections/overview");
    expect(response.status).toBe(401);
  });
});
