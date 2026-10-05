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
 * Every sentence this server answers a call with in the service's place, back to the fact it is
 * the words for (the first, where two agree). A connected service never says one of these: where a
 * step's whole result is one, the server answered instead — refused, stopped, unanswered, failed —
 * and the service's answer never came.
 */
const FACT_OF_SENTENCE: ReadonlyMap<string, string> = new Map(
  Object.entries(TOOL_RESULT_KO)
    .reverse()
    .map(([code, sentence]) => [sentence, code]),
);
const LONGEST_SENTENCE = Math.max(
  ...Object.values(TOOL_RESULT_KO).map((sentence) => sentence.length),
);

/**
 * An object of ours that says a call was refused — `{ ok: false, code, reason }` — is a few hundred
 * characters. A service's own JSON can be megabytes, and this is asked of every step of a
 * conversation on every chunk of a streaming answer: nothing longer than this is parsed to find out
 * what one says beyond that it is ours.
 */
const REFUSAL_OBJECT_MAX = 4096;

/** How the runtime writes a handler that threw: "Error: <message>". */
const THROWN_HEAD = "Error:";

/**
 * Whether a finished step ended any way but with the service's own answer: `stepFailureOf` says
 * how, and this is whether it says anything.
 *
 * ONE READING, FOR THE COUNT AND FOR THE LINE. This was a reader of its own, and looser: any object
 * that said `ok: false` counted. That was right while it only decided whether a line stayed in the
 * open. Since the steps are put away it decides what the control that opens them says — "3 steps, 1
 * did not work", in the warning's colour — and the line, opened, is drawn by `stepFailureOf`, which
 * reads only this app's own objects as failures. Carried onto that change, a service's ordinary
 * answer of `{"ok":false,"error":"channel_not_found"}` made the control say one step had not
 * worked and the record behind it show three that had.
 *
 * IT STILL ERRS TOWARDS YES IN ONE PLACE: the table's sentences. No connected service says one,
 * but a step reached through the bridge may be one of the Bot's own tools, whose good news is a
 * sentence of that table too; said to have not worked, it costs the warning's colour on a record in
 * which everything went well. Erring the other way would put a failure behind a control that looks
 * like nothing happened.
 */
export function stepDidNotWork(result: string): boolean {
  return stepFailureOf(result) !== null;
}

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
 *
 * THE DEPLOYMENT SAYS NO TOO, not only its rules and the person: a tool this Bot was not given, and
 * a tool held until somebody looks at a definition that changed (`server/src/plugins/call.ts`).
 * Left out, both read "did not work" — as if the service had failed, where the answer is that the
 * call was never made (Codex on pull request 52). What stays out is everything that is nobody's
 * no: an account to connect again, a key the machine was not given, arguments that were wrong, a
 * place the forecast does not reach.
 */
const REFUSED_FACTS: ReadonlySet<string> = new Set([
  "laf:policy_denied",
  "laf:no_rule_allows",
  "laf:declined_recently",
  "laf:person_declined",
  "laf:tool_not_granted",
  "laf:tool_needs_review",
]);

/**
 * How an object written by THIS APP begins, to the key: the window's wrapper (`ok`, `refused`,
 * `reason` — written by the window's own handler until 2026-10-05, and still what a conversation
 * from before then holds), the server's refusal (`refusal` in `server/src/turns/chat-tools.ts`:
 * `ok`, `code` — a `laf:` fact), and its "an approval is being asked" (`ok`, `awaitingApproval`).
 *
 * A SERVICE'S OWN ANSWER CAN SAY `ok: false` TOO. A call that came back with the service's own
 * JSON — a status of `{"ok":false,"error":"channel_not_found"}`, which a service sends as an
 * ordinary answer — read "did not work", or "blocked" for a `refused: true` of its own, on a call
 * that was made and answered (Codex on pull request 52). So only an object written by one of this
 * app's own writers is read as one of ours; anything else is the service's answer, whatever it says.
 *
 * READ OFF THE HEAD, NOT PARSED, so the bound on parsing cannot hide one: a reason is whatever a
 * route wrote, and a 5,000-character reason made a wrapper too long to be parsed — which then read
 * back as the service's answer (Codex on pull request 44, round 5). Every writer writes `ok` first.
 */
const OWN_ENVELOPE =
  /^\{"ok":false,"(?:refused":(?:true|false),"reason":|code":"laf:[a-z0-9_]+"|awaitingApproval":true)/;

/** How a finished step failed, or null for one that ended with the service's own answer. */
export function stepFailureOf(result: string): StepFailure | null {
  if (result.startsWith(TOOL_ERROR_PREFIX)) {
    return { kind: "error", text: result.slice(TOOL_ERROR_PREFIX.length) };
  }
  if (result === TOOL_NOT_ALLOWED) return { kind: "refused", code: null };
  if (result === UNANSWERED_RESULT) return { kind: "failed", code: null };
  const kindOf = (code: string | null) =>
    code !== null && REFUSED_FACTS.has(code) ? "refused" : "failed";
  // Nothing longer than the longest sentence is one: a megabyte of mail is not looked up.
  if (result.length <= LONGEST_SENTENCE) {
    const said = FACT_OF_SENTENCE.get(result);
    if (said !== undefined) return { kind: kindOf(said), code: said };
  }
  if (BARE_FACT.test(result)) return { kind: kindOf(result), code: result };
  if (result.startsWith(THROWN_HEAD)) return { kind: "failed", code: null };
  // An object, then — and only one of ours is a failure (`OWN_ENVELOPE`).
  if (!OWN_ENVELOPE.test(result)) return null;
  // Too long to parse, it says no more than that it is ours.
  const facts =
    result.length > REFUSAL_OBJECT_MAX ? null : resultFactsOf(result);
  const code = facts?.code ?? null;
  return { kind: facts?.refused === true ? "refused" : kindOf(code), code };
}
