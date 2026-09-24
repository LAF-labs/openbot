/**
 * The boundary a deployment gets before anybody writes one.
 *
 * WHAT WAS HERE BEFORE WAS `allow: ["true"]` AND NOTHING ELSE, and the README's promise — that a Bot
 * takes the wheel to a person when it reaches something it should not do alone — was true only after
 * an administrator had opened the Boundaries page and written a rule. Nobody writes that rule before
 * the first time it was needed. The other side is the same failure: a Bot that can look at a page and
 * touch nothing is not a product either, so this stays permissive and names the few things worth
 * stopping for, rather than starting from "nothing is allowed".
 *
 * It is also the shape of the risk this product is for. The MCP path has asked about money, external
 * effects and destruction since it existed (`plugins/store.ts`), so writing a page in Notion stopped
 * to ask while pressing 송금 in a bank's browser did not — and the second is where a small business
 * loses money.
 *
 * THE DEPLOYMENT EDITS THE SAVED POLICY, NOT THIS FILE. What is here is what a deployment starts
 * with; `/admin/boundaries` writes over it, the saved policy wins from then on, and `reset` on the
 * store is what comes back to this. Editing this file changes what a NEW deployment gets and nothing
 * about one that is already running. The lists (`shared/policy-rules.ts`) are exported as data for
 * exactly that reason: a deployment that wants another bank or another word adds it on that page.
 *
 * The rules are CEL, in the same language an administrator writes in, and generated from the lists so
 * that the rule a person reads on the Boundaries page is the rule that ran.
 */
import {
  MONEY_HOST_RULE,
  MONEY_WORD_RULE,
  REPEAT_RULE,
  SECRET_FIELD_RULE,
  SECRET_FIELD_WORDS,
  UPLOAD_RULE,
  wordPattern,
} from "../../../shared/policy-rules";
import type { ActionPolicy, PolicyContext } from "./policy";

/*
 * THE LISTS AND THE RULES LIVE IN `shared/policy-rules.ts` since 2026-09-24, so the card a person
 * answers on can recognise which of them stopped the Bot and say why in words — it used to print
 * the CEL itself (UI/UX audit 0.5.3, item 3). Re-exported here, because this is where the server and
 * its tests have always read them from, and a second import path for one list is how two copies
 * start.
 */
export {
  hostPattern,
  isSimpleTerm,
  MONEY_HOST_RULE,
  MONEY_HOSTS,
  MONEY_WORD_RULE,
  MONEY_WORDS,
  REPEAT_ASK_AT,
  REPEAT_RULE,
  SECRET_FIELD_RULE,
  SECRET_FIELD_WORDS,
  UPLOAD_RULE,
  wordPattern,
} from "../../../shared/policy-rules";

/**
 * What a deployment enforces when it has not said otherwise.
 *
 * Permissive at the bottom and explicit about it: everything not named in the shared rules is
 * allowed, recorded, and visible in the audit trail. The `allow: ["true"]` line is a decision
 * somebody wrote down rather than a default that fell out of an empty list.
 */
export const DEFAULT_ACTION_POLICY: ActionPolicy = {
  deny: [SECRET_FIELD_RULE],
  ask: [MONEY_WORD_RULE, MONEY_HOST_RULE, UPLOAD_RULE, REPEAT_RULE],
  allow: ["true"],
};

const SECRET_NAMES = new RegExp(wordPattern(SECRET_FIELD_WORDS), "iu");

/**
 * Whether a control, by its label or its type, holds something the Bot must never be shown.
 *
 * The same two signals `SECRET_FIELD_RULE` refuses typing into, asked of a snapshot element on the
 * way back rather than of an action on the way in: a field the Bot may not fill is a field whose
 * contents it may not read either, and the snapshot is where those contents arrive.
 */
export function isSecretFieldElement(element: {
  name: string;
  type?: string | undefined;
}): boolean {
  return element.type === "password" || SECRET_NAMES.test(element.name);
}

/**
 * Whether the action being refused is a Bot typing into a secret field.
 *
 * Read off the action rather than off the rule that matched, because the fact the Bot needs — there
 * is another way to get this value into the page — is true whichever rule refused it, including one
 * a deployment wrote itself. See `laf:use_request_secret` in policy.ts.
 */
export function isSecretField(context: PolicyContext): boolean {
  if (context.intent !== "type") return false;
  if (context.element?.type === "password") return true;
  return SECRET_NAMES.test(context.element?.name ?? "");
}
