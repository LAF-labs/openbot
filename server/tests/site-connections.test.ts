import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq, like } from "drizzle-orm";
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
import { auditEvents, lafSiteConnections, users } from "../src/db/schema";
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

  /*
   * ANOTHER BOT'S WALL IS NOT THIS SESSION EXPIRING (audit 2026-09-10, A9 F4). A browser profile
   * is per Bot, so Bot B visiting 배민 on its own never-signed-in profile sees the login wall every
   * time — and the row, which says the session lives in Bot A's browser, was flipped to
   * 다시 로그인 필요 by it. Measured: A signs in, B's routine runs, the card says log in again; A
   * visits, the card says connected; B runs again, and so on, several times a day.
   */
  test("a login wall seen by another Bot's browser does not flip the connection", async () => {
    const userId = await createUser();
    await store.record({
      userId,
      siteId: "baemin-ceo",
      botId: "bot-a",
      signedIn: true,
    });

    // Bot B, on its own profile, which was never signed in.
    const seenByB = await store.record({
      userId,
      siteId: "baemin-ceo",
      botId: "bot-b",
      signedIn: false,
    });

    expect(seenByB).toBeNull();
    expect(
      (await store.list(userId)).map((row) => [row.botId, row.needsLogin]),
    ).toEqual([["bot-a", false]]);

    // The browser the session lives in seeing the wall is the session expiring.
    const seenByA = await store.record({
      userId,
      siteId: "baemin-ceo",
      botId: "bot-a",
      signedIn: false,
    });
    expect(seenByA?.needsLogin).toBe(true);
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

/**
 * THE MOMENTS A SIGN-IN CHANGES, WRITTEN DOWN (laf-control `core/insights.ts` §4-3).
 *
 * The row holds only the present, so "how long does a login to this site last" had nothing to be
 * counted from. Two rows now say when the flag moves — and only then: a morning's routine finding
 * 배민 still signed in is the ordinary case, and a trail of those would bury the two that matter.
 * The rows are read back out of the trail table itself, because `site.login_lapsed` reads it too.
 */
describe("the moments a sign-in changes", () => {
  /** The site rows this person's looks left, oldest first, as the trail holds them. */
  async function siteRows(userId: string) {
    return database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, userId),
          like(auditEvents.eventType, "site.%"),
        ),
      )
      .orderBy(asc(auditEvents.createdAt));
  }

  test("a first sign-in is one row; the looks that find it still signed in are none", async () => {
    const userId = await createUser();
    for (const botId of ["bot-1", "bot-1", "bot-1"]) {
      await store.record({
        userId,
        siteId: "baemin-ceo",
        botId,
        signedIn: true,
      });
    }

    const rows = await siteRows(userId);
    expect(
      rows.map((row) => [row.eventType, row.targetType, row.targetId]),
    ).toEqual([["site.signed_in", "site", "baemin-ceo"]]);
    expect(rows[0]?.payload).toEqual({ site: "baemin-ceo", bot: "bot-1" });
  });

  test("the session's own browser meeting the wall is one lapse, with when it began and was last alive", async () => {
    const userId = await createUser();
    const connected = await store.record({
      userId,
      siteId: "hometax",
      botId: "bot-1",
      signedIn: true,
    });
    await Bun.sleep(200);
    const refreshed = await store.record({
      userId,
      siteId: "hometax",
      botId: "bot-1",
      signedIn: true,
    });
    // The wall, three mornings running: the first is the news, the other two are not.
    for (let morning = 0; morning < 3; morning += 1) {
      await store.record({
        userId,
        siteId: "hometax",
        botId: "bot-1",
        signedIn: false,
      });
    }

    const rows = await siteRows(userId);
    expect(rows.map((row) => row.eventType)).toEqual([
      "site.signed_in",
      "site.login_lapsed",
    ]);
    const lapse = rows[1]?.payload as Record<string, string>;
    expect(Object.keys(lapse).sort()).toEqual([
      "bot",
      "lastSeenAt",
      "signedInSince",
      "site",
    ]);
    expect(lapse.site).toBe("hometax");
    expect(lapse.bot).toBe("bot-1");
    if (!connected || !refreshed) {
      throw new Error("a signed-in look wrote no connection");
    }
    // Last seen alive is the refresh, not the first look and not the wall.
    expect(lapse.lastSeenAt).toBe(refreshed.lastSeenAt);
    // The session began with the sign-in, and never later than the last time it was seen.
    const began = Date.parse(lapse.signedInSince as string);
    expect(began).toBeGreaterThanOrEqual(
      Date.parse(connected.connectedAt) - 1_000,
    );
    expect(began).toBeLessThan(Date.parse(refreshed.lastSeenAt));
  });

  test("another Bot's browser meeting the wall writes nothing, because nothing about the session changed", async () => {
    const userId = await createUser();
    await store.record({
      userId,
      siteId: "baemin-ceo",
      botId: "bot-a",
      signedIn: true,
    });
    await store.record({
      userId,
      siteId: "baemin-ceo",
      botId: "bot-b",
      signedIn: false,
    });

    expect((await siteRows(userId)).map((row) => row.eventType)).toEqual([
      "site.signed_in",
    ]);
  });

  test("after signing in again, the next lapse is counted from the second sign-in, not the first", async () => {
    const userId = await createUser();
    const site = { userId, siteId: "coupang-wing", botId: "bot-1" };
    const first = await store.record({ ...site, signedIn: true });
    await store.record({ ...site, signedIn: false });
    // Long enough that the two sign-ins cannot be confused whatever the two clocks disagree by.
    await Bun.sleep(1_200);
    const again = await store.record({ ...site, signedIn: true });
    await store.record({ ...site, signedIn: false });

    const rows = await siteRows(userId);
    expect(rows.map((row) => row.eventType)).toEqual([
      "site.signed_in",
      "site.login_lapsed",
      "site.signed_in",
      "site.login_lapsed",
    ]);
    const secondSignIn = rows[2]?.createdAt as Date;
    const secondLapse = rows[3]?.payload as {
      signedInSince: string;
      lastSeenAt: string;
    };
    if (!again) throw new Error("the second sign-in wrote no connection");
    /*
     * The second session began at the second sign-in: the look itself, which its row follows by the
     * moment it took to write.
     *
     * NOT BY EQUALITY, BECAUSE THERE ARE TWO CLOCKS AND THE STORE TAKES NEITHER. `lastSeenAt` is this
     * process's `new Date()` at the look; the trail row the session start is read back from is
     * stamped by Postgres's `now()`, and `sessionStart` keeps the row's time unless it is later than
     * the look. So `toBe` held only while the database's clock was not behind this one by more than
     * the write took. It was 9 ms behind when measured (2026-09-14); under load the row once came
     * back 31 ms before the look, and with this process's clock set 31 ms ahead the old assertion
     * fails every time — the clamp has nothing to clamp. What does not depend on the clocks is the
     * clamp: never after the look. What this test is for is which sign-in: within the second this
     * file already allows the two clocks to disagree by, less than the 1.2 s between the sign-ins, so
     * the first can never pass for the second.
     */
    const began = Date.parse(secondLapse.signedInSince);
    const lookedAt = Date.parse(again.lastSeenAt);
    expect(began).toBeLessThanOrEqual(lookedAt);
    expect(lookedAt - began).toBeLessThan(1_000);
    expect(secondSignIn.getTime() - Date.parse(again.lastSeenAt)).toBeLessThan(
      1_000,
    );
    // `connected_at` did not move — the card's "since" is still the first one — and the lapse did
    // not borrow it.
    if (!first) throw new Error("the first sign-in wrote no connection");
    expect((await store.list(userId))[0]?.connectedAt ?? "").toBe(
      first.connectedAt,
    );
    expect(Date.parse(secondLapse.signedInSince)).toBeGreaterThan(
      Date.parse(first.connectedAt) + 1_000,
    );
  });

  test("a session seen only when it was signed into began then, not when its row was written", async () => {
    // Through the running stack the lapse said "signed in since" 27 ms after "last seen": the row's
    // clock is the database's and it is written a moment after the look.
    const userId = await createUser();
    const site = { userId, siteId: "yogiyo-ceo", botId: "bot-1" };
    const signedIn = await store.record({ ...site, signedIn: true });
    await store.record({ ...site, signedIn: false });

    const lapse = (await siteRows(userId))[1]?.payload as {
      signedInSince: string;
      lastSeenAt: string;
    };
    if (!signedIn) throw new Error("the sign-in wrote no connection");
    expect(lapse.lastSeenAt).toBe(signedIn.lastSeenAt);
    expect(Date.parse(lapse.signedInSince)).toBeLessThanOrEqual(
      Date.parse(lapse.lastSeenAt),
    );
  });

  test("a person finishing a login through the check route is the sign-in, and the wall they left is the lapse", async () => {
    const userId = await createUser();
    await routesReading(BAEMIN_SIGNED_IN, userId).request(
      "/api/sites/baemin-ceo/check",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botId: "bot-1" }),
      },
    );
    await routesReading(BAEMIN_LOGIN_WALL, userId).request(
      "/api/sites/baemin-ceo/check",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botId: "bot-1" }),
      },
    );
    await routesReading(BAEMIN_SIGNED_IN, userId).request(
      "/api/sites/baemin-ceo/check",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botId: "bot-1" }),
      },
    );

    const rows = await siteRows(userId);
    expect(rows.map((row) => row.eventType)).toEqual([
      "site.signed_in",
      "site.login_lapsed",
      "site.signed_in",
    ]);
    /*
     * The site and the Bot and two clocks. The page carried a URL path and a string that looks like
     * what somebody types into a login form; neither is anywhere in what the trail kept.
     */
    const kept = JSON.stringify(rows);
    expect(kept).not.toContain(TYPED_SECRET);
    expect(kept).not.toContain("/orders");
    expect(kept).not.toContain("/login");
    expect(kept).not.toContain("ceo.baemin.com");
  });

  test("a routine's navigation landing on the wall is the lapse too, through the gateway's own report", async () => {
    const userId = await createUser();
    await store.record({
      userId,
      siteId: "baemin-ceo",
      botId: "bot-1",
      signedIn: true,
    });
    const view = {
      navigate: async () => ({
        url: BAEMIN_LOGIN_WALL.url,
        title: BAEMIN_LOGIN_WALL.title,
        text: `${BAEMIN_LOGIN_WALL.text} ${TYPED_SECRET}`,
        truncated: false,
        elapsedMs: 1,
      }),
    };
    const gateway = createComputerGateway({
      client: { ...view, forBot: () => view } as unknown as ComputerClient,
      auditStore: { insert: async () => {} },
      policy: () => ({ deny: [], ask: [], allow: ["true"] }),
      // Exactly as main.ts wires it: the report goes straight into the store, and is not awaited.
      siteSeen: (seen) => {
        void store.record(seen).catch(() => undefined);
      },
    });

    await gateway.navigate(
      "bot-1",
      "bot-1",
      { id: userId, userId },
      "https://ceo.baemin.com/orders",
    );

    // The report is not awaited by the navigation, so wait for the row it leaves.
    let rows = await siteRows(userId);
    for (let tries = 0; tries < 50 && rows.length < 2; tries += 1) {
      await Bun.sleep(20);
      rows = await siteRows(userId);
    }
    expect(rows.map((row) => row.eventType)).toEqual([
      "site.signed_in",
      "site.login_lapsed",
    ]);
    expect(JSON.stringify(rows)).not.toContain(TYPED_SECRET);
  });

  test("a trail that cannot be reached costs the row, never the connection", async () => {
    const userId = await createUser();
    const unreachable = createSiteConnectionStore(database, {
      auditStore: {
        insert: async () => {
          throw new Error("the audit store is unreachable");
        },
      },
    });

    const connected = await unreachable.record({
      userId,
      siteId: "baemin-ceo",
      botId: "bot-1",
      signedIn: true,
    });
    const lapsed = await unreachable.record({
      userId,
      siteId: "baemin-ceo",
      botId: "bot-1",
      signedIn: false,
    });

    expect(connected?.needsLogin).toBe(false);
    expect(lapsed?.needsLogin).toBe(true);
    expect(await siteRows(userId)).toEqual([]);
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
