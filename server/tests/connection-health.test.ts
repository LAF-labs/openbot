import { describe, expect, test } from "bun:test";
import {
  type HealthReason,
  healthFrom,
  healthOf,
  judgeHealth,
  needsReconnect,
} from "../src/plugins/connection-health";
import { McpServerError } from "../src/plugins/mcp";
import {
  INVALID_CLIENT,
  PluginRefusedError,
  TokenRefusedError,
} from "../src/plugins/store";

/**
 * The one table that decides what a failure means for a connection, walked row by row.
 *
 * Every reason an adapter can raise is here, because the two lies the audit of 2026-09-10 measured
 * (A9, F2 and F3) were both a reason nobody had written a row for: a token endpoint's 503 fell
 * through to "any other refusal", and a vendor API's 401 was never handed to the judge at all. A
 * reason added to an adapter without a row here should be visible as a missing test, not as a
 * card saying 연결됨 beside a Bot that fails every call.
 */

const refused = (code: string | null, status: number) =>
  new TokenRefusedError(`the vendor said no (${status})`, code, status);

const timeout = () => {
  const error = new Error("The operation timed out.");
  error.name = "TimeoutError";
  return error;
};

const exchange = (error: unknown): HealthReason => ({ at: "exchange", error });
const vendor = (status: number): HealthReason => ({ at: "vendor", status });

describe("judgeHealth: every reason the adapters raise, judged once", () => {
  const table: [string, HealthReason, ReturnType<typeof judgeHealth>][] = [
    // Ours, not the vendor's verdict on anything.
    [
      "a refusal of ours (the grant was withdrawn mid-queue)",
      exchange(
        new PluginRefusedError("withdrawn", null, "laf:grant_withdrawn"),
      ),
      null,
    ],
    // The deployment's client, not this person's grant — recorded nowhere, by design.
    [
      "the vendor disowning the deployment's client",
      exchange(refused(INVALID_CLIENT, 401)),
      null,
    ],
    [
      "the vendor disowning the client under an outage status",
      exchange(refused(INVALID_CLIENT, 503)),
      null,
    ],
    // F2: the token endpoint cannot answer anybody. Comes back on its own; nobody reconnects.
    [
      "token endpoint 503 with a code in the body",
      exchange(refused("internal_failure", 503)),
      "vendor_down",
    ],
    [
      "token endpoint 502 with HTML for a body (no code at all)",
      exchange(refused(null, 502)),
      "vendor_down",
    ],
    [
      "token endpoint 429",
      exchange(refused("rate_limited", 429)),
      "vendor_down",
    ],
    [
      "a 500 whose body happens to say invalid_grant",
      exchange(refused("invalid_grant", 500)),
      "vendor_down",
    ],
    // The grant is gone. RFC 6749 §5.2's one word for it.
    [
      "invalid_grant on a 400",
      exchange(refused("invalid_grant", 400)),
      "revoked",
    ],
    [
      "invalid_grant with no status (a caller from before statuses travelled)",
      exchange(new TokenRefusedError("the vendor said no", "invalid_grant")),
      "revoked",
    ],
    // Anything else the endpoint considered and refused: another call will not fix it.
    [
      "invalid_scope",
      exchange(refused("invalid_scope", 400)),
      "refresh_failed",
    ],
    [
      "unauthorized_client",
      exchange(refused("unauthorized_client", 400)),
      "refresh_failed",
    ],
    ["a 400 with no code", exchange(refused(null, 400)), "refresh_failed"],
    [
      "a refusal with neither code nor status",
      exchange(new TokenRefusedError("the vendor said no", null)),
      "refresh_failed",
    ],
    // Not the vendor refusing: nothing reached it, or what came back was not a token.
    ["a timeout", exchange(timeout()), "vendor_down"],
    ["DNS", exchange(new Error("getaddrinfo ENOTFOUND")), "vendor_down"],
    [
      "a 200 that was not a token",
      exchange(
        new McpServerError(
          "The vendor answered this renewal with something other than a token.",
        ),
      ),
      "vendor_down",
    ],
    ["something that is not even an Error", exchange("boom"), "vendor_down"],
    // F3: the API's answer after a good exchange.
    ["the API answering 401", vendor(401), "refresh_failed"],
    ["the API answering 403 (API not enabled, or scope)", vendor(403), null],
    ["the API answering 404", vendor(404), null],
    ["the API answering 400", vendor(400), null],
    ["the API answering 429", vendor(429), "vendor_down"],
    ["the API answering 500", vendor(500), "vendor_down"],
    ["the API answering 503", vendor(503), "vendor_down"],
    ["the API answering 200 with isError", vendor(200), null],
  ];

  for (const [name, reason, expected] of table) {
    test(`${name} → ${expected ?? "nothing recorded"}`, () => {
      expect(judgeHealth(reason)).toBe(expected);
    });
  }

  test("only the two codes a person can answer ask for a reconnect", () => {
    expect(needsReconnect("revoked")).toBe(true);
    expect(needsReconnect("refresh_failed")).toBe(true);
    expect(needsReconnect("vendor_down")).toBe(false);
    expect(needsReconnect(null)).toBe(false);
    expect(needsReconnect("something_a_later_build_wrote")).toBe(false);
  });
});

describe("the health read off the row", () => {
  test("a transient failure is reported and still ok", () => {
    expect(
      healthOf({
        lastOkAt: new Date("2026-09-01T00:00:00Z"),
        lastFailureAt: new Date("2026-09-02T00:00:00Z"),
        lastFailureCode: "vendor_down",
      }),
    ).toEqual({
      status: "ok",
      lastOkAt: "2026-09-01T00:00:00.000Z",
      lastFailureAt: "2026-09-02T00:00:00.000Z",
      failureCode: "vendor_down",
    });
  });

  test("a code this build does not know is no code at all, and never a reconnect", () => {
    expect(
      healthOf({
        lastOkAt: null,
        lastFailureAt: null,
        lastFailureCode: "laf:something_new",
      }),
    ).toMatchObject({ status: "ok", failureCode: null });
  });

  test("a serialised health reads back the same, and nothing reads as broken", () => {
    expect(healthFrom(undefined)).toEqual({
      status: "ok",
      lastOkAt: null,
      lastFailureAt: null,
      failureCode: null,
    });
    expect(
      healthFrom({
        status: "needs_reconnect",
        lastOkAt: "2026-09-01T00:00:00.000Z",
        lastFailureAt: "2026-09-04T00:00:00.000Z",
        failureCode: "refresh_failed",
      }),
    ).toEqual({
      status: "needs_reconnect",
      lastOkAt: "2026-09-01T00:00:00.000Z",
      lastFailureAt: "2026-09-04T00:00:00.000Z",
      failureCode: "refresh_failed",
    });
    // A word the surface has no Korean for is dropped rather than shown as itself.
    expect(healthFrom({ status: "ok", failureCode: "laf:x" }).failureCode).toBe(
      null,
    );
  });
});
