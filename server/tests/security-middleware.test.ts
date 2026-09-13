import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../src/app";
import type { AuthService } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import {
  API_CSP,
  BODY_LIMIT_BYTES,
  BODY_TOO_LARGE,
  createSecurityMiddleware,
  doorFor,
  htmlCsp,
  inlineScriptHashes,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMITED,
  RATE_LIMITS,
} from "../src/middleware/security";
import { connectedPageHtml } from "../src/plugins/connected-page";
import { createRoutineRoutes } from "../src/routines/routes";
import type { RoutineService } from "../src/routines/service";
import { testEnvironment } from "./support/environment";

/**
 * The three things the security audit measured as absent (A8 §2, 2026-09-10): no security header
 * on any answer, no ceiling on any body — an anonymous 20 MB `POST …/trigger` was read whole before
 * the token was looked at — and no rate on any door. Asserted through the real `createApp` where it
 * matters that the middleware is mounted and FIRST, and against the real routine routes where it
 * matters that a route never saw the request.
 */

const ORIGIN = "http://laf.local";
const config = loadConfig(testEnvironment({ TRUSTED_ORIGINS: ORIGIN }));

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

const from = (address: string, extra: Record<string, string> = {}) => ({
  origin: ORIGIN,
  "x-forwarded-for": address,
  ...extra,
});

/** The real webhook route behind the real middleware, with a service that says whether it ran. */
function triggerDoor() {
  const triggered: string[] = [];
  const service = {
    trigger: async (id: string) => {
      triggered.push(id);
      return { ran: true };
    },
  } as unknown as RoutineService;
  const door = new Hono();
  door.use("*", createSecurityMiddleware());
  door.route(
    "/api/routines",
    createRoutineRoutes(service, async () => {
      throw new Error("the webhook must not ask for a session");
    }),
  );
  return { door, triggered };
}

/**
 * A body that says how long it is, the way a browser's fetch sends one. `app.request` builds a
 * `Request` that has not been on a wire, so the header a real one carries is written here.
 */
const declaring = (body: string, headers: Record<string, string> = {}) => ({
  body,
  headers: {
    ...headers,
    "content-length": String(new TextEncoder().encode(body).byteLength),
  },
});

/** A body that does not say how long it is, the way a script can send one. */
const chunked = (bytes: number) => {
  const chunk = new TextEncoder().encode("y".repeat(250_000));
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
};

