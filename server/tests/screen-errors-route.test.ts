import { describe, expect, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createLogger, type LogLevel } from "../../shared/log";
import { SCREEN_ERROR_MAX_BYTES } from "../../shared/screen-errors";
import type { AuditStore } from "../src/audit";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
  UNAUTHENTICATED,
} from "../src/auth/guards";
import { recentLines } from "../src/log";
import {
  BODY_TOO_LARGE,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMITED,
} from "../src/middleware/security";
import { assembleDiagnostics } from "../src/support/diagnostics";
import type { FeedbackStore } from "../src/support/feedback";
import { createSupportRoutes } from "../src/support/routes";
import {
  createScreenErrorRoutes,
  SCREEN_ERROR_MALFORMED,
  SCREEN_ERRORS_PER_SESSION,
  SCREEN_FAILED,
} from "../src/support/screen-errors";

/**
 * `POST /api/support/screen-errors`, as the app reaches it — and as anything else would.
 *
 * The guard is the real one (`createRequireUser`) over a sign-in that knows one cookie, so "nobody
 * signed in" is refused the way a deployment refuses it. Then the three limits in the order a
 * request meets them: the rate per session, the size of the body, and the shape of every field. A
 * report that does not fit is not partly kept — the log is read after each refusal and must have no
 * line — and one that does is written as one line of facts, which the last test follows into the
 * tail the 문의·의견 box's diagnostic details are read from.
 */

const PERSON = { id: "owner-user", email: "owner@laf.test", name: "Owner" };
const SESSION = "better-auth.session_token=session-one";

/** Sign-in, reduced to the question the guard asks: is there a session in this cookie? */
const auth: AuthService = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async ({ headers }) =>
      headers.get("cookie")?.includes("better-auth.session_token=")
        ? { user: PERSON }
        : null,
  },
};

const requireUser = createRequireUser(auth, {
  rolesForUser: async () => ["user"],
});

const REPORT = {
  section: "sidebar",
  route: "/channel/$channelId",
  kind: "TypeError",
  fingerprint: "a41c09e2b7f3",
  build: "v0.5.1",
  revision: "eeea9853c2d1",
  surface: "shell",
} as const;

function door(options: { now?: () => number } = {}) {
  const lines: Array<{ level: LogLevel; line: string }> = [];
  const log = createLogger("server", (level, line) => {
    lines.push({ level, line });
  });
  const app = new Hono<{ Variables: AppVariables }>().route(
    "/api/support/screen-errors",
    createScreenErrorRoutes(requireUser, { log, ...options }),
  );
  return { app, lines };
}

/**
 * A body sent the way a browser's `fetch` sends one: with its length declared. `app.request` builds
 * a request that has not been on a wire, so the header a real one carries is written here.
 */
const send = (
  app: Hono<{ Variables: AppVariables }>,
  body: unknown,
  cookie: string | null = SESSION,
) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return app.request("/api/support/screen-errors", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(text).byteLength),
      ...(cookie ? { cookie } : {}),
    },
    body: text,
  });
};

describe("a report the route takes", () => {
  test("is written as one line of facts under the person who sent it, and answered with nothing", async () => {
    const { app, lines } = door();
    const response = await send(app, REPORT);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("warn");
    const line = JSON.parse(lines[0]?.line ?? "{}") as Record<string, unknown>;
    const { at, ...rest } = line;
    expect(typeof at).toBe("string");
    expect(rest).toEqual({
      level: "warn",
      svc: "server",
      event: SCREEN_FAILED,
      user: PERSON.id,
      ...REPORT,
    });
  });

  test("with only what it must have, still one line", async () => {
    const { app, lines } = door();
    const response = await send(app, {
      section: "window_error",
      kind: "string",
      fingerprint: "000000000000",
      surface: "browser",
    });
    expect(response.status).toBe(204);
    expect(lines).toHaveLength(1);
  });
});

