/**
 * What the computer's routes refuse, in the words of the screen that asked.
 *
 * The routes answer a `laf:` code and no sentence (`server/src/computer/routes.ts`). Until
 * 2026-09-14 they answered English, and three readers printed it as it came: the masked box a person
 * types a password into, the Boundaries page and the Computers page. `t()` on a variable, so
 * `computer-refusals.test.ts` walks these tables against the server's own source — the coverage walk
 * only sees a literal argument.
 */

/** Handing a value to the page through the masked box. */
export const SECRET_REFUSALS: Record<string, string> = {
  "laf:secret_not_pending": "Nothing is waiting for that value any more.",
  "laf:secret_field_gone":
    "The box for that value is no longer on the page. Ask the Bot to request it again.",
  // The same box, gone by the time the value arrived: the page changed under the request.
  "laf:stale_refs":
    "The box for that value is no longer on the page. Ask the Bot to request it again.",
  "laf:computer_unreachable": "The Bot's computer could not be reached.",
  "laf:computer_timed_out": "The Bot's computer did not answer in time.",
};

/** Saving the boundary. */
export const BOUNDARY_REFUSALS: Record<string, string> = {
  // The one that says what is still true, which is the thing an administrator needs to know.
  "laf:policy_not_saved":
    "That rule could not be saved, so it has not been applied. The previous boundary is still in force.",
  // This page builds the body itself, so these three are a bug rather than a mistake to correct.
  "laf:policy_not_object":
    "The boundary could not be read. Nothing was changed.",
  "laf:policy_list_invalid":
    "The boundary could not be read. Nothing was changed.",
  "laf:policy_settle_invalid":
    "The boundary could not be read. Nothing was changed.",
};

/**
 * The words for a refusal's code out of one of the tables, or the reader's own sentence.
 *
 * Never the server's `error`: that field is the code itself now, and read as a fallback it would
 * print `laf:…` on the screen. One reader for every screen since the rest of the server's refusals
 * became codes too (2026-09-14); it lives in `lib/refusals.ts` and is named here as it always was.
 */
export { refusalText } from "@/lib/refusals";
