import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { InsightsReport } from "../src/insights/report";
import {
  bearerMatches,
  createInsightsRoutes,
  FLEET_TOKEN_REFUSED,
  INSIGHT_DAYS_INVALID,
  insightDays,
} from "../src/insights/routes";
import { testEnvironment } from "./support/environment";

/**
 * `GET /api/admin/metrics/insights`: who the door opens for, and when it is not there at all.
 *
 * The fleet reads counts about somebody's business through it, from the public internet, with one
 * bearer token and no session. So the three things asserted are the three that would each be a
 * leak or a lie: nothing but the fleet's exact token opens it (a person's session included), a VM
 * never given a token answers like a path that does not exist, and the window it answers for is the
 * one that was asked for — refused rather than quietly clamped. What it reads is proven against a
 * real database in `insights-read.integration.test.ts`.
 */

const TOKEN = "f1eet-read-token-0123456789abcdef0123456789";

const REPORT: InsightsReport = {
  window: {
    days: 7,
    from: "2026-09-07T00:00:00.000Z",
    to: "2026-09-14T00:00:00.000Z",
    nightTimeZone: "Asia/Seoul",
  },
  onboarding: {
    botsLive: 2,
    botsCreated: 1,
    fromPreset: { "review-replies": 1 },
    firstTaskPresses: 1,
    botsWithFirstTask: 1,
    firstTasks: [["ask", "schedule", null, null, null, 1]],
  },
  routines: null,
  limits: null,
  approvals: [[23, 3600, 1]],
  sites: [],
  accounts: [],
  failures: { total: 0, top: [] },
  support: {
    feedback: 0,
    withScreen: 0,
    helpOpened: 1,
    helpReaders: 1,
    helpSections: {},
    answersUp: 2,
    answersDown: 1,
    downReasons: { "too-slow": 1 },
  },
  people: null,
};

function door() {
  const asked: number[] = [];
  const routes = createInsightsRoutes({
    token: TOKEN,
    read: async (days) => {
      asked.push(days);
      return { ...REPORT, window: { ...REPORT.window, days } };
    },
  });
  const get = (path: string, authorization?: string) =>
    routes.request(path, {
      headers: authorization ? { authorization } : {},
    });
  return { asked, get };
}

describe("the bearer", () => {
  test("is exactly the fleet's token, in the Bearer scheme", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer   ${TOKEN}  `, TOKEN)).toBe(true);
  });

  test.each([
    ["nothing", undefined],
    ["an empty header", ""],
    ["the scheme alone", "Bearer"],
    ["the token with no scheme", TOKEN],
    ["another scheme", `Basic ${TOKEN}`],
    ["one character short", `Bearer ${TOKEN.slice(0, -1)}`],
    ["one character more", `Bearer ${TOKEN}x`],
    ["its prefix", `Bearer ${TOKEN.slice(0, 8)}`],
    ["two tokens", `Bearer ${TOKEN} ${TOKEN}`],
  ])("refuses %s", (_label, header) => {
    expect(bearerMatches(header, TOKEN)).toBe(false);
  });
});

describe("the window", () => {
  test("is laf-control's seven days unless asked, and any whole number of days in a year", () => {
    expect(insightDays(undefined)).toBe(7);
    expect(insightDays("")).toBe(7);
    expect(insightDays("1")).toBe(1);
    expect(insightDays("30")).toBe(30);
    expect(insightDays("365")).toBe(365);
  });

  test.each(["0", "366", "-7", "7.5", "1e2", "seven", " 7", "07x", "9999"])(
    "refuses %p rather than answering a window nobody asked for",
    (raw) => {
      expect(insightDays(raw)).toBeNull();
    },
  );
});

describe("the door", () => {
  test("answers the fleet with the report, for the window it asked, and lets nothing keep a copy", async () => {
    const { asked, get } = door();

    const week = await get("/insights", `Bearer ${TOKEN}`);
    expect(week.status).toBe(200);
    expect(week.headers.get("cache-control")).toBe("no-store");
    expect(await week.json()).toEqual(REPORT);

    const month = await get("/insights?days=30", `Bearer ${TOKEN}`);
    expect(((await month.json()) as InsightsReport).window.days).toBe(30);
    expect(asked).toEqual([7, 30]);
  });

  test("without the token it is 401 with a code, before the window or the database is looked at", async () => {
    const { asked, get } = door();
    for (const authorization of [
      undefined,
      `Bearer wrong-${TOKEN}`,
      `Basic ${TOKEN}`,
    ]) {
      const response = await get("/insights?days=nonsense", authorization);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await response.json()).toEqual({
        error: FLEET_TOKEN_REFUSED,
        code: FLEET_TOKEN_REFUSED,
      });
    }
    expect(asked).toEqual([]);
  });

  test("a window that is not one is refused with its bounds, and nothing is read", async () => {
    const { asked, get } = door();
    const response = await get("/insights?days=400", `Bearer ${TOKEN}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: INSIGHT_DAYS_INVALID,
      code: INSIGHT_DAYS_INVALID,
      min: 1,
      max: 365,
    });
    expect(asked).toEqual([]);
  });
});

