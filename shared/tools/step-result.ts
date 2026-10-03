import { TOOL_RESULT_KO } from "../prompt/tool-results.ko";
import { resultFactsOf, UNANSWERED_RESULT } from "../task-ending";

/**
 * HOW A CONNECTED SERVICE'S STEP ENDED, READ BACK FROM WHAT THE MODEL WAS TOLD.
 *
 * A step's result is kept as the text its Bot was given, and nothing beside it says whether the
 * step worked: the service's own answer, the service's own error, and this server's refusal are all
 * a string. The transcript has to tell them apart after the fact — a step that did not work is
 * something for the person, and must not be folded away behind the step after it
 * (`stepRunsOf` in the app; Codex on pull request 44).
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
 * Whether a finished step ended any way but with the service's own answer.
 *
 * ERRS TOWARDS YES. A step reached through the bridge may be one of the Bot's own tools, whose
 * good news is a sentence of that table too; said to have not worked, its line is only left in the
 * open, which is where every line was until there was a fold.
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
  if (result.length > REFUSAL_OBJECT_MAX) return false;
  const facts = resultFactsOf(result);
  return (
    facts !== null &&
    (facts.ok === false || facts.refused === true || facts.stopped === true)
  );
}
