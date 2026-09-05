/**
 * Where a request that changes something is allowed to have come from.
 *
 * There was no such check anywhere, and the reason it matters here more than it does on most
 * products is the deployment shape: every customer is `https://<name>.agent.laf-co.com`, one
 * registrable domain, so every VM is SAME-SITE with every other VM. `SameSite=Lax` — better-auth's
 * default and the only thing that was standing between them — decides nothing between two sites
 * that are same-site, so one customer's page could post to another's deployment with that person's
 * cookie riding along.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../src/app";
import type { AppVariables, AuthService } from "../src/auth/guards";
import { upgradeOriginAllowed } from "../src/auth/origin";
import { createChannelEventHub } from "../src/channels/events";
import { type ChannelStore, createChannelRoutes } from "../src/channels/routes";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const TRUSTED = "https://sujin.agent.laf-co.test";
const config = loadConfig(
  testEnvironment({ TRUSTED_ORIGINS: `${TRUSTED},http://localhost:3000` }),
);

const signedIn: AuthService = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "member", email: "member@laf.test", name: "Member" },
    }),
  },
};

const app = () =>
  createApp(config, signedIn, { rolesForUser: async () => ["user"] });

const refusal = { error: "laf:origin_refused", code: "laf:origin_refused" };

describe("the origin check on state-changing requests", () => {
  test("refuses a POST from another customer's deployment", async () => {
    const response = await app().request("http://laf.local/api/me/onboarded", {
      method: "POST",
      headers: { origin: "https://minjun.agent.laf-co.test" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(refusal);
  });

  test("lets a POST from a trusted origin through to the route", async () => {
    const response = await app().request("http://laf.local/api/me/onboarded", {
      method: "POST",
      headers: { origin: TRUSTED },
    });

    // 204 is the route answering. What matters is that it was reached at all.
    expect(response.status).toBe(204);
  });

  test("lets a POST with no Origin through — that is curl, not a browser", async () => {
    const response = await app().request("http://laf.local/api/me/onboarded", {
      method: "POST",
    });

    expect(response.status).toBe(204);
  });

  test("refuses a POST with no Origin that says it is cross-site", async () => {
    const response = await app().request("http://laf.local/api/me/onboarded", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(refusal);
  });

  test("does not touch reads: a GET from anywhere is answered", async () => {
    const response = await app().request("http://laf.local/api/me", {
      headers: { origin: "https://minjun.agent.laf-co.test" },
    });

    expect(response.status).toBe(200);
  });

  test("leaves the sign-in routes to better-auth's own list", async () => {
    const response = await app().request(
      "http://laf.local/api/auth/sign-in/social",
      {
        method: "POST",
        headers: { origin: "https://minjun.agent.laf-co.test" },
      },
    );

    // The stub answers 204; the point is that this middleware did not answer 403 first.
    expect(response.status).not.toBe(403);
  });

  test("exempts the routine webhook, which is a machine holding a token", async () => {
    const response = await app().request(
      "http://laf.local/api/routines/routine-1/trigger",
      { method: "POST", headers: { origin: "https://anything.example.test" } },
    );

    // 404 because no routine service is wired into this app — it was not refused as an origin.
    expect(response.status).toBe(404);
  });
});

const actor = {
  id: "member",
  email: "member@laf.test",
  role: "user" as const,
};

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

const emptyStore = {
  create: async () => {
    throw new Error("not used");
  },
} as unknown as ChannelStore;

describe("the activity socket's origin check", () => {
  const routes = (trusted: readonly string[]) => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createChannelRoutes(
        emptyStore,
        requireUser,
        createChannelEventHub(),
        undefined,
        undefined,
        undefined,
        trusted,
      ),
    );
    return app;
  };

  test("refuses an upgrade from another customer's deployment", async () => {
    const response = await routes([TRUSTED]).request(
      "http://laf.local/events",
      {
        headers: {
          origin: "https://minjun.agent.laf-co.test",
          upgrade: "websocket",
          connection: "Upgrade",
        },
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(refusal);
  });

  test("refuses an upgrade carrying no Origin at all", async () => {
    const response = await routes([TRUSTED]).request(
      "http://laf.local/events",
      { headers: { upgrade: "websocket", connection: "Upgrade" } },
    );

    expect(response.status).toBe(403);
  });

  test("a deployment that trusts nothing accepts no socket", async () => {
    const response = await routes([]).request("http://laf.local/events", {
      headers: {
        origin: TRUSTED,
        upgrade: "websocket",
        connection: "Upgrade",
      },
    });

    expect(response.status).toBe(403);
  });

  /*
   * The accepting case is asserted on the predicate rather than through the route, because
   * `upgradeWebSocket` reaches for a Bun server that a `app.request(...)` call does not have. What
   * the route contributes is the refusal, which is above; what has to be true of the accepting case
   * is that the rule says yes to it.
   */
  test("the rule admits a trusted origin and nothing else", () => {
    const headers = (init: Record<string, string>) => new Headers(init);
    expect(upgradeOriginAllowed(headers({ origin: TRUSTED }), [TRUSTED])).toBe(
      true,
    );
    expect(
      upgradeOriginAllowed(
        headers({ origin: "https://minjun.agent.laf-co.test" }),
        [TRUSTED],
      ),
    ).toBe(false);
    // No suffix matching: a host that merely ends the right way is a different origin.
    expect(
      upgradeOriginAllowed(headers({ origin: `evil${TRUSTED}` }), [TRUSTED]),
    ).toBe(false);
    expect(upgradeOriginAllowed(headers({}), [TRUSTED])).toBe(false);
  });
});
