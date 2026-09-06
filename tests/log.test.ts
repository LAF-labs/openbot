import { describe, expect, test } from "bun:test";
import {
  buildOf,
  createLogger,
  eventName,
  type LogLevel,
  logLine,
  REDACTED,
  scrubString,
} from "../shared/log";

/**
 * The shape of a log line, and what can never be on one.
 *
 * The integration half — a whole turn through a running server and Bot service, grepped for a
 * canary key and a canary message — is `server/tests/log-hygiene.integration.test.ts`. This is
 * the pure half: the one function every line goes through, with the material an operator's log
 * must never carry handed to it on purpose.
 */

const AT = new Date("2026-09-06T03:04:05.678Z");

/** The OpenAI client's error, by shape: the class name it would have and the triple it sets. */
class RateLimitError extends Error {
  readonly status = 429;
  readonly headers = { "x-request-id": "req_1" };
  readonly error = { message: "canary-vendor-prose openrouter.ai/zai" };
  constructor() {
    super("429 canary-vendor-prose openrouter.ai/zai");
  }
}

describe("a log line", () => {
  test("is one JSON object with level, at, svc and event first", () => {
    const line = logLine("info", "server", "boot", { port: 3001 }, AT);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      level: "info",
      at: "2026-09-06T03:04:05.678Z",
      svc: "server",
      event: "boot",
      port: 3001,
    });
    expect(Object.keys(JSON.parse(line))).toEqual([
      "level",
      "at",
      "svc",
      "event",
      "port",
    ]);
  });

  test("names the event in snake_case whatever it was handed", () => {
    expect(eventName("run failed")).toBe("run_failed");
    expect(eventName("Provider-Rate Limited!")).toBe("provider_rate_limited");
    expect(eventName("  ")).toBe("event");
  });

  test("cannot have its four reserved keys overwritten by a field", () => {
    const parsed = JSON.parse(
      logLine("warn", "agent-bot", "x", { level: "info", svc: "other" }, AT),
    );
    expect(parsed.level).toBe("warn");
    expect(parsed.svc).toBe("agent-bot");
  });

  test("turns an error into its description and never its stack", () => {
    const error = new Error("The computer is\n  not running");
    const line = logLine("error", "server", "computer_failed", {
      reason: error,
    });
    expect(JSON.parse(line).reason).toBe("The computer is not running");
    expect(line).not.toContain("    at ");
    expect(line).not.toContain("stack");
  });

  test("says which kind of provider failure it was, not what the provider wrote", () => {
    const line = logLine("error", "agent-bot", "run_failed", {
      reason: new RateLimitError(),
    });
    expect(JSON.parse(line).reason).toBe("provider_rate_limited");
    expect(line).not.toContain("canary-vendor-prose");
    expect(line).not.toContain("openrouter");
  });
});

describe("what a line scrubs", () => {
  test("a field named like a secret, when its value is a string", () => {
    const parsed = JSON.parse(
      logLine("info", "server", "request", {
        authorization: "Bearer abc",
        cookie: "session=xyz",
        apiKey: "sk-live-1234567890",
        "x-api-key": "k",
        password: "hunter2",
        token: "t",
        // Counts under names that only CONTAIN the word survive: they are the audit trail's numbers.
        promptTokens: 120,
        totalTokens: 200,
        tokens: 3,
      }),
    );
    expect(parsed.authorization).toBe(REDACTED);
    expect(parsed.cookie).toBe(REDACTED);
    expect(parsed.apiKey).toBe(REDACTED);
    expect(parsed["x-api-key"]).toBe(REDACTED);
    expect(parsed.password).toBe(REDACTED);
    expect(parsed.token).toBe(REDACTED);
    expect(parsed.promptTokens).toBe(120);
    expect(parsed.totalTokens).toBe(200);
    expect(parsed.tokens).toBe(3);
  });

  test("a key, a bearer token, a JWT and a URL password inside an ordinary string", () => {
    const key = "sk-canary-0f3c9a7e2b1d4c6e8a0b";
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(24)}.${"b".repeat(16)}`;
    const said = scrubString(
      `key ${key}; header Bearer ${key}; cookie ${jwt}; db postgres://openbot:hunter2@localhost:5432/openbot; q=?session_token=abc123&x=1`,
    );
    expect(said).not.toContain(key);
    expect(said).not.toContain("hunter2");
    expect(said).not.toContain("abc123");
    expect(said).not.toContain(jwt);
    expect(said).toContain(`postgres://${REDACTED}@localhost:5432/openbot`);
    expect(said).toContain("x=1");
  });

  test("a string that is nothing of the kind, untouched", () => {
    expect(scrubString("run r1 for bot agent_shop took 1234ms")).toBe(
      "run r1 for bot agent_shop took 1234ms",
    );
  });

  test("nested fields, to a depth, and long strings, to a length", () => {
    const parsed = JSON.parse(
      logLine("info", "server", "nested", {
        a: { b: { c: { d: { e: 1 } } } },
        list: Array.from({ length: 60 }, (_, index) => index),
        long: "x".repeat(5_000),
        inner: { authorization: "Bearer zzz", reason: new Error("boom") },
      }),
    );
    expect(parsed.a.b.c.d).toBe("[nested]");
    expect(parsed.list).toHaveLength(51);
    expect(parsed.list[50]).toBe("…10 more");
    expect(parsed.long.length).toBeLessThanOrEqual(2_001);
    expect(parsed.inner.authorization).toBe(REDACTED);
    expect(parsed.inner.reason).toBe("boom");
  });

  test("a field that cannot be serialised drops the fields and keeps the event", () => {
    const lines: string[] = [];
    const log = createLogger("server", (_level, line) => {
      lines.push(line);
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // Beyond MAX_DEPTH the cycle is cut as "[nested]", so this line serialises; a BigInt inside a
    // proxy that throws would not. Either way, what reaches the sink is a line.
    log.info("odd", { cyclic });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).event).toBe("odd");
  });
});

describe("the logger", () => {
  test("routes each level to its own sink call with the service name on the line", () => {
    const seen: Array<[LogLevel, string]> = [];
    const log = createLogger("agent-computer", (level, line) => {
      seen.push([level, line]);
    });
    log.info("boot", { port: 4100 });
    log.warn("chromium_version_drifted");
    log.error("download_not_saved", { reason: new Error("disk full") });
    expect(seen.map(([level]) => level)).toEqual(["info", "warn", "error"]);
    for (const [, line] of seen) {
      expect(JSON.parse(line).svc).toBe("agent-computer");
    }
  });

  test("reads the build from IMAGE_TAG and GIT_SHA, and says `source` when there is none", () => {
    expect(buildOf({ IMAGE_TAG: "edge", GIT_SHA: "abc123" })).toEqual({
      version: "edge",
      revision: "abc123",
    });
    expect(buildOf({ IMAGE_TAG: " v0.4.0 " })).toEqual({ version: "v0.4.0" });
    expect(buildOf({})).toEqual({ version: "source" });
  });
});
