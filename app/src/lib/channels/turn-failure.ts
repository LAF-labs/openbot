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
import { sittingLabel } from "@/lib/channels/message-time";
import { activeLocale, t } from "@/lib/i18n";

/**
 * The codes `GET /api/channels/:id/failures` can send. Keep in step with the server's table.
 *
 * Plus one the server can never send, because it is about the server: `laf:turn_server_unreachable`
 * is what this tab says when its own request to the API got no answer or a proxy's answer. There is
 * no ledger row for that turn — the process that writes the ledger was the thing that was down.
 */
export const TURN_FAILURE_CODES = [
  "laf:turn_budget_spent",
  "laf:turn_daily_budget_reached",
  "laf:turn_failed",
  "laf:turn_interrupted",
  "laf:turn_model_failed",
  "laf:turn_rate_limited",
  "laf:turn_refused",
  "laf:turn_server_unreachable",
  "laf:turn_stalled",
  "laf:turn_stream_cut",
  "laf:turn_timed_out",
  "laf:turn_tool_failed",
  "laf:turn_unreachable",
] as const;

export type TurnFailureCode = (typeof TURN_FAILURE_CODES)[number];

/**
 * A routine failing the same way over and over, as the one line that stands for all of it.
 *
 * The server counts a failure that repeats an open group into that group and writes nothing else
 * (`server/src/notifications/failure-groups.ts`), so this is the only place the repeats are seen:
 * how many, when last, and whether the person has said 확인 or a success has ended it.
 */
export type FailureGroup = {
  /** The group's notification row. What 확인 sends back. */
  id: string;
  count: number;
  lastAt: string;
  acknowledged: boolean;
  closed: boolean;
};

/** One question that never got an answer, as the server reports it. */
export type TurnFailure = {
  messageId: string;
  code: string;
  at: string;
  group?: FailureGroup;
};

/**
 * "같은 이유로 7번 실패 · 마지막 오전 9:00", or nothing for a failure that has not repeated.
 *
 * The clock alone when it was today — the case this exists for is a routine failing every hour
 * while somebody is at work — and the day with it otherwise, in the words the transcript's own
 * separators use, because "마지막 오전 9:00" about last Tuesday reads as this morning.
 */
export function repeatedFailureLine(
  group: Pick<FailureGroup, "count" | "lastAt">,
  now: Date = new Date(),
): string | null {
  const last = new Date(group.lastAt);
  if (group.count < 2 || Number.isNaN(last.getTime())) return null;
  const time =
    last.toDateString() === now.toDateString()
      ? last.toLocaleTimeString(activeLocale, {
          hour: "numeric",
          minute: "2-digit",
        })
      : sittingLabel(last, now);
  return t("Failed {count} times for the same reason · last {time}", {
    count: group.count,
    time,
  });
}

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
  /*
   * Not a fault: the Bot kept working and the question reached what one question may cost
   * (agent-bot's `ASK_TOKEN_BUDGET`). Carrying on is a new question with a budget of its own.
   */
  "laf:turn_budget_spent":
    "This question used up what one question may cost, so the Bot stopped. Ask it to carry on, or ask for less at once.",
  /*
   * A free trial's day is spent, so the server refused the run before it left (self-serve contract
   * §4.6). The same words `stopped-turn.ts` uses, one Korean entry for both.
   */
  "laf:turn_daily_budget_reached":
    "Today's free trial allowance is used up. It opens again at midnight, Korean time.",
  "laf:turn_failed": "No answer came back.",
  /*
   * The server restarted while this ran. Not a fault of the model's and not the person's: the run
   * simply has no ending, and both a question and a routine get this line — the routine runs again
   * at its next slot, the question wants asking again, and the sentence claims neither.
   */
  "laf:turn_interrupted":
    "It could not finish: the server restarted partway through.",
  "laf:turn_model_failed": "The Bot could not reach its model. Ask again.",
  "laf:turn_rate_limited":
    "Answers are coming faster than the model can take right now. Give it a moment and ask again.",
  "laf:turn_refused":
    "The Bot's address refused the request. Its connection needs a look.",
  "laf:turn_stalled":
    "The Bot went quiet, so the turn was ended. Ask again, or check that the Bot is running.",
  /*
   * The model's stream stopped partway. The half that arrived stays in the transcript, above this
   * line — which is why the line is keyed to the run's last message — and this says why it is half.
   */
  "laf:turn_stream_cut":
    "The connection to the model dropped partway through the answer. What arrived is above; ask again for the rest.",
  "laf:turn_timed_out":
    "The model took too long and the turn was ended. Ask again, or ask for less at once.",
  /*
   * A name that does not exist, arguments that are not an object, or the same call over and over:
   * agent-bot answered the Bot inside the run and it did not recover. Nothing is broken; asking
   * again, or differently, is the whole of what there is to do.
   */
  "laf:turn_tool_failed":
    "The Bot could not use its tools properly, so the turn was ended. Ask again, or put it differently.",
  "laf:turn_unreachable":
    "The Bot did not answer. It may not be running right now.",
  /*
   * The same sentence the `/unreachable` screen says, because it is the same fact. MEASURED
   * 2026-09-10 (audit A4): with the API stopped, a question came back as "봇이 모델에 닿지 못했습니다"
   * — the proxy's 500 (Vite) or 502 (Caddy) read as a model fault, and nothing on the screen said the
   * server was gone. An installed app has no address bar and no reload, so a person told the model
   * is broken has nothing to do but quit from the tray.
   */
  "laf:turn_server_unreachable": "Cannot reach the server.",
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
 *
 * `connectionLost` is the one fact the sentence cannot be read off: the account's socket has
 * dropped, which it does within a second of the API process dying. A turn that fails while it is
 * down failed because the server was gone, whatever status a proxy in the middle chose to say —
 * Vite says 500, which without this line reads as a server fault, and Caddy says 503
 * (`laf:api_unreachable`, `handle_errors` in app/Caddyfile).
 */
