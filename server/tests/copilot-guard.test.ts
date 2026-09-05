/**
 * The CopilotKit runtime is behind the session guard, which is what its comment always claimed.
 *
 * MEASURED, on a server with authentication configured and no cookie sent: `/api/copilotkit/threads`
 * answered 200 with every thread in the deployment, `/threads/<id>/messages` answered 200 with the
 * conversation, and `/api/me` beside them answered 401. The mount is `app.route("/", copilotHandler)`
 * — the handler carries its own basePath — so none of the per-route guards above it were ever in
 * front of it, and nothing in the request path checked who was asking.
 *
 * The endpoints are asserted by NAME rather than through a wildcard, because the failure was that a
 * whole family of routes was reachable: a guard that covered `/threads` and not `/agent/:name/run`
 * would look exactly as green as the bug did.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const config = loadConfig({ ...testEnvironment() });

/** The shape the real handler has: its own basePath, and everything under it. See `copilot.ts`. */
const copilotHandler = () =>
  new Hono()
    .basePath("/api/copilotkit")
    .all("*", (context) => context.json({ reached: true }));

const noSession = {
  handler: () => new Response(null, { status: 204 }),
  api: { getSession: async () => null },
};

const sessionFor = (userId: string) => ({
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: userId, email: `${userId}@laf.test`, name: userId },
    }),
  },
});

const appWith = (
  auth: ReturnType<typeof sessionFor> | typeof noSession,
  roles: string[],
) =>
  createApp(
    config,
    auth,
    { rolesForUser: async () => roles as never },
    undefined,
    undefined,
    undefined,
    undefined,
    copilotHandler(),
  );

/** Every route family the runtime serves, so a guard cannot cover one and miss the rest. */
const RUNTIME_PATHS = [
  // The bare path too: the handler's own basePath answers there, and `"/x/*"` covering `/x` is a
  // property of this Hono rather than a rule, so it is measured here instead of assumed.
  "/api/copilotkit",
  "/api/copilotkit/threads",
  "/api/copilotkit/threads/thread-1/messages",
  "/api/copilotkit/info",
  "/api/copilotkit/agent/agent_expense/run",
] as const;

describe("the CopilotKit runtime behind the session guard", () => {
  test("answers 401 to a caller with no session", async () => {
    const app = appWith(noSession, []);

    for (const path of RUNTIME_PATHS) {
      const response = await app.request(`http://laf.local${path}`);
      expect(`${path} → ${response.status}`).toBe(`${path} → 401`);
    }
  });

  test("lets a signed-in person through to the runtime", async () => {
    const app = appWith(sessionFor("member"), ["user"]);

    for (const path of RUNTIME_PATHS) {
      const response = await app.request(`http://laf.local${path}`);
      expect(`${path} → ${response.status}`).toBe(`${path} → 200`);
    }
  });

  test("answers 403 to somebody signed in with no role at all", async () => {
    const app = appWith(sessionFor("stranger"), []);

    const response = await app.request(
      "http://laf.local/api/copilotkit/threads",
    );
    expect(response.status).toBe(403);
  });
});
