import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { siteById } from "../../shared/sites/catalogue";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerClient } from "../src/computer/client";
import { ComputerUnavailableError } from "../src/computer/client";
import { createComputerGateway } from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import { createSiteConnectionStore } from "../src/computer/site-connections";
import { createSiteRoutes } from "../src/computer/site-routes";
import { createDatabase } from "../src/db/client";
import { lafSiteConnections, users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * WHAT A 사이트 연결 ROW IS ALLOWED TO KNOW, AND WHEN IT LEARNS IT.
 *
 * Three properties, none visible from a green typecheck:
 *  - the row holds ids and clocks and nothing a person typed or a page showed — serialised whole
 *    and searched, the way the recorder and the trail are tested
 *  - "connected since" is written once; a signed-in page seen again refreshes `last_seen_at` and
 *    leaves `connected_at` alone, and a login wall marks an existing row rather than inventing one
 *  - the ordinary navigation path reports what it landed on, decided by the SAME predicate the
 *    check route uses, so the card cannot mean two things
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const store = createSiteConnectionStore(database);
const testPrefix = `site-connections-${randomUUID()}`;
const createdUserIds: string[] = [];

/** A page text no real site would show, so its absence from every record is a real absence. */
const TYPED_SECRET = "hunter2-Zx9-SITEPASS";

afterEach(async () => {
  for (const userId of createdUserIds.splice(0)) {
    await database
      .delete(lafSiteConnections)
      .where(eq(lafSiteConnections.userId, userId));
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser() {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Site Connections Test User",
  });
  createdUserIds.push(id);
  return id;
}

/** The person the routes act as, without a session: the guard is not what is under test here. */
function actingAs(
  userId: string,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: userId,
      email: `${userId}@example.test`,
      role: "user",
    });
    await next();
  };
}

const BAEMIN_SIGNED_IN = {
  url: "https://ceo.baemin.com/orders",
  title: "주문",
  text: `주문 관리 오늘 주문 12건 로그아웃 ${TYPED_SECRET}`,
  truncated: false,
};

const BAEMIN_LOGIN_WALL = {
  url: "https://ceo.baemin.com/login",
  title: "로그인",
  text: "아이디 비밀번호 로그인",
  truncated: false,
};

function routesReading(page: typeof BAEMIN_SIGNED_IN | Error, userId: string) {
  const gateway = {
    read: async () => {
      if (page instanceof Error) throw page;
      return page;
    },
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/sites", createSiteRoutes(gateway, store, actingAs(userId)));
  return app;
}

describe("the 사이트 연결 store", () => {
  test("a signed-in look connects, a later look refreshes, and the connection date holds", async () => {
    const userId = await createUser();

    const first = await store.record({
      userId,
      siteId: "baemin-ceo",
      botId: "bot-1",
      signedIn: true,
    });
    expect(first?.needsLogin).toBe(false);

    await Bun.sleep(5);
    const again = await store.record({
      userId,
      siteId: "baemin-ceo",
      botId: "bot-2",
      signedIn: true,
    });

    expect(again?.connectedAt).toBe(first?.connectedAt);
    expect(new Date(again?.lastSeenAt ?? 0).getTime()).toBeGreaterThan(
      new Date(first?.lastSeenAt ?? 0).getTime(),
    );
    // The browser the session was last seen in, which is what the card names.
    expect(again?.botId).toBe("bot-2");
  });

  test("a login wall marks a connection as needing a login, and never invents one", async () => {
    const userId = await createUser();

    // Never connected: a login wall on a site nobody signed into is not news.
    const nothing = await store.record({
      userId,
      siteId: "hometax",
      botId: "bot-1",
      signedIn: false,
    });
    expect(nothing).toBeNull();
    expect(await store.list(userId)).toEqual([]);

    await store.record({
      userId,
      siteId: "hometax",
      botId: "bot-1",
      signedIn: true,
    });
    const expired = await store.record({
      userId,
      siteId: "hometax",
      botId: "bot-1",
      signedIn: false,
    });
    expect(expired?.needsLogin).toBe(true);
    expect((await store.list(userId)).map((row) => row.needsLogin)).toEqual([
      true,
    ]);
  });

  test("turning a site off takes this person's row and nobody else's", async () => {
    const mine = await createUser();
    const theirs = await createUser();
    for (const userId of [mine, theirs]) {
      await store.record({
        userId,
        siteId: "baemin-ceo",
        botId: "bot-1",
        signedIn: true,
      });
    }

    expect(await store.forget({ userId: mine, siteId: "baemin-ceo" })).toBe(
      true,
    );
    expect(await store.list(mine)).toEqual([]);
    // The other person's row is the whole point: a delete by site alone would take it too.
    expect((await store.list(theirs)).map((row) => row.siteId)).toEqual([
      "baemin-ceo",
    ]);
    // A site that was never connected is not an error; there is simply nothing to take.
    expect(await store.forget({ userId: mine, siteId: "hometax" })).toBe(false);
  });
});

describe("the check route", () => {
  test("reads the Bot's browser, decides with the catalogue's predicate, and answers without the page", async () => {
    const userId = await createUser();
    const app = routesReading(BAEMIN_SIGNED_IN, userId);

    const response = await app.request("/api/sites/baemin-ceo/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      signedIn: boolean;
      connection: { siteId: string; needsLogin: boolean };
    };
    expect(body.signedIn).toBe(true);
    expect(body.connection.siteId).toBe("baemin-ceo");

    /*
     * The row and the reply are searched whole. The page carried a string that looks like what
     * somebody types into a login form, and the store's design is that there is no column it could
     * land in — this is the test that keeps that design from quietly gaining one.
     */
    const rows = await database
      .select()
      .from(lafSiteConnections)
      .where(eq(lafSiteConnections.userId, userId));
    const everything = JSON.stringify({ rows, body });
    expect(everything).not.toContain(TYPED_SECRET);
    expect(everything).not.toContain("ceo.baemin.com/orders");
  });

  test("a login wall answers signedIn: false and marks the row", async () => {
    const userId = await createUser();
    await store.record({
      userId,
      siteId: "baemin-ceo",
      botId: "bot-1",
      signedIn: true,
    });
    const app = routesReading(BAEMIN_LOGIN_WALL, userId);

    const response = await app.request("/api/sites/baemin-ceo/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1" }),
    });
    const body = (await response.json()) as {
      signedIn: boolean;
      connection: { needsLogin: boolean } | null;
    };
    expect(body.signedIn).toBe(false);
    expect(body.connection?.needsLogin).toBe(true);
  });

  test("an unknown site is 404, a missing Bot is 400, and a browser that will not answer is 503", async () => {
    const userId = await createUser();

    const unknown = await routesReading(BAEMIN_SIGNED_IN, userId).request(
      "/api/sites/not-a-site/check",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botId: "bot-1" }),
      },
    );
    expect(unknown.status).toBe(404);

    const noBot = await routesReading(BAEMIN_SIGNED_IN, userId).request(
      "/api/sites/baemin-ceo/check",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(noBot.status).toBe(400);

    const down = await routesReading(
      new ComputerUnavailableError("restarting"),
      userId,
    ).request("/api/sites/baemin-ceo/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-1" }),
    });
    expect(down.status).toBe(503);
    // A browser that is restarting is not a failed login: nothing was recorded.
    expect(await store.list(userId)).toEqual([]);
  });

  test("lists only this person's connections", async () => {
    const mine = await createUser();
    const theirs = await createUser();
    await store.record({
      userId: theirs,
      siteId: "coupang-wing",
      botId: "bot-9",
      signedIn: true,
    });

    const response = await routesReading(BAEMIN_SIGNED_IN, mine).request(
      "/api/sites/connections",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connections: [] });
  });

  test("the switch can be turned off, and only on a site that exists", async () => {
    const userId = await createUser();
    await store.record({
      userId,
      siteId: "baemin-ceo",
      botId: "bot-1",
      signedIn: true,
    });

    const app = routesReading(BAEMIN_SIGNED_IN, userId);
    const off = await app.request("/api/sites/baemin-ceo/connection", {
      method: "DELETE",
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ forgotten: true });
    expect(await store.list(userId)).toEqual([]);

    const unknown = await app.request("/api/sites/not-a-site/connection", {
      method: "DELETE",
    });
    expect(unknown.status).toBe(404);
  });
});

