import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createHealthRoute, type HealthProbes } from "../src/health";
import { testEnvironment } from "./support/environment";

const app = createApp(
  loadConfig({
    ...testEnvironment(),
  }),
);

/** The route as `createApp` mounts it, with the dependencies faked. */
const mounted = (
  probes: HealthProbes,
  options?: Parameters<typeof createHealthRoute>[1],
) => new Hono().route("/health", createHealthRoute(probes, options));

const ask = (
  probes: HealthProbes,
  options?: Parameters<typeof createHealthRoute>[1],
) => mounted(probes, options).request("http://laf.local/health");

const up = async () => true;
const down = async () => false;

describe("health endpoint", () => {
  test("reports no checks, and stays up, for an embedding that supplied no probes", async () => {
    const response = await app.request("http://laf.local/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      checks: {},
    });
  });

  test("reports every dependency it was given", async () => {
    const response = await ask({ database: up, agentBot: up, computer: up });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      checks: { database: "ok", agentBot: "ok", computer: "ok" },
    });
  });

  /*
   * The whole point. Compose's healthcheck and the fleet monitor read the status code and nothing
   * else, so a deployment whose database is refusing connections has to answer 503 — the constant
   * this replaced answered 200 with every dependency dead.
   */
  test("answers 503, naming the dependency, when one is down", async () => {
    const response = await ask({ database: down, agentBot: up, computer: up });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "degraded",
      checks: { database: "down", agentBot: "ok", computer: "ok" },
    });
  });

  test("counts a probe that throws as down rather than failing the request", async () => {
    const response = await ask({
      database: async () => {
        throw new Error("connection refused");
      },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "degraded",
      checks: { database: "down" },
    });
  });

  // A dependency that has stopped answering is down. Waiting for it turns a health poll into the
  // same hang it is supposed to report.
  test("counts a probe that never settles as down, without waiting for it", async () => {
    const response = await ask(
      { agentBot: () => new Promise<boolean>(() => {}) },
      { timeoutMs: 5 },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "degraded",
      checks: { agentBot: "down" },
    });
  });

  // Compose polls this every ten seconds per container. Probing on every poll would spend a
  // database round trip and two HTTP requests on being asked whether the deployment is busy.
  test("reuses one answer for the cache window and probes again after it", async () => {
    let calls = 0;
    let clock = 1_000;
    const route = mounted(
      {
        database: async () => {
          calls += 1;
          return true;
        },
      },
      { cacheMs: 5_000, now: () => clock },
    );

    await route.request("http://laf.local/health");
    await route.request("http://laf.local/health");
    expect(calls).toBe(1);

    clock += 5_001;
    await route.request("http://laf.local/health");
    expect(calls).toBe(2);
  });

  // Ten pollers arriving together are one round of probes. The cache is written only once the
  // probes finish, so without this every request that arrives while they run starts its own round.
  test("collapses simultaneous polls into one round of probes", async () => {
    let calls = 0;
    const route = mounted({
      database: async () => {
        calls += 1;
        await Bun.sleep(5);
        return true;
      },
    });

    const responses = await Promise.all([
      route.request("http://laf.local/health"),
      route.request("http://laf.local/health"),
      route.request("http://laf.local/health"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    expect(calls).toBe(1);
  });

  /*
   * The server sends facts; the surface owns the words. An operator reads this in a terminal and a
   * monitor parses it — neither wants a sentence, and a sentence here is one the app would have to
   * translate.
   */
  test("carries states, never prose", async () => {
    const body = await (await ask({ database: down, agentBot: up })).text();

    // An English sentence is words with spaces between them. Fifteen characters of that is long
    // enough that no field name or state can trip it and short enough to catch the first apology
    // somebody adds here.
    expect(body).not.toMatch(/[A-Za-z]+(?: [A-Za-z]+){2,}/);
    expect(body.length).toBeLessThan(200);
  });
});

describe("deployment capabilities", () => {
  /*
   * This endpoint has NO authentication, so every field on it is published to anyone who asks. It
   * used to report a runtime `mode` and an always-true `durableHistory`, projected by hand out of a
   * config object that also held an API key and a licence token — one field added carelessly and
   * the deployment's secrets went out with them. The mode is gone; the rule is not, and this is
   * where it is enforced: the body says exactly one thing.
   */
  test("says the deployment is answering, and nothing else at all", async () => {
    const response = await app.request("http://laf.local/api/capabilities");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(Object.keys(JSON.parse(body) as Record<string, unknown>)).toEqual([
      "status",
    ]);
    expect(body).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect(body).not.toContain("google-client-secret");
  });
});

describe("authentication availability", () => {
  test("fails loudly when Google authentication has not been configured", async () => {
    const response = await app.request(
      "http://laf.local/api/auth/sign-in/social",
      { method: "POST" },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication is not configured.",
    });
  });

  test("forwards auth requests to the configured Better Auth handler", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response("mounted", { status: 204 }),
      },
    );

    const response = await authenticatedApp.request(
      "http://laf.local/api/auth/callback/google",
    );

    expect(response.status).toBe(204);
  });

  test("forwards logout requests to Better Auth", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => null,
        },
      },
    );

    const response = await authenticatedApp.request(
      "http://laf.local/api/auth/sign-out",
      { method: "POST" },
    );

    expect(response.status).toBe(204);
  });
});
