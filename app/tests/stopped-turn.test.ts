import { describe, expect, test } from "bun:test";
import { stoppedReason } from "../src/lib/copilot/stopped-turn";

/**
 * What a person is told when a turn ends and no answer came.
 *
 * The cases are the three things that actually arrive: the sentence the deployment's stall watchdog
 * wrote into the run, an error thrown in the browser, and nothing at all.
 */

describe("the reason a turn ended", () => {
  test("passes on what ended the turn, in its own words", () => {
    expect(
      stoppedReason(
        "Risk Analyst stopped responding. Nothing arrived from it for 2 minutes, so this turn was ended. Ask again, or check that the Bot is running.",
      ),
    ).toContain("Risk Analyst stopped responding");
  });

  test("reads an Error the same way, because a failed run carries one", () => {
    expect(
      stoppedReason(new Error("The endpoint refused the connection")),
    ).toBe("The endpoint refused the connection");
  });

  test("says so plainly when nothing was reported, rather than inventing a cause", () => {
    // This is the one moment a person has no other way to find out what went wrong, so a guess here
    // would be worse than an admission.
    expect(stoppedReason(undefined)).toBe(
      "The Bot stopped without saying why.",
    );
    expect(stoppedReason("")).toBe("The Bot stopped without saying why.");
    expect(stoppedReason("   ")).toBe("The Bot stopped without saying why.");
    expect(stoppedReason(new Error(""))).toBe(
      "The Bot stopped without saying why.",
    );
    expect(stoppedReason({ message: "not a string or an Error" })).toBe(
      "The Bot stopped without saying why.",
    );
  });
});

describe("what a model failure code becomes", () => {
  /*
   * agent-bot emits `laf:` fact codes instead of provider prose — the provider's sentence names
   * its vendor, its catalogue and its URLs, and this string ends on a customer's screen. The
   * surface owns the words: every code translates, and no code ever reaches an eye raw.
   */
  test("every code becomes a sentence, never the code itself", async () => {
    const { MODEL_FAILURES } = await import("../src/lib/copilot/stopped-turn");
    for (const code of Object.keys(MODEL_FAILURES)) {
      const shown = stoppedReason(code);
      expect(shown).not.toContain("laf:");
      expect(shown.length).toBeGreaterThan(10);
    }
  });

  test("every sentence in the table has Korean", async () => {
    // The table is t() called on a variable, invisible to i18n-coverage — the same blind spot the
    // audit labels have, closed the same way.
    const { MODEL_FAILURES } = await import("../src/lib/copilot/stopped-turn");
    const { ko } = await import("../src/lib/i18n-ko");
    const missing = Object.values(MODEL_FAILURES).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
  });

  test("a rate limit and an outage are two different sentences", async () => {
    // Collapsing them is the trap model-call.ts documents: a 429 wants waiting, and "try again"
    // in front of an instant refusal is how a working feature looks broken.
    expect(stoppedReason("laf:model_rate_limited")).not.toBe(
      stoppedReason("laf:model_unavailable"),
    );
  });
});
