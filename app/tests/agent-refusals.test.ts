import { describe, expect, test } from "bun:test";
import { AGENT_REFUSALS } from "../src/lib/agents/mutations";
import { ko } from "../src/lib/i18n-ko";

/**
 * The agents API's refusals, which the profile and the first run render straight into the screen.
 *
 * The sixth Bot was once refused with the server's own sentence — "This account's computer seats
 * five Bots, and all five seats are taken." — English, in a Korean product. The server sends a fact
 * code and this table owns the words, which puts `t()` on a variable and so out of
 * `i18n-coverage.test.ts`'s sight; the table is checked in and finite, so it is walked.
 */
describe("the agents refusal copy", () => {
  test("every refusal in the table has Korean", () => {
    const missing = Object.values(AGENT_REFUSALS).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
  });

  test("the table names every code the server can send", async () => {
    /*
     * The server is the source of truth for WHICH codes exist. Read out of its source rather than
     * copied, so a code added there fails here until somebody decides what it says in Korean — the
     * failure mode being a refusal that falls through to the server's English sentence, which is
     * exactly what this pair was written to end.
     */
    const store = await Bun.file(
      new URL("../../server/src/agents/profile-store.ts", import.meta.url),
    ).text();
    const routes = await Bun.file(
      new URL("../../server/src/agents/routes.ts", import.meta.url),
    ).text();
    const codes = new Set(
      [...`${store}${routes}`.matchAll(/"(laf:[a-z_]+)"/g)].map(
        (match) => match[1] as string,
      ),
    );

    expect(codes.size).toBeGreaterThan(0);
    expect([...codes].sort()).toEqual(Object.keys(AGENT_REFUSALS).sort());
  });

  /*
   * ONE BOT A PERSON (2026-09-24). The refusal of a second is a fact with no number beside it —
   * there is nothing to count — and its words say what to do instead, since the only way to reach
   * it from this surface is a stale tab.
   */
  test("a second Bot is refused in Korean, without a count, pointing at the profile", () => {
    const sentence = AGENT_REFUSALS["laf:account_has_bot"] as string;
    expect(sentence).toBeString();
    expect(sentence).not.toContain("{");
    expect(ko[sentence]).toContain("프로필");
    expect(AGENT_REFUSALS).not.toHaveProperty("laf:seats_full");
  });
});
