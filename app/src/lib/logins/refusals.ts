/**
 * Why a login was not saved, in the person's words.
 *
 * The server sends the fact as a code and which box it is about (`server/src/logins/store.ts`,
 * `LoginRefused`); the sentence is this screen's. Read through a variable, so the dictionary's
 * own test cannot see these: `app/tests/login-refusals.test.ts` walks the table, and walks the
 * server's list of codes against it.
 */
import { t } from "@/lib/i18n";
import { own } from "@/lib/own";

export const LOGIN_REFUSALS: Readonly<Record<string, string>> = {
  "laf:login_invalid":
    "That could not be read as a login. Check each box and try again.",
  "laf:login_label_required": "Give it a name you will know it by.",
  "laf:login_origin_refused":
    "That is not an address a login can be saved for. Use the site's own https address.",
  "laf:login_origins_required": "Add the address its sign-in is on.",
  "laf:login_origins_too_many": "That is too many addresses for one login.",
  "laf:login_site_unknown": "That site is not one this app knows.",
  "laf:login_value_required": "This cannot be left empty.",
  "laf:login_value_too_long": "That is too long to save.",
  "laf:logins_full": "No more logins can be saved. Delete one first.",
  "laf:login_not_found": "That login is not saved any more.",
  "laf:login_seal_unreadable":
    "This login can no longer be opened. Type its sign-in name and password again.",
  "laf:logins_unreachable":
    "That did not reach the server. Check the connection and try again.",
};

/** The sentence for a refusal, or one that says only that it did not work. */
export function loginRefusalText(code: string): string {
  return t(own(LOGIN_REFUSALS, code) ?? "That was not saved. Try again.");
}
