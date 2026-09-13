import { describe, expect, test } from "bun:test";
import { CHANNEL_REFUSALS } from "../src/lib/channels/mutations";
import { ko } from "../src/lib/i18n-ko";

/**
 * The refusals starting a conversation can hit, rendered on the roster in this surface's own words.
 *
 * The channel routes answered "Agent IDs must be a non-empty array." and "Channel not found." —
 * English, on a Korean roster (audit A1-3). They send `laf:…` codes and no prose now; the create
 * mutation reads the code and this table owns the sentence. `t()` on a variable is invisible to
 * `i18n-coverage.test.ts`, so the table is walked here — the same pair `routines-copy.test.ts` and
 * `agent-refusals.test.ts` make for theirs.
 */
describe("the channel refusal copy", () => {
  test("every refusal in the table has Korean", () => {
    const missing = Object.values(CHANNEL_REFUSALS).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
  });

  test("the table names every code starting a conversation can be refused with", async () => {
    // Read out of the server's source rather than copied, so a code added there fails here until
    // somebody decides what it says in Korean.
    const routes = await Bun.file(
      new URL("../../server/src/channels/routes.ts", import.meta.url),
    ).text();
    const codes = new Set(
      [...routes.matchAll(/"(laf:channel_[a-z_]+)"/g)].map(
        (match) => match[1] as string,
      ),
    );
    // Thrown by the store for a Bot the person may not start a conversation with.
    codes.add("laf:agent_not_found");

    expect(codes.size).toBeGreaterThan(3);
    const missing = [...codes].filter((code) => !(code in CHANNEL_REFUSALS));
    expect(missing).toEqual([]);
  });
});