describe("the gateway reports where a navigation landed", () => {
  const PERMISSIVE: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
  const ACTOR = { id: "dev-local-user" };

  function gatewayLandingOn(page: typeof BAEMIN_SIGNED_IN) {
    const seen: Array<{
      siteId: string;
      signedIn: boolean;
      userId: string;
      botId: string;
    }> = [];
    const rows: AuditEventInput[] = [];
    const auditStore: AuditStore = {
      insert: async (event) => {
        rows.push(event);
      },
    };
    // The gateway addresses the computer as one Bot through `forBot`, so the view is what it calls.
    const view = {
      snapshot: async () => ({
        snapshotId: 1,
        url: page.url,
        title: page.title,
        truncated: false,
        elements: [],
      }),
      read: async () => page,
      navigate: async () => ({
        action: "navigate",
        url: page.url,
        title: page.title,
        text: page.text,
        truncated: false,
        elapsedMs: 1,
      }),
    };
    const client = {
      ...view,
      forBot: () => view,
    } as unknown as ComputerClient;
    const gateway = createComputerGateway({
      client,
      auditStore,
      policy: () => PERMISSIVE,
      siteSeen: (event) => {
        seen.push(event);
      },
    });
    return { gateway, seen, rows };
  }

  test("a landing on a catalogue site is reported with the predicate's verdict", async () => {
    const { gateway, seen } = gatewayLandingOn(BAEMIN_SIGNED_IN);
    await gateway.navigate(
      "default",
      "bot-1",
      ACTOR,
      "https://ceo.baemin.com/",
    );

    expect(seen).toEqual([
      {
        userId: "dev-local-user",
        siteId: "baemin-ceo",
        botId: "bot-1",
        signedIn: true,
      },
    ]);
    expect(
      siteById("baemin-ceo")?.signedIn(
        BAEMIN_SIGNED_IN.url,
        BAEMIN_SIGNED_IN.text,
      ),
    ).toBe(true);
  });

  test("a redirect to the login wall reads as not signed in, and the page never reaches the trail", async () => {
    const { gateway, seen, rows } = gatewayLandingOn({
      ...BAEMIN_LOGIN_WALL,
      text: `${BAEMIN_LOGIN_WALL.text} ${TYPED_SECRET}`,
    });
    await gateway.navigate(
      "default",
      "bot-1",
      ACTOR,
      "https://ceo.baemin.com/orders",
    );

    expect(seen.map((event) => event.signedIn)).toEqual([false]);
    expect(JSON.stringify(rows)).not.toContain(TYPED_SECRET);
  });

  test("a page outside the catalogue is nobody's business", async () => {
    const { gateway, seen } = gatewayLandingOn({
      url: "https://example.com/",
      title: "Example",
      text: "로그아웃",
      truncated: false,
    });
    await gateway.navigate("default", "bot-1", ACTOR, "https://example.com/");
    expect(seen).toEqual([]);
  });
});
