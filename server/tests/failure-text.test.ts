import { describe, expect, test } from "bun:test";
import {
  describeFailure,
  noAnswerFact,
  providerStatusFact,
} from "../src/failure-text";

/** The shape drizzle-orm 0.45 throws: the SQL and its parameters in the message, pg's error on `cause`. */
class DrizzleQueryError extends Error {
  constructor(
    readonly query: string,
    readonly params: unknown[],
    override readonly cause?: Error,
  ) {
    super(`Failed query: ${query}\nparams: ${params.join(",")}`);
    this.name = "DrizzleQueryError";
  }
}

describe("describeFailure", () => {
  test("a query error never carries its SQL or its parameters", () => {
    const secret = '{"version":1,"iv":"abc","ciphertext":"THE-SECRET"}';
    const error = new DrizzleQueryError(
      "insert into credentials (encrypted_value) values ($1)",
      [secret],
      Object.assign(new Error("duplicate key"), { code: "23505" }),
    );
    const said = describeFailure(error);
    expect(said).toBe("database error (23505)");
    expect(said).not.toContain("THE-SECRET");
    expect(said).not.toContain("insert");
  });

  test("a query error without a code still says nothing about the statement", () => {
    const error = new DrizzleQueryError("select 1", ["p"]);
    expect(describeFailure(error)).toBe("database error");
  });

  test("an ordinary error keeps its message, on one line and bounded", () => {
    expect(describeFailure(new Error("The computer is\n  not running"))).toBe(
      "The computer is not running",
    );
    const long = describeFailure(new Error("x".repeat(500)));
    expect(long.length).toBeLessThanOrEqual(201);
    expect(long.endsWith("…")).toBe(true);
  });

  test("a non-error is described as nothing in particular", () => {
    expect(describeFailure("a string somebody threw")).toBe(
      "Something went wrong.",
    );
    expect(describeFailure(undefined)).toBe("Something went wrong.");
  });
});

/**
 * The OpenAI client's error family, by shape.
 *
 * The client never sets `error.name`, so the class name and the own-property triple (`status`,
 * `headers`, `error`) are what identify one. Built here rather than imported: the package is
 * `agent-bot`'s dependency, and what matters is that a bundler-renamed class with the same
 * properties is still recognised.
 */
class APIError extends Error {
  readonly status: number | undefined;
  readonly headers: Record<string, string> | undefined;
  readonly error: unknown;
  constructor(status: number | undefined, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.headers = status ? { "x-request-id": "req_1" } : undefined;
    this.error = body;
  }
}
class RateLimitError extends APIError {}
class AuthenticationError extends APIError {}
class InternalServerError extends APIError {}
class APIConnectionError extends APIError {}
class APIConnectionTimeoutError extends APIConnectionError {}
class APIUserAbortError extends APIError {}

const VENDOR_PROSE =
  "This model was ZAI's GLM-5.3 Flash, see https://openrouter.ai/zai/glm-5.3-flash";

describe("describeFailure, given a model provider's error", () => {
  test("a 429 says provider_rate_limited and nothing the provider wrote", () => {
    const said = describeFailure(
      new RateLimitError(429, { message: VENDOR_PROSE }, `429 ${VENDOR_PROSE}`),
    );
    expect(said).toBe("provider_rate_limited");
  });

  test("a refused key, an outage and a bad request are told apart", () => {
    expect(
      describeFailure(new AuthenticationError(401, {}, "401 Invalid API key")),
    ).toBe("provider_refused");
    expect(
      describeFailure(new InternalServerError(503, {}, `503 ${VENDOR_PROSE}`)),
    ).toBe("provider_unavailable (503)");
    expect(
      describeFailure(
        new APIError(400, {}, "400 reasoning_effort is not supported"),
      ),
    ).toBe("provider_rejected_request (400)");
  });

  test("no connection, a connection timeout and an abort each have their own word", () => {
    expect(
      describeFailure(
        new APIConnectionError(undefined, undefined, "Connection error."),
      ),
    ).toBe("provider_unreachable");
    expect(
      describeFailure(
        new APIConnectionTimeoutError(
          undefined,
          undefined,
          "Request timed out.",
        ),
      ),
    ).toBe("provider_timed_out");
    expect(
      describeFailure(
        new APIUserAbortError(undefined, undefined, "Request was aborted."),
      ),
    ).toBe("request_aborted");
  });

  test("the same triple under a renamed class is still a provider error", () => {
    const renamed = Object.assign(new Error(`429 ${VENDOR_PROSE}`), {
      status: 429,
      headers: {},
      error: { message: VENDOR_PROSE },
    });
    expect(describeFailure(renamed)).toBe("provider_rate_limited");
  });

  test("an error that merely has a status is not a provider error", () => {
    // `CoworkerCallError`, `McpServerError` and the route refusals carry `status` to mirror HTTP;
    // their message is this deployment's own sentence and stays.
    const routeRefusal = Object.assign(new Error("That is you."), {
      status: 400,
    });
    expect(describeFailure(routeRefusal)).toBe("That is you.");
  });

  test("askModel's four reasons read as the same facts", () => {
    expect(noAnswerFact("no credential")).toBe("no_credential");
    expect(noAnswerFact("refused")).toBe("provider_refused");
    expect(noAnswerFact("took too long")).toBe("provider_timed_out");
    expect(noAnswerFact("unreadable")).toBe("reply_unusable");
  });

  test("a provider's HTTP status reads as the same fact by either road", () => {
    expect(providerStatusFact(429)).toBe("provider_rate_limited");
    expect(providerStatusFact(403)).toBe("provider_refused");
    expect(providerStatusFact(502)).toBe("provider_unavailable (502)");
    expect(providerStatusFact(404)).toBe("provider_rejected_request (404)");
  });
});
