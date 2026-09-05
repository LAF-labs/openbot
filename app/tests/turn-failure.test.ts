/**
 * The words a failed turn is said in, and the codes they answer to.
 *
 * WHAT THIS IS GUARDING. A turn that got no answer used to print whatever threw — measured on
 * 2026-09-06: `HTTP 404: {"error":"Not found."}` and `Unable to connect. Is the computer able to
 * access the url?` — in red, in English, on a screen belonging to somebody who runs a shop.
 *
 * `t()` reads these through a variable, so `i18n-coverage.test.ts` cannot see them: it only walks
 * literal `t("…")`. This walks the table instead, the way `agent-presets.test.ts` walks its own.
 */
import { describe, expect, it } from "bun:test";
import {
  liveTurnFailureCode,
  TURN_FAILURE_CODES,
  TURN_FAILURE_SENTENCES,
  turnFailureSentence,
} from "@/lib/channels/turn-failure";
import { ko } from "@/lib/i18n-ko";

describe("turn failure sentences", () => {
  it("has a sentence for every code the server can send", () => {
    for (const code of TURN_FAILURE_CODES) {
      expect(TURN_FAILURE_SENTENCES[code]).toBeString();
      expect(TURN_FAILURE_SENTENCES[code]?.length).toBeGreaterThan(0);
    }
  });

  it("says every one of them in Korean", () => {
    for (const code of TURN_FAILURE_CODES) {
      const source = TURN_FAILURE_SENTENCES[code] as string;
      // The whole point. An untranslated entry here is the English that was on screen before.
      expect(ko[source]).toBeString();
      expect(ko[source]?.length).toBeGreaterThan(0);
    }
  });

  it("never leaves a code without words, however unfamiliar", () => {
    // A deployment one version ahead can send a code this build has never heard of.
    expect(turnFailureSentence("laf:turn_invented_tomorrow")).toBe(
      turnFailureSentence("laf:turn_failed"),
    );
  });

  it("says something different for the reasons that want different answers", () => {
    const waiting = TURN_FAILURE_SENTENCES["laf:turn_rate_limited"];
    const looking = TURN_FAILURE_SENTENCES["laf:turn_unreachable"];
    const smaller = TURN_FAILURE_SENTENCES["laf:turn_timed_out"];
    // "Try again" in front of an instant refusal is how a working product looks broken.
    expect(new Set([waiting, looking, smaller]).size).toBe(3);
  });
});

describe("liveTurnFailureCode", () => {
  it("places the two failures actually measured on this screen", () => {
    expect(
      liveTurnFailureCode(
        "Unable to connect. Is the computer able to access the url?",
      ),
    ).toBe("laf:turn_unreachable");
    expect(liveTurnFailureCode('HTTP 404: {"error":"Not found."}')).toBe(
      "laf:turn_unreachable",
    );
  });

  it("reads the deployment's own model codes", () => {
    expect(liveTurnFailureCode("laf:model_rate_limited")).toBe(
      "laf:turn_rate_limited",
    );
    expect(liveTurnFailureCode("laf:model_timed_out")).toBe(
      "laf:turn_timed_out",
    );
    expect(liveTurnFailureCode("laf:model_unavailable")).toBe(
      "laf:turn_model_failed",
    );
    expect(liveTurnFailureCode("laf:model_failed")).toBe(
      "laf:turn_model_failed",
    );
  });

  it("recognises the stall guard, whose sentence is English prose", () => {
    // server/src/channels/stall-guard.ts writes this into RUN_ERROR, and it was reaching the screen.
    expect(
      liveTurnFailureCode(
        "지식 도우미 stopped responding. Nothing arrived from it for 2 minutes, so this turn was ended. Ask again, or check that the Bot is running.",
      ),
    ).toBe("laf:turn_stalled");
    expect(liveTurnFailureCode("AGENT_STREAM_STALLED")).toBe(
      "laf:turn_stalled",
    );
  });

  it("separates a refusal from a rate limit from a server fault", () => {
    expect(liveTurnFailureCode("HTTP 429 Too Many Requests")).toBe(
      "laf:turn_rate_limited",
    );
    expect(liveTurnFailureCode("HTTP 403 Forbidden")).toBe("laf:turn_refused");
    expect(liveTurnFailureCode("HTTP 503 Service Unavailable")).toBe(
      "laf:turn_model_failed",
    );
  });

  it("reads a browser's own network failures", () => {
    expect(liveTurnFailureCode(new TypeError("Failed to fetch"))).toBe(
      "laf:turn_unreachable",
    );
    expect(liveTurnFailureCode(new Error("fetch failed"))).toBe(
      "laf:turn_unreachable",
    );
    expect(liveTurnFailureCode("NetworkError when attempting to fetch")).toBe(
      "laf:turn_unreachable",
    );
  });

  it("falls back rather than guessing, and never throws on rubbish", () => {
    expect(liveTurnFailureCode("")).toBe("laf:turn_failed");
    expect(liveTurnFailureCode(null)).toBe("laf:turn_failed");
    expect(liveTurnFailureCode(undefined)).toBe("laf:turn_failed");
    expect(liveTurnFailureCode({ nope: true })).toBe("laf:turn_failed");
    expect(liveTurnFailureCode("something nobody has seen before")).toBe(
      "laf:turn_failed",
    );
  });

  it("only ever answers with a code the sentence table knows", () => {
    const inputs = [
      "",
      "HTTP 404",
      "429",
      "timed out",
      "econnrefused",
      "401",
      "500",
      "stopped responding",
      "laf:model_failed",
      "who knows",
    ];
    for (const input of inputs) {
      expect(TURN_FAILURE_CODES).toContain(liveTurnFailureCode(input));
    }
  });
});
