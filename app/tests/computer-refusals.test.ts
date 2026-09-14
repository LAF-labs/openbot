import { describe, expect, test } from "bun:test";
import { COMPUTER_CODES } from "../../agent-computer/src/codes";
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
 * invisible to `i18n-coverage.test.ts`, so the tables are walked here, against the source of each
 * code rather than a copy of it.
 */

const server = (path: string) =>
  Bun.file(
    new URL(`../../server/src/computer/${path}`, import.meta.url),
  ).text();

const container = (path: string) =>
  Bun.file(new URL(`../../agent-computer/src/${path}`, import.meta.url)).text();

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

  /*
   * THE BOX'S FACTS ARE THE CONTAINER'S. The value goes to `/human/secret` on the Bot's computer, and
   * what that door answers about the box is decided there: nothing asked for a value, or the box it
   * was for would not take it. The server's client used to rename the second `laf:secret_field_gone`
   * by reading the door and the status; it passes the container's code on now, and this reads the
   * door itself to find them.
   */
  test("the masked box names what the container's door answers about the value", async () => {
    const door = await container("control-routes.ts");
    const supply = door.slice(door.indexOf("export const supplySecret"));
    // The door's own refusal, and the failure every element action shares with it.
    expect(supply).toContain("fact(NO_SECRET_PENDING)");
    expect(supply).toContain("actionFailure(error)");
    const failures = await container("failures.ts");
    expect(failures).toContain("fact(ELEMENT_NOT_ACTIONABLE");

    for (const code of [
      "laf:secret_not_pending",
      "laf:element_not_actionable",
    ]) {
      expect({ code, listed: code in COMPUTER_CODES }).toEqual({
        code,
        listed: true,
      });
      expect({ code, said: code in SECRET_REFUSALS }).toEqual({
        code,
        said: true,
      });
    }
    // And the name the client used to give it is nobody's now.
    expect("laf:secret_field_gone" in SECRET_REFUSALS).toBe(false);
    expect(await server("client.ts")).not.toContain("laf:secret_field_gone");
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
