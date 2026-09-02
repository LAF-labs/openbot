import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const app = createApp(
  loadConfig({
    ...testEnvironment(),
  }),
);

describe("health endpoint", () => {
  test("reports the server as healthy", async () => {
    const response = await app.request("http://laf.local/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
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
