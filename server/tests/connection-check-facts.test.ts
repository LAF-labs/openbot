import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  CONNECTION_CHECKS,
  type ConnectionCheckFacts,
  errorClassOf,
  readConnectionCheck,
} from "../../shared/support/connection-check";
import type { AppVariables } from "../src/auth/guards";
import {
  assembleDiagnostics,
  type DiagnosticBundle,
  type DiagnosticsSource,
} from "../src/support/diagnostics";
import { createSupportRoutes } from "../src/support/routes";

/**
 * 연결 점검's result, as the server lets it in: the one part of a diagnostics bundle the browser
 * writes, read through a closed vocabulary before anything is kept.
 *
 * The diagnostics header says why the client never sends free text to that bundle — what a browser
 * assembles, a browser can fill with anything. So what is tested here is that nothing but the
 * vocabulary gets through: a sentence where a code goes, a key nobody named, a number out of range,
 * and each is refused whole rather than trimmed into something that looks like the person's.
 */

const SENTENCE = "비밀번호가 틀렸습니다 password=hunter2";

const FACTS: ConnectionCheckFacts = {
  at: "2026-09-18T10:00:00.000Z",
  surface: "shell",
  checks: [
    {
      id: "server",
      state: "pass",
      reason: "answered",
      ms: 84,
      http: 200,
    },
    { id: "botService", state: "fail", reason: "down" },
    {
      id: "conversationSocket",
      state: "fail",
      reason: "not_opened",
      ms: 5012,
      close: 1006,
    },
    { id: "session", state: "fail", reason: "no_answer", error: "TypeError" },
    { id: "clock", state: "fail", reason: "skewed", skewMs: -312_000 },
  ],
};

describe("reading a check's result", () => {
  test("keeps a result made of the vocabulary, as it was", () => {
    expect(readConnectionCheck(FACTS)).toEqual(FACTS);
    expect(readConnectionCheck(JSON.parse(JSON.stringify(FACTS)))).toEqual(
      FACTS,
    );
  });

  test("rebuilds it from the fields it names, so a key nobody named is not carried", () => {
    const read = readConnectionCheck({
      ...FACTS,
      note: SENTENCE,
      checks: FACTS.checks.map((check) => ({ ...check, message: SENTENCE })),
    });
    expect(read).toEqual(FACTS);
    expect(JSON.stringify(read)).not.toContain("hunter2");
  });

  test("refuses the whole of it when one field is off the list", () => {
    const withCheck = (change: Record<string, unknown>) => ({
      ...FACTS,
      checks: [{ ...FACTS.checks[0], ...change }, ...FACTS.checks.slice(1)],
    });
    for (const off of [
      withCheck({ reason: SENTENCE }),
      withCheck({ reason: "answered but also something else" }),
      withCheck({ state: "passed" }),
      withCheck({ id: "password" }),
      withCheck({ error: "TypeError: Failed to fetch https://x.test/?t=1" }),
      withCheck({ ms: -1 }),
      withCheck({ ms: 1.5 }),
      withCheck({ ms: "84" }),
      withCheck({ http: 700 }),
      withCheck({ close: 999 }),
      withCheck({ skewMs: Number.MAX_SAFE_INTEGER }),
      { ...FACTS, at: SENTENCE },
      { ...FACTS, at: "2026-09-18" },
      { ...FACTS, surface: "phone" },
      { ...FACTS, checks: [] },
      { ...FACTS, checks: [FACTS.checks[0], FACTS.checks[0]] },
      {
        ...FACTS,
        checks: [...CONNECTION_CHECKS, "server"].map((id) => ({
          id,
          state: "skip",
          reason: "no_server",
        })),
      },
      null,
      "connection-check server pass",
      [FACTS],
    ]) {
      expect(readConnectionCheck(off)).toBeNull();
    }
  });

  test("an error is kept by its class, never its message", () => {
    expect(errorClassOf(new TypeError(SENTENCE))).toBe("TypeError");
    expect(errorClassOf(new DOMException(SENTENCE, "AbortError"))).toBe(
      "AbortError",
    );
    const named = new Error(SENTENCE);
    named.name = SENTENCE;
    expect(errorClassOf(named)).toBe("Other");
    expect(errorClassOf(SENTENCE)).toBe("Other");
    expect(errorClassOf(undefined)).toBe("Other");
  });
});

describe("the bundle", () => {
  test("carries the result it was handed, and nothing when it was handed none", () => {
    const base = {
      lines: [],
      ownership: {
        bot: new Set<string>(),
        run: new Set<string>(),
        thread: new Set<string>(),
        channel: new Set<string>(),
        routine: new Set<string>(),
      },
      runs: [],
      failedRuns: [],
      version: { version: "v0.5.1" },
      health: { status: "ok" as const, checks: {} },
      now: new Date("2026-09-18T10:01:00.000Z"),
    };
    expect(
      assembleDiagnostics({ ...base, connectionCheck: FACTS }).connectionCheck,
    ).toEqual(FACTS);
    expect("connectionCheck" in assembleDiagnostics(base)).toBe(false);
  });
});

describe("GET /api/support/diagnostics?connectionCheck=", () => {
  const surface = () => {
    const handed: unknown[] = [];
    const diagnostics: DiagnosticsSource = {
      assemble: async (_userId, deployment, connectionCheck) => {
        handed.push(connectionCheck ?? null);
        return {
          assembledAt: "2026-09-18T10:01:00.000Z",
          version: deployment.version,
          health: deployment.health,
          failureWindowDays: 7,
          failures: [],
          events: [],
          ...(connectionCheck ? { connectionCheck } : {}),
        } satisfies DiagnosticBundle;
      },
    };
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: "owner-user",
        email: "owner@laf.test",
        role: "user",
      });
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/support",
      createSupportRoutes(
        {
          feedback: {
            record: async () => ({ id: "feedback-1", createdAt: new Date() }),
          },
          auditStore: { insert: async () => {} },
          diagnostics,
        },
        requireUser,
        {
          version: { version: "v0.5.1" },
          health: async () => ({ status: "ok", checks: {} }),
        },
      ),
    );
    const ask = async (query: string) => {
      const response = await app.request(`/api/support/diagnostics${query}`);
      return (await response.json()) as { diagnostics: DiagnosticBundle };
    };
    return { handed, ask };
  };

  const encoded = (value: unknown) =>
    `?connectionCheck=${encodeURIComponent(JSON.stringify(value))}`;

  test("puts the window's result in the bundle the person is shown, read through the vocabulary", async () => {
    const { handed, ask } = surface();
    const body = await ask(
      encoded({
        ...FACTS,
        checks: FACTS.checks.map((check) => ({ ...check, note: SENTENCE })),
      }),
    );

    expect(handed).toEqual([FACTS]);
    expect(body.diagnostics.connectionCheck).toEqual(FACTS);
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  test("assembles without one when what came is not a result — and never refuses the read for it", async () => {
    const { handed, ask } = surface();
    const answers = await Promise.all([
      ask(""),
      ask(encoded({ ...FACTS, surface: SENTENCE })),
      ask(`?connectionCheck=${encodeURIComponent("{not json")}`),
      ask(`?connectionCheck=${"x".repeat(4_001)}`),
    ]);

    expect(handed).toEqual([null, null, null, null]);
    for (const body of answers) {
      expect("connectionCheck" in body.diagnostics).toBe(false);
      expect(JSON.stringify(body)).not.toContain("hunter2");
    }
  });
});
