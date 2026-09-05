import { describe, expect, test } from "bun:test";
import { describeFailure } from "../src/failure-text";

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