describe("what the route refuses, and writes nothing for", () => {
  test("nobody signed in", async () => {
    const { app, lines } = door();
    const response = await send(app, REPORT, null);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: UNAUTHENTICATED });
    // A cookie that names no session is nobody too.
    const stranger = await send(app, REPORT, "theme=dark");
    expect(stranger.status).toBe(401);
    expect(lines).toEqual([]);
  });

  test("a body past two kilobytes, whether it says how long it is or not", async () => {
    const { app, lines } = door();
    const padded = { ...REPORT, pad: "x".repeat(SCREEN_ERROR_MAX_BYTES) };
    const declared = await send(app, padded);
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual(BODY_TOO_LARGE);

    // Chunked: no length to refuse on, so it is counted as it is read, and refused all the same.
    const text = JSON.stringify(padded);
    const chunked = await app.request("/api/support/screen-errors", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: SESSION },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(413);
    expect(lines).toEqual([]);
  });

  test.each([
    [
      "a message, with a password and a Korean sentence in it",
      {
        ...REPORT,
        message: "Invalid URL: 'https://shop.example/?pw=hunter2' 사장님",
      },
    ],
    ["a stack", { ...REPORT, stack: "at x (http://h/a.js:1:1)" }],
    [
      "a route with an id in it",
      { ...REPORT, route: "/channel/0f9c2d4e-7a1b" },
    ],
    [
      "a route with a query",
      { ...REPORT, route: "/settings/account?tab=delete" },
    ],
    ["a route that is null", { ...REPORT, route: null }],
    [
      "a part of the screen there is no such part as",
      {
        ...REPORT,
        section: "toolbar",
      },
    ],
    ["a kind that is a sentence", { ...REPORT, kind: "Invalid URL: x" }],
    ["a kind in Korean", { ...REPORT, kind: "비밀번호오류" }],
    ["a kind that is only a word", { ...REPORT, kind: "Hunter2" }],
    ["a fingerprint in capitals", { ...REPORT, fingerprint: "A41C09E2B7F3" }],
    ["a fingerprint too long", { ...REPORT, fingerprint: "a41c09e2b7f30" }],
    ["a fingerprint that is words", { ...REPORT, fingerprint: "hunter2hunt" }],
    ["a build that is a word", { ...REPORT, build: "hunter2" }],
    ["a build with a space", { ...REPORT, build: "v0.5.1 beta" }],
    ["a revision that is not hex", { ...REPORT, revision: "zzzzzzz" }],
    [
      "a surface there is no such surface as",
      {
        ...REPORT,
        surface: "tablet",
      },
    ],
    ["no section", { ...REPORT, section: undefined }],
    ["no fingerprint", { ...REPORT, fingerprint: undefined }],
    ["a list of reports", [REPORT]],
    ["null", null],
    ["not JSON", "section=sidebar"],
  ])("%s", async (_label, body) => {
    const { app, lines } = door();
    const response = await send(app, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: SCREEN_ERROR_MALFORMED,
      code: SCREEN_ERROR_MALFORMED,
    });
    expect(lines).toEqual([]);
  });
});

describe("the rate, per session", () => {
  test(`${SCREEN_ERRORS_PER_SESSION} a minute; the next waits and says how long; another session does not; the window reopens`, async () => {
    let clock = 1_000_000;
    const { app, lines } = door({ now: () => clock });

    // A refused report is spent against the session like any other.
    expect((await send(app, { ...REPORT, section: "toolbar" })).status).toBe(
      400,
    );
    for (let sent = 1; sent < SCREEN_ERRORS_PER_SESSION; sent += 1) {
      expect((await send(app, REPORT)).status).toBe(204);
    }
    const refused = await send(app, REPORT);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual(RATE_LIMITED);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(lines).toHaveLength(SCREEN_ERRORS_PER_SESSION - 1);

    // The same person in the desktop app and a browser tab is two sessions.
    expect(
      (await send(app, REPORT, "better-auth.session_token=session-two")).status,
    ).toBe(204);

    clock += RATE_LIMIT_WINDOW_MS;
    expect((await send(app, REPORT)).status).toBe(204);
  });
});

describe("where the line goes", () => {
  test("mounted with the 문의·의견 box, into the tail its diagnostic details read — facts in, nothing else", async () => {
    // The server's own logger prints every line; this one is expected, and kept off the test output.
    const printed = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
        context,
        next,
      ) => {
        context.set("actor", { ...PERSON, role: "user" });
        await next();
      };
      const auditStore: AuditStore = { insert: async () => {} };
      const feedback: FeedbackStore = {
        record: async () => {
          throw new Error("a screen error writes no feedback");
        },
      };
      const app = new Hono<{ Variables: AppVariables }>().route(
        "/api/support",
        createSupportRoutes({ feedback, auditStore }, signedIn),
      );
      const before = recentLines.lines().length;
      const response = await send(app, REPORT);
      expect(response.status).toBe(204);

      const written = recentLines.lines().slice(before);
      expect(written).toHaveLength(1);
      expect(written[0]).toContain(`"event":"${SCREEN_FAILED}"`);
      expect(printed).toHaveBeenCalledTimes(1);

      const bundle = assembleDiagnostics({
        lines: recentLines.lines(),
        ownership: {
          user: new Set([PERSON.id]),
          bot: new Set(),
          run: new Set(),
          thread: new Set(),
          channel: new Set(),
          routine: new Set(),
        },
        runs: [],
        failedRuns: [],
        version: { version: "v0.5.1" },
        health: { status: "ok", checks: {} },
        now: new Date(),
      });
      const screens = bundle.events.filter(
        (event) => event.event === SCREEN_FAILED,
      );
      expect(screens.at(-1)).toMatchObject({
        source: "log",
        level: "warn",
        svc: "server",
        ...REPORT,
      });
      // Who it was is how it was found, and is not carried: the bundle is theirs already.
      expect(screens.at(-1)).not.toHaveProperty("user");
    } finally {
      printed.mockRestore();
    }
  });
});