/**
 * Where `createApp` puts it. `insights` is the last positional collaborator; the tuple is typed from
 * the function, and a wrong index shows up here as a 404 where a 200 was expected.
 */
describe("the mount", () => {
  const signedInAdmin = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({
        user: { id: "admin", email: "admin@laf.test", name: "Admin" },
      }),
    },
  };
  const adminRoles = { rolesForUser: async () => ["admin" as const] };

  function surface(options: { token?: string; reader?: boolean }) {
    const config = loadConfig(
      testEnvironment(
        options.token ? { LAF_FLEET_METRICS_TOKEN: options.token } : {},
      ),
    );
    const args: Parameters<typeof createApp> = [
      config,
      signedInAdmin,
      adminRoles,
    ];
    if (options.reader !== false) args[43] = async () => REPORT;
    return createApp(...args);
  }

  test("is not there on a VM the fleet gave no token: the same 404 as a path that does not exist", async () => {
    const app = surface({});
    const insights = await app.request(
      "http://laf.local/api/admin/metrics/insights",
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const nowhere = await app.request(
      "http://laf.local/api/admin/metrics/nowhere",
    );
    expect(insights.status).toBe(404);
    expect(await insights.json()).toEqual(await nowhere.json());
  });

  test("is not there without a reader either, token or not", async () => {
    const response = await surface({ token: TOKEN, reader: false }).request(
      "http://laf.local/api/admin/metrics/insights",
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(response.status).toBe(404);
  });

  test("opens for the fleet's bearer, and not for an administrator's session", async () => {
    const app = surface({ token: TOKEN });

    const fleet = await app.request(
      "http://laf.local/api/admin/metrics/insights",
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(fleet.status).toBe(200);
    expect(await fleet.json()).toEqual(REPORT);

    // Signed in as an administrator, with a cookie and no bearer: still the fleet's door, still shut.
    const administrator = await app.request(
      "http://laf.local/api/admin/metrics/insights",
      { headers: { cookie: "session=admin" } },
    );
    expect(administrator.status).toBe(401);
  });
});

describe("the token itself", () => {
  test("unset is a correct deployment with no door", () => {
    expect(loadConfig(testEnvironment()).fleetMetricsToken).toBeUndefined();
    expect(
      loadConfig(testEnvironment({ LAF_FLEET_METRICS_TOKEN: "  " }))
        .fleetMetricsToken,
    ).toBeUndefined();
  });

  test("is carried as written when it is long enough", () => {
    expect(
      loadConfig(testEnvironment({ LAF_FLEET_METRICS_TOKEN: ` ${TOKEN} ` }))
        .fleetMetricsToken,
    ).toBe(TOKEN);
  });

  test.each([
    ["short", "abc123"],
    ["thirty-one characters", "a".repeat(31)],
    ["whitespace inside", `${"a".repeat(20)} ${"b".repeat(20)}`],
  ])("refuses to start on one that is %s", (_label, token) => {
    expect(() =>
      loadConfig(testEnvironment({ LAF_FLEET_METRICS_TOKEN: token })),
    ).toThrow("LAF_FLEET_METRICS_TOKEN must be at least 32 characters");
  });
});
