import { describe, expect, test } from "bun:test";
import {
  BOUNDARY_REFUSALS,
  refusalText,
  SECRET_REFUSALS,
} from "../src/lib/computer/refusals";
import { ko } from "../src/lib/i18n-ko";

/**
 * What the computer's routes refuse, as the three screens that used to print the server's English.
 *
 * Until 2026-09-14 the masked box printed "A value is required." and the container's "That value
 * could not be entered: the field is no longer on the page…", the Boundaries page printed "deny must
 * be a list of expressions.", and the Computers page "The assistant's computer is not running." The
 * routes send `laf:` codes and no prose now; these tables own the sentences. `t()` on a variable is
 * invisible to `i18n-coverage.test.ts`, so the tables are walked here, against the server's source
 * rather than a copy of it.
 */

const server = (path: string) =>
  Bun.file(
    new URL(`../../server/src/computer/${path}`, import.meta.url),
  ).text();

const codesIn = (source: string, pattern: RegExp) =>
  new Set([...source.matchAll(pattern)].map((match) => match[1] as string));

describe("the computer refusal copy", () => {
  test("every sentence in both tables has Korean", () => {
    const missing = [
      ...Object.values(SECRET_REFUSALS),
      ...Object.values(BOUNDARY_REFUSALS),
    ].filter((sentence) => !(sentence in ko));
    expect(missing).toEqual([]);
  });

  test("the boundary table names every refusal saving a policy can meet", async () => {
    const codes = codesIn(
      `${await server("policy-store.ts")}${await server("routes.ts")}`,
      /"(laf:policy_[a-z_]+)"/g,
    );
    expect(codes.size).toBeGreaterThan(3);
    expect([...codes].filter((code) => !(code in BOUNDARY_REFUSALS))).toEqual(
      [],
    );
  });

  test("the masked box names both of the client's facts about a value", async () => {
    // The two the client raises only on the person's own door (`factOfAnswer`), read out of it.
    const codes = codesIn(await server("client.ts"), /"(laf:secret_[a-z_]+)"/g);
    expect([...codes].sort()).toEqual([
      "laf:secret_field_gone",
      "laf:secret_not_pending",
    ]);
    expect([...codes].filter((code) => !(code in SECRET_REFUSALS))).toEqual([]);
  });

  test("a code with no words gets the screen's own sentence, never the code", () => {
    expect(refusalText(SECRET_REFUSALS, "laf:something_new", "fallback")).toBe(
      "fallback",
    );
    expect(refusalText(BOUNDARY_REFUSALS, undefined, "fallback")).toBe(
      "fallback",
    );
    for (const [code, sentence] of [
      ...Object.entries(SECRET_REFUSALS),
      ...Object.entries(BOUNDARY_REFUSALS),
    ]) {
      expect({ code, said: sentence.includes("laf:") }).toEqual({
        code,
        said: false,
      });
    }
  });
});
