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
    for (const ordinary of [
      "run r1 for bot agent_shop took 1234ms",
      // The short names only as a parameter's whole name: a sort key is not a key, an exit code
      // is not an OAuth grant, and a monkey is not anything.
      "sorted by monkey=name and hotkey=ctrl; exit code=1",
      "https://shop.example/orders?page=2&sort=recent#top",
      // A Korean sentence ABOUT a password is the site's message, not the password.
      "비밀번호가 일치하지 않습니다",
    ]) {
      expect(scrubString(ordinary)).toBe(ordinary);
    }
  });

  /*
   * THE AUDITOR'S TABLE (A5 §6, 2026-09-10). Twenty-six values went into `scrubString` and twelve
   * came back whole, against a document that promised "a URL with a password in it is cut where
   * the secret starts". The audit names the twelve kinds that got through and the six that were
   * caught, and gives one of them byte for byte (the first row); the rest are those kinds written
   * out. Every row is a value, the secret in it that must be gone, and — where there is one — an
   * ordinary neighbour that must survive, because a scrubber that eats the whole line is a log
   * nobody can read either.
   */
  const PEM = [
    "-----BEGIN PRIVATE KEY-----",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7pemcanary",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const JWT = `eyJhbGciOiJIUzI1NiJ9.${"c".repeat(24)}.${"d".repeat(16)}`;
  const MISSED: Array<[value: string, gone: string, kept?: string]> = [
    [
      "https://shop.example/login?user=kim&password=Hunter2!",
      "Hunter2",
      "user=kim",
    ],
    [
      "https://admin.example/login.php?id=kim&pwd=Hunter2&menu=orders",
      "Hunter2",
      "menu=orders",
    ],
    [
      "https://api.example/v1/stores?api_key=AKX-canary-123&page=2",
      "AKX-canary-123",
      "page=2",
    ],
    [
      "https://maps.example/js?key=KEYCANARY99&callback=init",
      "KEYCANARY99",
      "callback=init",
    ],
    ["PHPSESSID=9f8e7d6c5b4a3f2e; lang=ko", "9f8e7d6c5b4a3f2e", "lang=ko"],
    [
      "aws_secret_access_key = wJalrXUtnFEMIcanaryK7MDENG",
      "wJalrXUtnFEMIcanary",
    ],
    [`boot with ${PEM} loaded`, "MIIEvQIBADAN", "boot with"],
    ["token ghp_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f", "1a2b3c4d5e6f", "token"],
    [
      "slack xoxb-123456789012-1234567890123-AbCdEfGhIjKl",
      "123456789012",
      "slack",
    ],
    ["KakaoAK 0123456789abcdef0123456789abcdef", "0123456789abcdef"],
    [
      "LAF_ALIMTALK_API_KEY=NCSCANARYKEY0001:SOLAPICANARYSECRET0123456789ABCD",
      "SOLAPICANARYSECRET",
    ],
    ["사장님 비밀번호는 Hunter2!입니다", "Hunter2"],
  ];
  const CAUGHT: Array<[value: string, gone: string, kept?: string]> = [
    ["key sk-canary-0f3c9a7e2b1d4c6e8a0b in use", "canary-0f3c9a7e", "in use"],
    ["키는sk-or-v1-abcdef1234567890입니다", "abcdef1234567890"],
    [`cookie ${JWT}`, JWT.slice(0, 30), "cookie"],
    [
      `https://app.example/callback#id_token=${JWT}&state=s1`,
      JWT.slice(0, 30),
      "state=s1",
    ],
    [
      "postgres://openbot:hunter2@localhost:5432/openbot",
      "hunter2",
      "@localhost:5432/openbot",
    ],
    ["header Bearer abc.def-ghi_canary", "abc.def-ghi_canary", "header"],
    ["?session_token=abc123canary&x=1", "abc123canary", "x=1"],
    [
      "https://oauth2.example/token?refresh_token=1//0gcanary&grant_type=refresh_token",
      "1//0gcanary",
      "grant_type=",
    ],
  ];
  // What an Authorization looks like when it is not in a header object: written into a string.
  const AUTHORIZATION: Array<[value: string, gone: string, kept?: string]> = [
    ["Authorization: Basic dXNlcjpwYXNzY2FuYXJ5", "dXNlcjpwYXNz"],
    [
      "authorization: HMAC-SHA256 apiKey=NCSCANARY, date=2026-09-10, salt=s, signature=deadbeefcanary",
      "deadbeefcanary",
    ],
    ["X-API-Key: k-canary-777", "k-canary-777"],
    ["x-openbot-computer-token: laf-local-dev-canary", "laf-local-dev-canary"],
    ["x-trigger-token: trg_canary_9", "trg_canary_9"],
    [
      'provider said {"error":"bad","access_token":"ya29.canary","token_type":"Bearer"}',
      "ya29.canary",
      '"error":"bad"',
    ],
    [
      "https://bucket.example/o?X-Amz-Credential=AKIDcanary&X-Amz-Signature=5ig5canary&x=1",
      "5ig5canary",
      "x=1",
    ],
    [
      "https://app.example/callback?code=4/0AX4XfWh-canary&state=abc",
      "4/0AX4XfWh",
      "state=abc",
    ],
    ["password: Hunter2! was rejected", "Hunter2", "was rejected"],
    ["인증번호=482913 발송", "482913", "발송"],
  ];

  // Three columns always: bun hands a `done` callback where a shorter row leaves a parameter empty.
  const rows = (table: Array<[string, string, string?]>) =>
    table.map(([value, gone, kept]) => [value, gone, kept ?? ""]);

  test.each(rows(MISSED))(
    "cuts what the first shapes let through: %j",
    (value, gone, kept) => {
      const said = scrubString(value);
      expect(said).not.toContain(gone);
      expect(said).toContain(REDACTED);
      if (kept) expect(said).toContain(kept);
    },
  );

  test.each(rows(CAUGHT))(
    "still cuts what they caught: %j",
    (value, gone, kept) => {
      const said = scrubString(value);
      expect(said).not.toContain(gone);
      if (kept) expect(said).toContain(kept);
    },
  );

  test.each(rows(AUTHORIZATION))(
    "cuts a credential written into a string or a URL: %j",
    (value, gone, kept) => {
      const said = scrubString(value);
      expect(said).not.toContain(gone);
      expect(said).toContain(REDACTED);
      if (kept) expect(said).toContain(kept);
    },
  );

  test("every row at once, through a whole line, leaves nothing behind", () => {
    const table = [...MISSED, ...CAUGHT, ...AUTHORIZATION];
    const line = logLine("warn", "server", "scrub_table", {
      said: table.map(([value]) => value).join(" | "),
    });
    for (const [, gone] of table) {
      expect(line).not.toContain(gone);
    }
  });

  test("a long string costs a bounded amount of work, and is still scrubbed at its start", () => {
    // A hundred thousand dots took one shape five seconds, and the first shapes twenty.
    for (const long of ["a.".repeat(50_000), `"${"a-".repeat(50_000)}`]) {
      const started = performance.now();
      scrubString(long);
      expect(performance.now() - started).toBeLessThan(250);
    }
    const said = scrubString(`?password=Hunter2&x=1 ${"a.".repeat(50_000)}`);
    expect(said).not.toContain("Hunter2");
    expect(said.length).toBeLessThanOrEqual(2_001);
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
      channel: "edge",
    });
    expect(buildOf({ IMAGE_TAG: " v0.4.0 " })).toEqual({
      version: "v0.4.0",
      channel: "v0.4.0",
    });
    expect(buildOf({})).toEqual({ version: "source" });
  });

  /*
   * What was BUILT outranks what was PULLED: a VM on `IMAGE_TAG=stable` runs some `vX.Y.Z`, and
   * "stable" is the name of the channel that delivered it, not of the build. The image bakes the
   * build in (server/Dockerfile, `BUILD_CHANNEL`); a local build bakes an empty string, which is
   * absent, not a version called "".
   */
  test("prefers the baked build to the compose channel, and treats an empty bake as none", () => {
    expect(
      buildOf({
        BUILD_CHANNEL: "v0.4.5",
        IMAGE_TAG: "stable",
        GIT_SHA: "dba36c3",
      }),
    ).toEqual({ version: "v0.4.5", revision: "dba36c3", channel: "stable" });
    expect(
      buildOf({ BUILD_CHANNEL: "", GIT_SHA: "", IMAGE_TAG: "edge" }),
    ).toEqual({
      version: "edge",
      channel: "edge",
    });
    expect(buildOf({ BUILD_CHANNEL: "", GIT_SHA: "" })).toEqual({
      version: "source",
    });
  });
});
