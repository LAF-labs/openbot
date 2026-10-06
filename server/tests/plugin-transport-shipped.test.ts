import { describe, expect, test } from "bun:test";
import { CATALOGUE } from "../src/plugins/catalogue";
import {
  definitionsShipWithThisBuild,
  transportFor,
} from "../src/plugins/transport";

/**
 * Whose tool definitions are taken without a person reading them (`servers.ts`, the owner's rule of
 * 2026-10-06): this repository's own, and nobody else's.
 *
 * The rule is read off a declaration each transport makes (`listNeedsCredential`), and the review
 * of #110 found the sentence that justified it untrue — a remote server CAN be listed with no
 * credential (a custom server added without a token). What keeps a vendor's definition out is one
 * constant in `mcp.ts`. So the whole catalogue is written out here, entry by entry: a new entry, or
 * a transport whose declaration flips, has to be decided in this table by somebody.
 *
 * The partner entry and the three that run on the deployment's own keys are not in the table: the
 * process hands them their transport (`store.ts`), and their suites hold what those are.
 */
describe("whose definitions ship with this build", () => {
  test("a server somebody added by address is a vendor's, with a token or without one", () => {
    expect(definitionsShipWithThisBuild(transportFor(null))).toBe(false);
  });

  test("each catalogue entry: our own adapter, or a vendor's server that waits for a person", () => {
    const verdicts = Object.fromEntries(
      CATALOGUE.filter(
        (entry) => !entry.partner && entry.auth.kind !== "deployment-key",
      ).map((entry) => [
        entry.key,
        definitionsShipWithThisBuild(transportFor(entry)),
      ]),
    );
    expect(verdicts).toEqual({
      "google-drive": true,
      "google-sheets": true,
      gmail: true,
      "google-calendar": true,
      "google-business-profile": true,
      cafe24: true,
      notion: false,
      canva: false,
      "kakao-playmcp": false,
    });
  });

  test("a transport that declares nothing is a vendor's", () => {
    // What a replaced module or a forgotten line looks like at run time, whatever the type says.
    expect(
      definitionsShipWithThisBuild({
        listNeedsCredential: undefined as unknown as boolean,
      }),
    ).toBe(false);
  });
});
