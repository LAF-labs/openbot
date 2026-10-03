import { TOOL_RESULT_KO } from "../prompt/tool-results.ko";
import { resultFactsOf, UNANSWERED_RESULT } from "../task-ending";

/**
 * HOW A CONNECTED SERVICE'S STEP ENDED, READ BACK FROM WHAT THE MODEL WAS TOLD.
 *
 * A step's result is kept as the text its Bot was given, and nothing beside it says whether the
 * step worked: the service's own answer, the service's own error, and this server's refusal are all
 * a string. The transcript has to tell them apart after the fact: a step is not drawn once it is
 * over, and the control that opens the record of them says when one did not work — in its colour
 * and its name — which it can only do if it can tell (`stepsByAnswer` in the app). It was first
 * read back so that such a step would not go behind the fold of the step after it (Codex on pull
 * request 44).
 *
 * So the forms a failure is written in are named here, once, for the two sides that write them
 * (`server/src/turns/chat-tools.ts`, the app's own handler in `plugin-tools.tsx`) and the side that
 * reads them back.
 */

/** What a service's own error is prefixed with, to the model. */
export const TOOL_ERROR_PREFIX = "The tool reported an error: ";

/** What a refusal that carries no code of ours says, to the model. */
export const TOOL_NOT_ALLOWED = "That tool is not allowed here.";

/** A service's own error, as the model is told it. */
export function toolErrorText(text: string): string {
  return `${TOOL_ERROR_PREFIX}${text}`;
}

/** A fact with no sentence in the table is handed over as itself (`toolResultText`). */
const BARE_FACT = /^laf:[a-z0-9_]+$/;

/**
 * Every sentence this server answers a call with in the service's place. A connected service
 * never says one of these: where a step's whole result is one, the server answered instead —
 * refused, stopped, unanswered, failed — and the service's answer never came.
 */
const SAID_IN_THE_SERVICES_PLACE: ReadonlySet<string> = new Set(
  Object.values(TOOL_RESULT_KO),
);
const LONGEST_SENTENCE = Math.max(
  ...Object.values(TOOL_RESULT_KO).map((sentence) => sentence.length),
);

/**
 * An object of ours that says a call was refused — `{ ok: false, code, reason }` — is a few hundred
 * characters. A service's own JSON can be megabytes, and this is asked of every step of a
 * conversation on every chunk of a streaming answer: nothing longer than this is parsed to find out.
 */
const REFUSAL_OBJECT_MAX = 4096;

/**
 * How an object of ours that says no begins, whatever it goes on to hold: `ok` is written first by
 * every writer of one — `toolFailureText` below, and `refusal` in `server/src/turns/chat-tools.ts`.
 *
 * Read off the head, not parsed, so the bound above cannot hide one: a reason is whatever a route
 * wrote, and a 5,000-character reason made a wrapper too long to be parsed — which then read back
 * as the service's answer (Codex on pull request 44, round 5).
 */
const OWN_REFUSAL_HEAD = '{"ok":false,';

/** How the runtime writes a handler that threw: "Error: <message>". */
const THROWN_HEAD = "Error:";

/**
 * Whether a finished step ended any way but with the service's own answer.
 *
 * ERRS TOWARDS YES. A step reached through the bridge may be one of the Bot's own tools, whose
 * good news is a sentence of that table too; said to have not worked, it costs the warning's
 * colour on a record in which everything went well. Erring the other way would put a failure
 * behind a control that looks like nothing happened.
 */
export function stepDidNotWork(result: string): boolean {
  if (result.startsWith(TOOL_ERROR_PREFIX) || result === TOOL_NOT_ALLOWED) {
    return true;
  }
  if (result === UNANSWERED_RESULT) return true;
  if (
    result.length <= LONGEST_SENTENCE &&
    SAID_IN_THE_SERVICES_PLACE.has(result)
  ) {
    return true;
  }
  // Before the bound: these two say so in their first characters, however long they run on.
  if (result.startsWith(OWN_REFUSAL_HEAD) || result.startsWith(THROWN_HEAD)) {
    return true;
  }
  if (result.length > REFUSAL_OBJECT_MAX) return false;
  if (BARE_FACT.test(result)) return true;
  const facts = resultFactsOf(result);
  return (
    facts !== null &&
    (facts.ok === false || facts.refused === true || facts.stopped === true)
  );
}

