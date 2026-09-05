/**
 * A turn that got no answer, said in Korean, with something to press.
 *
 * WHAT WAS ON SCREEN BEFORE THIS: `HTTP 404: {"error":"Not found."}` in red, and — measured on
 * 2026-09-06 against a Bot pointed at a dead port — `Unable to connect. Is the computer able to
 * access the url?`. English, unstyled, aimed at whoever runs the deployment, on a screen belonging
 * to somebody who runs a shop. And on reload it vanished: the question sat alone with no answer and
 * no sign that anything had gone wrong.
 *
 * The server sends a fact code and this owns the sentence, which is the same division `t()` is for
 * everywhere else. It also means the substring-matching on somebody's error prose happens once, on
 * the server, against the ledger — see `server/src/channels/turn-failures.ts`. This file's copy of
 * the codes IS the wire contract between the two; `turn-failure.test.ts` walks it, and adding a
 * code on either side without the other leaves the generic sentence, which is true of everything.
 */
import { t } from "@/lib/i18n";

/** The codes `GET /api/channels/:id/failures` can send. Keep in step with the server's table. */
export const TURN_FAILURE_CODES = [
  "laf:turn_failed",
  "laf:turn_model_failed",
  "laf:turn_rate_limited",
  "laf:turn_refused",
  "laf:turn_stalled",
  "laf:turn_timed_out",
  "laf:turn_unreachable",
] as const;

export type TurnFailureCode = (typeof TURN_FAILURE_CODES)[number];

/** One question that never got an answer, as the server reports it. */
export type TurnFailure = {
  messageId: string;
  code: string;
  at: string;
};

/**
 * What each failure means to the person who asked, in the English `t()` reads as a key.
 *
 * FOUR SENTENCES RATHER THAN ONE, because the right thing to do differs and a wrong instruction is
 * worse than none: a rate limit wants waiting, a Bot that is not running wants somebody to look at
 * it, a timeout wants a smaller question. Three of these reuse the strings `stopped-turn.ts`
 * already had translated, so the Korean is one register and not two.
 *
 * `t()` on a variable is invisible to `i18n-coverage.test.ts`, so `turn-failure.test.ts` walks this
 * table the way `agent-presets.test.ts` walks its own.
 */
export const TURN_FAILURE_SENTENCES: Record<string, string> = {
  "laf:turn_failed": "No answer came back.",
  "laf:turn_model_failed": "The Bot could not reach its model. Ask again.",
  "laf:turn_rate_limited":
    "Answers are coming faster than the model can take right now. Give it a moment and ask again.",
  "laf:turn_refused":
    "The Bot's address refused the request. Its connection needs a look.",
  "laf:turn_stalled":
    "The Bot went quiet, so the turn was ended. Ask again, or check that the Bot is running.",
  "laf:turn_timed_out":
    "The model took too long and the turn was ended. Ask again, or ask for less at once.",
  "laf:turn_unreachable":
    "The Bot did not answer. It may not be running right now.",
};

/** The sentence for a code, falling back to the generic one for anything unrecognised. */
export function turnFailureSentence(code: string): string {
  return t(
    TURN_FAILURE_SENTENCES[code] ?? TURN_FAILURE_SENTENCES["laf:turn_failed"],
  );
}

/**
 * A failure that has not been through the server yet, classified the same way.
 *
 * The live path cannot wait for the ledger: the run fails in this tab, and the person is looking at
 * the gap where the answer was going to be. The transport failures a browser can see are a smaller
 * set than the server's — there is no ledger row to read yet, only whatever `RUN_ERROR` or the
 * fetch threw — so this matches on the same shapes and leaves the rest generic.
 *
 * The two classifiers agreeing matters only in that the sentence must not CHANGE across a reload.
 * It is the same table of sentences either way, so the worst disagreement is a specific sentence
 * becoming the generic one, or the other way round.
 */
export function liveTurnFailureCode(reported: unknown): TurnFailureCode {
  const said = (
    reported instanceof Error
      ? reported.message
      : typeof reported === "string"
        ? reported
        : ""
  )
    .trim()
    .toLowerCase();
  if (!said) return "laf:turn_failed";

  if (said.includes("laf:model_rate_limited")) return "laf:turn_rate_limited";
  if (said.includes("laf:model_timed_out")) return "laf:turn_timed_out";
  if (
    said.includes("laf:model_unavailable") ||
    said.includes("laf:model_failed")
  ) {
    return "laf:turn_model_failed";
  }
  if (
    said.includes("agent_stream_stalled") ||
    said.includes("stopped responding")
  ) {
    return "laf:turn_stalled";
  }
  if (said.includes("429") || said.includes("rate limit")) {
    return "laf:turn_rate_limited";
  }
  if (said.includes("timed out") || said.includes("timeout")) {
    return "laf:turn_timed_out";
  }
  /*
   * The two that were actually measured on this screen: a 404 from the runtime, and a refused
   * connection to a Bot's endpoint. To the person sitting there they are one fact — the Bot is not
   * answering — and one thing to do about it.
   */
  if (
    said.includes("unable to connect") ||
    said.includes("econnrefused") ||
    said.includes("enotfound") ||
    said.includes("fetch failed") ||
    said.includes("failed to fetch") ||
    said.includes("networkerror") ||
    said.includes("network error") ||
    said.includes("load failed") ||
    said.includes("404")
  ) {
    return "laf:turn_unreachable";
  }
  if (said.includes("401") || said.includes("403")) return "laf:turn_refused";
  if (
    said.includes("500") ||
    said.includes("502") ||
    said.includes("503") ||
    said.includes("504")
  ) {
    return "laf:turn_model_failed";
  }
  return "laf:turn_failed";
}
