import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_REFUSALS } from "../src/routes/_authed/settings/account";

/**
 * The refusals the account API names have Korean, and this is what says so.
 *
 * `app/tests/i18n-coverage.test.ts` reads literal `t("…")` calls out of the source and cannot see
 * `t(known)`, which is how this table reaches the screen. Without this test the whole table could
 * lose its Korean and every check would stay green — the same hole `routines-copy.test.ts` closes
 * for `ROUTINE_REFUSALS`.
 */

const DICTIONARY = join(import.meta.dir, "../src/lib/i18n-ko.ts");

describe("what the account page says when a deletion is refused", () => {
  test("every refusal has Korean", () => {
    const dictionary = readFileSync(DICTIONARY, "utf8");
    for (const sentence of Object.values(ACCOUNT_REFUSALS)) {
      expect(dictionary).toContain(JSON.stringify(sentence));
    }
  });

  test("covers the codes the server can answer with", () => {
    // Pinned rather than counted: a code added on the server with no words here falls through to
    // the server's own English sentence on a Korean screen, which is the failure this closes.
    expect(Object.keys(ACCOUNT_REFUSALS).sort()).toEqual([
      "laf:account_confirmation_mismatch",
      "laf:account_confirmation_required",
      "laf:account_not_found",
      "laf:account_self_via_admin",
    ]);
  });
});
