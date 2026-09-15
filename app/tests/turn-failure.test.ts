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
import { sittingLabel } from "@/lib/channels/message-time";
import {
  liveTurnFailureCode,
  repeatedFailureLine,
  TURN_FAILURE_CODES,
  TURN_FAILURE_SENTENCES,
  turnFailureSentence,
} from "@/lib/channels/turn-failure";
import { activeLocale } from "@/lib/i18n";
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

  it("recognises the stall guard's fact, and the English prose it sent before", () => {
    // server/src/channels/stall-guard.ts sends the fact now. The sentence below is what it wrote
    // into RUN_ERROR until then, and it was reaching the screen.
    expect(liveTurnFailureCode("laf:agent_stalled")).toBe("laf:turn_stalled");
    expect(
      liveTurnFailureCode(
        "지식 도우미 stopped responding. Nothing arrived from it for 2 minutes, so this turn was ended. Ask again, or check that the Bot is running.",
      ),
    ).toBe("laf:turn_stalled");
    expect(liveTurnFailureCode("AGENT_STREAM_STALLED")).toBe(
      "laf:turn_stalled",
    );
  });

  it("reads the facts agent-bot ends a run on for its own reasons", () => {
    // A cut stream: the half that arrived stays on screen, and this line says why it is half.
    expect(liveTurnFailureCode("laf:provider_stream_cut")).toBe(
      "laf:turn_stream_cut",
    );
    // A Bot that did not recover from its own tool mistakes after being told inside the run.
    for (const code of [
      "laf:tool_unknown",
      "laf:tool_arguments_invalid",
      "laf:tool_loop",
    ]) {
      expect(liveTurnFailureCode(code)).toBe("laf:turn_tool_failed");
    }
    expect(liveTurnFailureCode("laf:tool_budget_spent")).toBe(
      "laf:turn_budget_spent",
    );
  });

  it("gives a cut, a tool failure and a spent budget three different next steps", () => {
    const sentences = [
      "laf:turn_stream_cut",
      "laf:turn_tool_failed",
      "laf:turn_budget_spent",
    ].map((code) => turnFailureSentence(code));
    expect(new Set(sentences).size).toBe(3);
    // Each in Korean, not the generic line.
    for (const sentence of sentences) {
      expect(sentence).not.toBe(turnFailureSentence("laf:turn_failed"));
    }
  });

  it("separates a refusal from a rate limit from a server fault", () => {
    expect(liveTurnFailureCode("HTTP 429 Too Many Requests")).toBe(
      "laf:turn_rate_limited",
    );
    expect(liveTurnFailureCode("HTTP 403 Forbidden")).toBe("laf:turn_refused");
    // The server's own 500 is nobody's model. It is "no answer", and nothing more specific.
    expect(liveTurnFailureCode("HTTP 500: Internal Server Error")).toBe(
      "laf:turn_failed",
    );
  });

  /*
   * MEASURED 2026-09-10 (audit A4, finding 3): with the API stopped, `onRunFailed` received
   * CopilotKit's `HTTP 500:` from Vite's proxy and the screen said 봇이 모델에 닿지 못했습니다. The
   * model was never asked. A proxy speaking for a dead server, and a browser whose request got no
   * answer at all, are the one fact the /unreachable screen already has a sentence for.
   */
  it("says the server is unreachable when a proxy answered for it", () => {
    for (const said of [
      "HTTP 502: Bad Gateway",
      "HTTP 503: Service Unavailable",
      "HTTP 504: Gateway Timeout",
    ]) {
      expect(liveTurnFailureCode(said)).toBe("laf:turn_server_unreachable");
    }
    expect(
      ko[TURN_FAILURE_SENTENCES["laf:turn_server_unreachable"] as string],
    ).toBe("서버에 닿지 못했습니다.");
  });

  it("reads a browser's own network failures as the server being gone", () => {
    // Chrome, Firefox and Safari, in that order. Each is this tab failing to reach its own origin.
    expect(liveTurnFailureCode(new TypeError("Failed to fetch"))).toBe(
      "laf:turn_server_unreachable",
    );
    expect(liveTurnFailureCode("NetworkError when attempting to fetch")).toBe(
      "laf:turn_server_unreachable",
    );
    expect(liveTurnFailureCode(new TypeError("Load failed"))).toBe(
      "laf:turn_server_unreachable",
    );
    // Node's undici says it the other way round, and that is the SERVER failing to reach the Bot.
    expect(liveTurnFailureCode(new Error("fetch failed"))).toBe(
      "laf:turn_unreachable",
    );
  });

  it("trusts a dropped connection over whatever status the proxy chose", () => {
    // Vite answers 500 for a dead API and Caddy 502; the socket dropping is the fact under both.
    expect(
      liveTurnFailureCode("HTTP 500: Internal Server Error", {
        connectionLost: true,
      }),
    ).toBe("laf:turn_server_unreachable");
    expect(
      liveTurnFailureCode("laf:model_failed", { connectionLost: true }),
    ).toBe("laf:turn_server_unreachable");
    expect(
      liveTurnFailureCode("laf:model_failed", { connectionLost: false }),
    ).toBe("laf:turn_model_failed");
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

describe("a failure that keeps happening", () => {
  const today = new Date("2026-09-14T15:00:00");

  it("says nothing more for a failure that has not repeated", () => {
    expect(
      repeatedFailureLine({ count: 1, lastAt: today.toISOString() }, today),
    ).toBeNull();
  });

  it("says how many, and only the clock when it was today", () => {
    const last = new Date("2026-09-14T09:00:00");
    const clock = last.toLocaleTimeString(activeLocale, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(
      repeatedFailureLine({ count: 7, lastAt: last.toISOString() }, today),
    ).toBe(`Failed 7 times for the same reason · last ${clock}`);
  });

  it("names the day when it was not today, so last Tuesday does not read as this morning", () => {
    const last = new Date("2026-09-13T09:00:00");
    expect(
      repeatedFailureLine({ count: 3, lastAt: last.toISOString() }, today),
    ).toBe(
      `Failed 3 times for the same reason · last ${sittingLabel(last, today)}`,
    );
    expect(sittingLabel(last, today)).toContain("Yesterday");
  });

  it("draws no line from a time that does not parse", () => {
    expect(
      repeatedFailureLine({ count: 4, lastAt: "not a time" }, today),
    ).toBeNull();
  });
});

describe("a trial's spent day", () => {
  /*
   * The server refuses a run before it leaves (`laf:daily_budget_reached`, self-serve contract §4.6),
   * and the chat reads it through this file, not through `stopped-turn.ts`: without a code here the
   * refusal would say "No answer came back." — true, and exactly the sentence that sends somebody to
   * ask again into a day that only opens again at midnight.
   */
  it("is its own sentence live, and the same one after a reload", async () => {
    const { MODEL_FAILURES } = await import("@/lib/copilot/stopped-turn");
    expect(liveTurnFailureCode("laf:daily_budget_reached")).toBe(
      "laf:turn_daily_budget_reached",
    );
    expect(TURN_FAILURE_SENTENCES["laf:turn_daily_budget_reached"]).toBe(
      MODEL_FAILURES["laf:daily_budget_reached"],
    );
    expect(ko[MODEL_FAILURES["laf:daily_budget_reached"] as string]).toBe(
      "오늘 무료 체험에서 쓸 수 있는 양을 다 썼어요. 내일 0시(한국 시간)부터 다시 쓸 수 있어요.",
    );
  });
});
