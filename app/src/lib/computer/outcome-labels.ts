/**
 * What a refused or failed computer call says on its transcript line, in the person's words.
 *
 * English keys because that is how `t()` works here, and a table rather than literals because the
 * value arrives as a code at runtime. `t(variable)` is invisible to the i18n coverage test, so this
 * table is walked by two of its own: `tool-result-codes.test.ts` (Korean for both readers, and never
 * the same sentence) and `computer-codes.test.ts` (every code the Bot's computer can answer a Bot's
 * call with is here).
 *
 * Its own module since 2026-09-14, out of `lib/copilot/computer-tools.tsx`, so that a test can import
 * it beside the container's list without loading the copilot runtime. A code with no line here fell
 * back to the MODEL's sentence — an instruction to a Bot, printed under a person's transcript — and
 * that is what most of the container's codes did until then.
 */
export const OUTCOME_LABELS: Record<string, string> = {
  "laf:human_has_control": "A person has the computer",
  "laf:stopped": "Stopped",
  "laf:person_declined": "A person declined that",
  "laf:computer_unreachable": "The Bot's computer could not be reached",
  "laf:nobody_answered": "Nobody answered in time",
  "laf:request_cancelled": "The request was cancelled",
  /*
   * The boundary's own refusals, which used to arrive as English sentences the server had assembled
   * and this line printed as they came. Five facts rather than one, because what a person does next
   * differs: a rule to edit, a rule to add, a snapshot to take, an answer they already gave, and a
   * password box that has its own door (§5.1(b)).
   */
  "laf:policy_denied": "A rule refused it",
  "laf:no_rule_allows": "No rule allows it",
  "laf:blind_action": "The screen had not been read yet",
  "laf:declined_recently": "You said no to this recently",
  "laf:use_request_secret": "It asked for a secret instead",
  /*
   * Two more floors under the boundary (security review, 2026-09): a letter pressed as a key is
   * typing that no rule could see, and a secret request has to name a field on the screen the
   * server holds — not whatever box a page told the Bot to point at.
   */
  "laf:key_is_text": "A letter was pressed as a key",
  "laf:secret_target_not_a_field":
    "The secret was aimed at something that is not a field",
  "laf:tool_arguments_invalid": "The Bot's request was incomplete",
  /*
   * What the server's client says itself, where the computer's answer could not: nothing answered,
   * too late, no code at all, an address the floor refused before anything was sent, a redirect
   * chain the gateway would not follow round.
   */
  "laf:computer_failed": "It did not work on the Bot's computer",
  "laf:computer_timed_out": "The Bot's computer did not answer in time",
  "laf:url_invalid": "That is not a web address",
  "laf:redirect_loop": "The page kept redirecting",
  /*
   * WHAT THE BOT'S COMPUTER ANSWERED, BY ITS OWN NAMES (`agent-computer/src/codes.ts`). Until
   * 2026-09-14 the server renamed some of these on the way (`laf:workspace_path_refused`,
   * `laf:workspace_file_unusable`) and this table knew only the new names — the container's own
   * reached the line as the model's instruction.
   */
  // The door, and the browser itself: whatever the call was.
  "laf:computer_token_refused": "The Bot's computer did not accept this server",
  "laf:bot_header_missing": "The call did not say which Bot",
  "laf:bot_id_invalid": "The Bot's id was not a name",
  "laf:computer_route_unknown": "The Bot's computer is a different version",
  "laf:browser_failed": "The Bot's browser did not manage it",
  "laf:navigation_guard_unavailable": "The Bot's browser did not start",
  "laf:egress_unguarded": "The Bot's browser was kept closed for safety",
  "laf:request_invalid": "The computer could not use the request",
  // Opening a page.
  "laf:page_timeout": "The page did not open in time",
  "laf:navigation_failed": "The page could not be opened",
  "laf:navigation_refused": "An address inside this deployment was blocked",
  // Acting on it.
  "laf:stale_refs": "The screen had changed",
  "laf:label_changed": "The control had been renamed",
  "laf:element_not_actionable": "That element could not be used",
  "laf:tab_missing": "There is no such tab",
  // The workspace.
  "laf:file_path_refused": "That path is outside the workspace",
  "laf:file_not_found": "Nothing is at that path",
  "laf:file_wrong_kind":
    "A folder where a file was meant, or the other way round",
  "laf:file_too_large": "Too large for the workspace",
  "laf:file_failed": "The workspace could not do it",
};
