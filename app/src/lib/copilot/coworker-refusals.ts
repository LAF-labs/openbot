/**
 * What asking a coworker can be refused for, said twice: once to the person, once to the asking Bot.
 *
 * The route (`POST /api/agents/:id/ask`) used to answer with the sentence the server wrote for the
 * MODEL — "That question is 9,120 characters, and a coworker takes at most 8,000…" — and this tool
 * printed the same sentence on the person's transcript line, in English, and for a failed coworker
 * the sentence was the model provider's own. The server sends the code and its numbers now (audit
 * A1-3); the person's words are the table below, through `t()`, and the model's words are chosen
 * here too, in the language this tool already speaks to the model.
 *
 * `t()` on a variable, so `coworker-refusals.test.ts` walks the table against the server's codes.
 */
export const COWORKER_REFUSALS: Record<string, string> = {
  "laf:delegation_too_deep":
    "A Bot answering for another Bot cannot ask a third.",
  "laf:ask_in_delegated_turn":
    "That needed your say-so, and a Bot answering for another cannot ask you. Ask the Bot directly.",
  "laf:coworker_question_empty": "There was no question to ask.",
  "laf:coworker_question_too_long": "The question was too long to hand over.",
  "laf:coworker_is_self": "A Bot cannot ask itself.",
  "laf:coworker_not_found": "That coworker is no longer there.",
  "laf:coworker_timed_out": "The coworker did not answer in time.",
  "laf:coworker_failed": "The coworker could not answer.",
  "laf:coworker_stopped":
    "Everything was stopped, so the coworker stopped answering too.",
};

/** The numbers a refusal carries beside its code, read defensively: the body crossed a network. */
function numberIn(facts: Record<string, unknown>, key: string): string {
  const value = facts[key];
  return typeof value === "number" ? value.toLocaleString("en-US") : "?";
}

/**
 * The same refusal as the asking Bot reads it: what happened, and what to do instead.
 *
 * Instructions rather than labels, because a refusal a model cannot act on is one it retries
 * unchanged — which spends the turn twice and ends in the same place.
 */
export function coworkerRefusalForModel(
  code: string | undefined,
  facts: Record<string, unknown>,
): string {
  switch (code) {
    case "laf:delegation_too_deep":
      return "A coworker answering a question cannot ask another coworker. Answer with what you know, and say what a colleague would have to be asked.";
    case "laf:ask_in_delegated_turn":
      return "That needed a person's say-so, and a coworker answering for another Bot cannot ask a person. Say what would need approving instead.";
    case "laf:coworker_question_empty":
      return "The question was empty. Ask the coworker something.";
    case "laf:coworker_question_too_long":
      return `That question is ${numberIn(facts, "length")} characters, and a coworker takes at most ${numberIn(facts, "limit")}. Ask for what you actually need, and point at the rest rather than pasting it.`;
    case "laf:coworker_is_self":
      return "That is you. Ask a different coworker.";
    case "laf:coworker_not_found":
      return "That coworker is not in the roster any more. Check the roster in this tool's description.";
    case "laf:coworker_timed_out":
      return "The coworker did not answer in time. Answer with what you know, or ask again later.";
    // A person pressed stop on everything: going on — asking again, or anything else — is the
    // opposite of what they asked for.
    case "laf:coworker_stopped":
      return "A person stopped everything that was running, this question included. Do not ask again, and do not carry on with the task.";
    default:
      return "The coworker could not answer right now. Answer with what you know.";
  }
}