export function liveTurnFailureCode(
  reported: unknown,
  { connectionLost = false }: { connectionLost?: boolean } = {},
): TurnFailureCode {
  if (connectionLost) return "laf:turn_server_unreachable";
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
  if (said.includes("laf:provider_stream_cut")) return "laf:turn_stream_cut";
  if (
    said.includes("laf:tool_unknown") ||
    said.includes("laf:tool_arguments_invalid") ||
    said.includes("laf:tool_loop")
  ) {
    return "laf:turn_tool_failed";
  }
  if (said.includes("laf:tool_budget_spent")) return "laf:turn_budget_spent";
  if (said.includes("laf:daily_budget_reached")) {
    return "laf:turn_daily_budget_reached";
  }
  // The stall guard sends its fact now; the two substrings are the English sentence it sent before.
  if (
    said.includes("laf:agent_stalled") ||
    said.includes("agent_stream_stalled") ||
    said.includes("stopped responding")
  ) {
    return "laf:turn_stalled";
  }
  if (said.includes("429") || said.includes("rate limit")) {
    return "laf:turn_rate_limited";
  }
  /*
   * THIS BROWSER'S OWN WORDS FOR A REQUEST THAT NEVER GOT AN ANSWER — "Failed to fetch" (Chrome),
   * "NetworkError when attempting to fetch resource." (Firefox), "Load failed" (Safari). They can
   * only be about the request this tab made, which goes to the API on its own origin; the Bot's
   * endpoint is behind the API and its failures arrive as prose the SERVER wrote, below. And a
   * proxy standing in for a server that is not there says 502, 503 or 504 with nothing behind it —
   * checked before the timeout words, because 504 is spelled "Gateway Timeout".
   */
  if (
    said.includes("failed to fetch") ||
    said.includes("networkerror") ||
    said.includes("network error") ||
    said.includes("load failed") ||
    said.includes("502") ||
    said.includes("503") ||
    said.includes("504")
  ) {
    return "laf:turn_server_unreachable";
  }
  if (said.includes("timed out") || said.includes("timeout")) {
    return "laf:turn_timed_out";
  }
  /*
   * The two that were actually measured on this screen: a 404 from the runtime, and a refused
   * connection to a Bot's endpoint. To the person sitting there they are one fact — the Bot is not
   * answering — and one thing to do about it. "fetch failed" (that word order) is Node's undici,
   * which is the server saying it could not reach the Bot; the browser never phrases it that way.
   */
  if (
    said.includes("unable to connect") ||
    said.includes("econnrefused") ||
    said.includes("enotfound") ||
    said.includes("fetch failed") ||
    said.includes("404")
  ) {
    return "laf:turn_unreachable";
  }
  if (said.includes("401") || said.includes("403")) return "laf:turn_refused";
  /*
   * A bare 500 is the server itself throwing, which is neither the model nor the network, and used
   * to be reported as the model. It falls through: "No answer came back" is the one true sentence.
   */
  return "laf:turn_failed";
}