describe("every answer carries the headers", () => {
  test("a JSON answer: a policy that allows nothing, nosniff, no framing, HSTS", async () => {
    const response = await app().request(`${ORIGIN}/api/me`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(API_CSP);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });

  test("a refusal and a miss carry them too", async () => {
    const missing = await app().request(`${ORIGIN}/api/no-such-route`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-security-policy")).toBe(API_CSP);
    expect(missing.headers.get("x-frame-options")).toBe("DENY");

    const refused = await app().request(`${ORIGIN}/api/me/onboarded`, {
      method: "POST",
      headers: { origin: "https://elsewhere.example" },
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-frame-options")).toBe("DENY");
  });

  test("a route that threw carries them too, through the app's error boundary", async () => {
    // app.ts mounts this before `onError`; a throw is caught where the route ran, so the answer
    // the boundary makes still passes back out through the headers.
    const door = new Hono();
    door.use("*", createSecurityMiddleware());
    door.onError((_error, context) =>
      context.json({ code: "laf:internal" }, 500),
    );
    door.get("/api/boom", () => {
      throw new Error("a failure nothing named");
    });
    const response = await door.request("/api/boom");
    expect(response.status).toBe(500);
    expect(response.headers.get("content-security-policy")).toBe(API_CSP);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  test("an HTML page this server draws may run its own inline script by hash, and nothing else", async () => {
    const html = connectedPageHtml({
      ok: true,
      id: "notion",
      title: "Notion",
      reason: "",
    });
    const [hash, ...more] = inlineScriptHashes(html);
    expect(hash).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    expect(more).toEqual([]);

    const page = new Hono();
    page.use("*", createSecurityMiddleware());
    page.get("/connected", (context) => context.html(html));
    const response = await page.request("/connected");
    const policy = response.headers.get("content-security-policy") as string;
    expect(policy).toBe(htmlCsp(html));
    expect(policy).toContain(`script-src ${hash}`);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    // The body is still the page: computing the policy did not consume it.
    expect(await response.text()).toBe(html);
  });

  test("a script loaded by address is not an inline script to hash", () => {
    expect(
      inlineScriptHashes('<script src="/a.js"></script><script>go()</script>'),
    ).toHaveLength(1);
  });
});

describe("a body has a ceiling", () => {
  test("the 20 MB anonymous trigger is refused before its token is looked at, and the routine never runs", async () => {
    const { door, triggered } = triggerDoor();
    const twentyMegabytes = "x".repeat(20_000_000);

    // Without a token the route would say 401; with one it would read the body and run.
    const withoutToken: Record<string, string> = {
      "content-type": "text/plain",
    };
    for (const headers of [
      withoutToken,
      { ...withoutToken, "x-trigger-token": "a-real-looking-token" },
    ]) {
      const response = await door.request("/api/routines/routine_1/trigger", {
        method: "POST",
        headers,
        body: twentyMegabytes,
      });
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual(BODY_TOO_LARGE);
    }
    expect(triggered).toEqual([]);

    // And the door still opens for a trigger that fits.
    const fits = await door.request("/api/routines/routine_1/trigger", {
      method: "POST",
      headers: { "x-trigger-token": "a-real-looking-token" },
      body: '{"order":1}',
    });
    expect(fits.status).toBe(202);
    expect(triggered).toEqual(["routine_1"]);
  });

  test("in the app it comes first: before the origin check, before the session", async () => {
    const response = await app().request(`${ORIGIN}/api/me/onboarded`, {
      method: "POST",
      // No origin at all, which the origin check refuses with a 403 — it never gets the chance.
      headers: { "content-type": "application/json" },
      body: "z".repeat(BODY_LIMIT_BYTES + 1),
    });
    expect(response.status).toBe(413);
  });

  test("a body that does not declare its length is cut at the same megabyte", async () => {
    const response = await app().request(`${ORIGIN}/api/me/onboarded`, {
      method: "POST",
      headers: { origin: ORIGIN },
      body: chunked(1_500_000),
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
  });

  test("under a megabyte goes through to the route", async () => {
    const response = await app().request(`${ORIGIN}/api/me/onboarded`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ note: "z".repeat(900_000) }),
    });
    expect(response.status).toBe(204);
  });

  test("a Bot's file write is allowed the workspace's own cap, escaped — but only for a declared length", async () => {
    const declared = await app().request(
      `${ORIGIN}/api/computers/bot-1/files/write`,
      {
        method: "POST",
        ...declaring(
          JSON.stringify({ path: "notes.md", contents: "w".repeat(1_500_000) }),
          { origin: ORIGIN, "content-type": "application/json" },
        ),
      },
    );
    // Not 413. (404: no computer is mounted in this app, which is the router saying so.)
    expect(declared.status).not.toBe(413);

    const undeclared = await app().request(
      `${ORIGIN}/api/computers/bot-1/files/write`,
      {
        method: "POST",
        headers: { origin: ORIGIN },
        body: chunked(1_500_000),
        duplex: "half",
      } as RequestInit,
    );
    expect(undeclared.status).toBe(413);
  });

  test("a conversation turn carries its thread, so it is allowed more — and an anonymous one is still refused unread", async () => {
    // The shape app.ts has: this middleware, then the session guard on the runtime, then the runtime.
    const door = new Hono();
    door.use("*", createSecurityMiddleware());
    door.use("/api/copilotkit/*", async (context, next) => {
      if (!context.req.header("cookie")) {
        return context.json({ error: "laf:unauthenticated" }, 401);
      }
      return next();
    });
    let read = 0;
    door.post("/api/copilotkit/agent/:agentId/run", async (context) => {
      read = (await context.req.text()).length;
      return context.json({ ok: true });
    });
    const history = JSON.stringify({ messages: "m".repeat(5_000_000) });

    const signedInTurn = await door.request("/api/copilotkit/agent/bot-1/run", {
      method: "POST",
      ...declaring(history, {
        "content-type": "application/json",
        cookie: "better-auth.session_token=S",
      }),
    });
    expect(signedInTurn.status).toBe(200);
    expect(read).toBe(history.length);

    read = 0;
    const anonymous = await door.request("/api/copilotkit/agent/bot-1/run", {
      method: "POST",
      ...declaring(history, { "content-type": "application/json" }),
    });
    // 401, not 413, and not a byte of it read to find that out.
    expect(anonymous.status).toBe(401);
    expect(read).toBe(0);

    // The same size without a declared length is a megabyte like anywhere else: it would have to be
    // read to be counted, and nobody has been asked who is sending it.
    const undeclared = await door.request("/api/copilotkit/agent/bot-1/run", {
      method: "POST",
      headers: { cookie: "better-auth.session_token=S" },
      body: chunked(1_500_000),
      duplex: "half",
    } as RequestInit);
    expect(undeclared.status).toBe(413);
  });
});

describe("three doors have a rate", () => {
  test("the doors are the ones the routers answer, however the path is spelled", () => {
    expect(doorFor("POST", "/api/auth/sign-in/social")).toBe("signIn");
    expect(doorFor("POST", "/api/auth/sign-in/oauth2")).toBe("signIn");
    expect(doorFor("POST", "/api/copilotkit/agent/bot-1/run")).toBe("message");
    // CopilotKit's router reads the last three segments, so these reach a run too.
    expect(doorFor("POST", "/api/copilotkit//agent/bot-1/run")).toBe("message");
    expect(doorFor("POST", "/api/copilotkit/x/agent/bot-1/run/")).toBe(
      "message",
    );
    expect(doorFor("POST", "/api/channels/c1/room-turn")).toBe("message");
    expect(doorFor("POST", "/api/routines/r1/trigger")).toBe("trigger");
    // Not doors: a read, a stop, a connect, and the routes beside them.
    expect(doorFor("GET", "/api/copilotkit/agent/bot-1/run")).toBeUndefined();
    expect(
      doorFor("POST", "/api/copilotkit/agent/bot-1/connect"),
    ).toBeUndefined();
    expect(doorFor("POST", "/api/channels/c1/room-turn/stop")).toBeUndefined();
    expect(doorFor("POST", "/api/routines/r1/run")).toBeUndefined();
    expect(doorFor("POST", "/api/auth/sign-out")).toBeUndefined();
  });

  const signInStart = (application: ReturnType<typeof app>, address: string) =>
    application.request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: from(address, { "content-type": "application/json" }),
      body: JSON.stringify({ provider: "google" }),
    });

  test("starting a sign-in: past the limit from one address a minute waits, and another address does not", async () => {
    const application = app();
    for (let attempt = 0; attempt < RATE_LIMITS.signIn.perIp; attempt += 1) {
      expect((await signInStart(application, "203.0.113.7")).status).not.toBe(
        429,
      );
    }
    const refused = await signInStart(application, "203.0.113.7");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    await expect(refused.json()).resolves.toEqual(RATE_LIMITED);
    // And a refusal still carries the headers.
    expect(refused.headers.get("x-frame-options")).toBe("DENY");

    expect((await signInStart(application, "203.0.113.8")).status).not.toBe(
      429,
    );
  });

  test("sending a message: per session, whatever else rides in the cookie, and per address", async () => {
    const application = app();
    const send = (cookie: string, address = "203.0.113.9") =>
      application.request(`${ORIGIN}/api/copilotkit/agent/bot-1/run`, {
        method: "POST",
        headers: from(address, { cookie }),
      });
    for (
      let attempt = 0;
      attempt < RATE_LIMITS.message.perSession;
      attempt += 1
    ) {
      // A cookie that changes beside the session is still the same session.
      const cookie = `theme=${attempt}; better-auth.session_token=A.sig`;
      expect((await send(cookie)).status).not.toBe(429);
    }
    expect((await send("better-auth.session_token=A.sig")).status).toBe(429);
    // On https the cookie has the `__Secure-` prefix, and it is the same rule.
    expect(
      (await send("__Secure-better-auth.session_token=A.sig", "203.0.113.10"))
        .status,
    ).toBe(429);
    // A second session on the same address is its own count.
    expect((await send("better-auth.session_token=B.sig")).status).not.toBe(
      429,
    );
  });

  test("sending a message in a room is the same door", async () => {
    const application = app();
    const turn = () =>
      application.request(`${ORIGIN}/api/channels/c1/room-turn`, {
        method: "POST",
        headers: from("203.0.113.11", {
          cookie: "better-auth.session_token=R",
        }),
      });
    for (
      let attempt = 0;
      attempt < RATE_LIMITS.message.perSession;
      attempt += 1
    ) {
      expect((await turn()).status).not.toBe(429);
    }
    expect((await turn()).status).toBe(429);
  });

  test("the anonymous trigger: per token, and per address", async () => {
    const { door } = triggerDoor();
    const fire = (token: string, address: string) =>
      door.request("/api/routines/routine_1/trigger", {
        method: "POST",
        headers: { "x-forwarded-for": address, "x-trigger-token": token },
        body: "{}",
      });
    for (
      let attempt = 0;
      attempt < RATE_LIMITS.trigger.perToken;
      attempt += 1
    ) {
      expect((await fire("token-1", `198.51.100.${attempt}`)).status).not.toBe(
        429,
      );
    }
    // One token from a fresh address: the token's own count is spent.
    expect((await fire("token-1", "198.51.100.200")).status).toBe(429);

    for (let attempt = 0; attempt < RATE_LIMITS.trigger.perIp; attempt += 1) {
      expect(
        (await fire(`other-${attempt}`, "198.51.100.250")).status,
      ).not.toBe(429);
    }
    expect((await fire("fresh-token", "198.51.100.250")).status).toBe(429);
  });

  test("the address is the last hop's, never the first entry of the header", async () => {
    // A client that writes its own X-Forwarded-For has the front door's entry put after it.
    const application = app();
    for (let attempt = 0; attempt < RATE_LIMITS.signIn.perIp; attempt += 1) {
      const response = await signInStart(
        application,
        `10.0.0.${attempt}, 203.0.113.20`,
      );
      expect(response.status).not.toBe(429);
    }
    expect(
      (await signInStart(application, "10.0.0.99, 203.0.113.20")).status,
    ).toBe(429);
  });

  test("a read is never counted, and neither is a door that is not one of the three", async () => {
    const application = app();
    for (let attempt = 0; attempt < 70; attempt += 1) {
      const read = await application.request(`${ORIGIN}/api/me`, {
        headers: from("203.0.113.30", {
          cookie: "better-auth.session_token=Z",
        }),
      });
      expect(read.status).toBe(200);
      const write = await application.request(`${ORIGIN}/api/me/onboarded`, {
        method: "POST",
        headers: from("203.0.113.30", {
          cookie: "better-auth.session_token=Z",
        }),
      });
      expect(write.status).toBe(204);
    }
  });

  test("the window closes after a minute", async () => {
    let clock = 1_000_000;
    const door = new Hono();
    door.use("*", createSecurityMiddleware({ now: () => clock }));
    door.post("/api/auth/sign-in/social", (context) =>
      context.json({ ok: true }),
    );
    const knock = () =>
      door.request("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.40" },
      });
    for (let attempt = 0; attempt < RATE_LIMITS.signIn.perIp; attempt += 1) {
      expect((await knock()).status).toBe(200);
    }
    const refused = await knock();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    clock += RATE_LIMIT_WINDOW_MS + 1;
    expect((await knock()).status).toBe(200);
  });
});