/**
 * What a call that was not carried out is answered with, in a form {@link stepDidNotWork} reads.
 *
 * The window's own handler answered the model with the reason as it came, and a reason is not
 * always one of the forms above: a 403 that carries no fact arrives as whatever sentence the route
 * wrote, or as this app's own fallback in the reader's language. Kept as the step's result, that
 * sentence read back as the service's answer — and a refusal went behind the fold of the step after
 * it (Codex on pull request 44, round 3). So a reason that does not already say so is wrapped in
 * the object this server's own refusals are: `{ ok: false, refused, reason }`. The model reads the
 * same reason; the transcript can tell what it was.
 */
export function toolFailureText(failure: {
  refused: boolean;
  reason: string;
}): string {
  if (stepDidNotWork(failure.reason)) return failure.reason;
  // `ok` FIRST: the head `stepDidNotWork` reads is the first key written here.
  return JSON.stringify({
    ok: false,
    refused: failure.refused,
    reason: failure.reason,
  });
}

/** Each sentence of the table, back to the fact it is the words for. The first, where two agree. */
const FACT_OF_SENTENCE: ReadonlyMap<string, string> = new Map(
  Object.entries(TOOL_RESULT_KO)
    .reverse()
    .map(([code, sentence]) => [sentence, code]),
);

/**
 * How a step that did not work ended, as far as its stored result says.
 *
 * - `error`: the service answered, with an error of its own; `text` is the service's words.
 * - `refused`: somebody, or a rule, said no — the boundary, or the person asked. Final: nothing the
 *   Bot does differently will help.
 * - `failed`: everything else that did not come back as an answer — the service's server broke, the
 *   place asked about is one it has nothing for, the turn was stopped, nobody answered in time.
 *
 * `code` is the fact where the result says one, for the surface to put in a person's words. NEVER
 * the sentence itself: that is an instruction written for the model ("…다시 시도하지 말고 그대로
 * 알려라"), and under a person's transcript it reads as the app talking to somebody else.
 */
export type StepFailure =
  | { kind: "error"; text: string }
  | { kind: "refused" | "failed"; code: string | null };

/**
 * The facts that are somebody saying no. NAMED, AND EVERYTHING ELSE IS A FAILURE — the first cut
 * had it the other way round, and pressed on the local stack a weather call for a place the
 * forecast does not reach read "날씨 확인하기 — 차단됨" in red: nobody had blocked anything
 * (2026-10-03). A fact nobody listed here says only that the step did not work, which is always
 * true of it.
 */
const REFUSED_FACTS: ReadonlySet<string> = new Set([
  "laf:policy_denied",
  "laf:no_rule_allows",
  "laf:declined_recently",
  "laf:person_declined",
]);

/** How a finished step failed, or null for one that ended with the service's own answer. */
export function stepFailureOf(result: string): StepFailure | null {
  if (!stepDidNotWork(result)) return null;
  if (result.startsWith(TOOL_ERROR_PREFIX)) {
    return { kind: "error", text: result.slice(TOOL_ERROR_PREFIX.length) };
  }
  if (result === TOOL_NOT_ALLOWED) return { kind: "refused", code: null };
  if (result === UNANSWERED_RESULT) return { kind: "failed", code: null };
  const kindOf = (code: string | null) =>
    code !== null && REFUSED_FACTS.has(code) ? "refused" : "failed";
  const said = FACT_OF_SENTENCE.get(result);
  if (said !== undefined) return { kind: kindOf(said), code: said };
  if (BARE_FACT.test(result)) return { kind: kindOf(result), code: result };
  // An object of ours, or a handler that threw. Too long to parse, it says no more than that.
  const facts =
    result.length > REFUSAL_OBJECT_MAX ? null : resultFactsOf(result);
  const code = facts?.code ?? null;
  return { kind: facts?.refused === true ? "refused" : kindOf(code), code };
}
