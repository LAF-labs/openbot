import { t } from "@/lib/i18n";

/**
 * WHY A SIGN-IN WAS REFUSED, IN THE WORDS OF THE SCREEN AND NEVER IN BETTER-AUTH'S.
 *
 * Audit wave 1 left the sign-in screen printing `result.error.message` as it came: better-auth's
 * "Too many requests. Please try again later." under the buttons of a Korean screen, from the fourth
 * press in ten seconds. And that was only the road the screen could see. A refusal reaches it three
 * ways, measured on the rehearsal VM (`:edge` 58918bd, 2026-09-14):
 *
 *  - the START (`POST /api/auth/sign-in/oauth2`, `/sign-in/social`) answers a status and sometimes a
 *    code, with English prose written for a developer;
 *  - the CALLBACK redirects with `?error=<code>` — the provider's word (`access_denied`) or
 *    better-auth's (`state_mismatch`) — and an `error_description` that is the provider's prose;
 *  - and whatever the callback cannot send elsewhere goes through better-auth's own `/api/auth/error`,
 *    which on a production deployment answers `302 /?error=state_mismatch` — and the root, signed
 *    out, forwards its address here as `?redirect=/?error=state_mismatch`. That page also rewrites
 *    any code it dislikes to `UNKNOWN`: `This_deployment_belongs_to_someone_else.` came back as
 *    `/?error=UNKNOWN`, which is why `client.ts` now names this screen as the callback's error page.
 *
 * Before this, only the first road drew anything, and it drew the English. The screen reads the CODE,
 * and only the code, and the words are ours; a code nobody wrote words for draws one generic sentence
 * rather than the code, since a provider's word on a Korean screen is the same failure as
 * better-auth's.
 */
export type SignInRefusal =
  | "rate_limited"
  | "cancelled"
  | "expired"
  | "not_admitted"
  | "other_sign_in"
  | "email_missing"
  | "profile_missing"
  | "misconfigured"
  | "server_trouble"
  | "unreachable"
  | "unknown";

/**
 * The key a code is looked up by: lower case, every run of anything else one underscore.
 *
 * Because the same fact arrives spelled several ways. better-auth writes its callback codes in lower
 * case (`state_mismatch`) and its API codes in upper (`PROVIDER_NOT_FOUND`), once in camel case
 * (`oAuth_code_missing`) and once with an apostrophe (`email_doesn't_match`); and a refusal thrown
 * from this deployment's own hook reaches the callback as its MESSAGE with the spaces swapped —
 * `This_deployment_belongs_to_someone_else.`, full stop included.
 */
export function refusalKey(code: string): string {
  return code
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Every code that can reach this screen, by `refusalKey`.
 *
 * Read off better-auth 1.6.27 (the version `bun.lock` holds), the two start routes this deployment
 * uses and the origin check in front of them, the social callback (`api/routes/callback.mjs`), the
 * generic OIDC client the fleet's broker is reached through (`plugins/generic-oauth/routes.mjs`), the
 * state both parse (`state.mjs`, `oauth2/state.mjs`) and the account step (`oauth2/link-account.mjs`);
 * and the codes an authorization server may redirect with — RFC 6749 §4.1.2.1 and OpenID Connect Core
 * §3.1.2.6, which is what the broker's `oidc-provider` sends. `sign-in-refusals.test.ts` reads the
 * callback codes out of the installed better-auth rather than out of this comment, so an upgrade that
 * adds one fails there first.
 */
const REFUSAL_BY_KEY: Readonly<
  Record<string, Exclude<SignInRefusal, "unknown">>
> = {
  /*
   * The API's own limit on sign-in starts (`server/src/middleware/security.ts`), which stands in
   * front of better-auth's: twenty a minute from one address. better-auth's own 429, from the
   * fourth start in ten seconds, carries no code and is read by its status.
   */
  laf_rate_limited: "rate_limited",

  // Declined, or left unfinished, at the provider.
  access_denied: "cancelled",
  login_required: "cancelled",
  consent_required: "cancelled",
  interaction_required: "cancelled",
  account_selection_required: "cancelled",

  /*
   * The authorization server refused the REQUEST: this deployment's registration, not the person. (A
   * bad client id or redirect URI never comes back at all — RFC 6749 has the server say so on its own
   * page instead of redirecting — so neither is here.)
   */
  invalid_request: "misconfigured",
  unauthorized_client: "misconfigured",
  unsupported_response_type: "misconfigured",
  unsupported_response_mode: "misconfigured",
  invalid_scope: "misconfigured",
  invalid_request_uri: "misconfigured",
  invalid_request_object: "misconfigured",
  request_not_supported: "misconfigured",
  request_uri_not_supported: "misconfigured",
  registration_not_supported: "misconfigured",
  invalid_target: "misconfigured",
  unmet_authentication_requirements: "misconfigured",
  // …and its own trouble.
  server_error: "server_trouble",
  temporarily_unavailable: "server_trouble",

  /*
   * The callback could not match the answer to a sign-in this browser started: too slow (the state
   * lives ten minutes), started in another window or browser, or a code already spent on a reload.
   * Starting again is the whole remedy.
   */
  invalid_callback_request: "expired",
  no_code: "expired",
  oauth_code_missing: "expired",
  invalid_code: "expired",
  oauth_code_verification_failed: "expired",
  no_callback_url: "expired",
  state_not_found: "expired",
  state_mismatch: "expired",
  state_security_mismatch: "expired",
  state_invalid: "expired",
  cross_site_navigation_login_blocked: "expired",

  // The provider said yes and sent too little to make an account from.
  email_not_found: "email_missing",
  email_is_missing: "email_missing",
  unable_to_get_user_info: "profile_missing",
  user_info_is_missing: "profile_missing",
  id_is_missing: "profile_missing",
  name_is_missing: "profile_missing",

  /*
   * An account with this email exists, made through another button: better-auth links a second
   * sign-in to it only when both sides' email is verified, and says `account not linked` otherwise.
   * The other two are the linking flow's own and are here so they cannot draw the generic sentence.
   */
  account_not_linked: "other_sign_in",
  email_doesn_t_match: "other_sign_in",
  account_already_linked_to_different_user: "other_sign_in",

  /*
   * Not on this deployment's list. `server/src/auth/index.ts` refuses an unlisted email while the
   * account is being made, and an account struck off the list when it asks for a session, with
   * `laf:sign_in_not_admitted` both times — better-auth hands it on as the message on the first
   * road and as the code on the second. It was the sentence `This_deployment_belongs_to_someone_else.`
   * until 2026-09-14, and the second road did not reach this screen at all.
   */
  laf_sign_in_not_admitted: "not_admitted",
  signup_disabled: "not_admitted",

  // The deployment itself.
  oauth_provider_not_found: "misconfigured",
  provider_not_found: "misconfigured",
  invalid_oauth_configuration: "misconfigured",
  issuer_mismatch: "misconfigured",
  issuer_missing: "misconfigured",
  callback_url_required: "misconfigured",
  invalid_callback_url: "misconfigured",
  invalid_error_callback_url: "misconfigured",
  invalid_origin: "misconfigured",
  missing_or_null_origin: "misconfigured",
  validation_error: "misconfigured",
  unable_to_link_account: "server_trouble",
  unable_to_create_user: "server_trouble",
  unable_to_create_session: "server_trouble",
  internal_server_error: "server_trouble",
  state_generation_error: "server_trouble",

  // The front door, answering for an API that is not behind it (`app/Caddyfile`, `handle_errors`).
  laf_api_unreachable: "unreachable",
};

/** What a code means for the person, or `unknown` for a code nobody wrote words for. */
export function refusalForCode(code: string | null | undefined): SignInRefusal {
  if (!code) return "unknown";
  return REFUSAL_BY_KEY[refusalKey(code)] ?? "unknown";
}

/** Every code this screen has its own words for, spelled as `refusalKey` spells them. */
export const KNOWN_REFUSAL_KEYS: readonly string[] =
  Object.keys(REFUSAL_BY_KEY);

/**
 * A start the server refused, or one that never reached it.
 *
 * The code first, where there is one: it is the only thing that tells the front door's 503 for an
 * API that is not there (`laf:api_unreachable`) from the API's own 503 for a deployment with no
 * sign-in configured. Then the status. No status at all is a request that got no answer.
 */
export function refusalForStart(failure: {
  status?: number;
  code?: string | null;
}): SignInRefusal {
  const byCode = refusalForCode(failure.code);
  if (byCode !== "unknown") return byCode;
  const status = failure.status ?? 0;
  if (status === 0) return "unreachable";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 504) return "unreachable";
  // Ours: `server/src/app.ts` answers every `/api/auth/*` with it while no sign-in is configured.
  if (status === 503) return "misconfigured";
  if (status >= 500) return "server_trouble";
  return "unknown";
}

/**
 * One sentence per refusal. A switch of literal `t()` calls rather than a table of strings, so the
 * dictionary walk sees every one of them.
 */
export function refusalSentence(refusal: SignInRefusal): string {
  switch (refusal) {
    case "rate_limited":
      return t(
        "Too many sign-in attempts in a row. Wait a few seconds and try again.",
      );
    case "cancelled":
      return t(
        "Sign-in was cancelled before it finished. Press a button to start again.",
      );
    case "expired":
      return t(
        "This sign-in took too long or was started in another window. Start again from here.",
      );
    case "not_admitted":
      return t(
        "This account cannot sign in here. Try again with the account this place was set up for.",
      );
    case "other_sign_in":
      return t(
        "This email already has an account here, made with a different button. Sign in with the one you used first.",
      );
    case "email_missing":
      return t(
        "The account you chose did not share its email address. Allow the email address when you are asked, then try again.",
      );
    case "profile_missing":
      return t(
        "The service you signed in with did not send your account details. Please try again.",
      );
    case "misconfigured":
      return t(
        "Sign-in is not set up correctly here yet. Nothing here needs fixing — get in touch and we will fix it.",
      );
    case "server_trouble":
      return t(
        "Sign-in could not be finished on our side. Please try again in a moment.",
      );
    case "unreachable":
      return t(
        "The server could not be reached. Please try again in a moment.",
      );
    case "unknown":
      return t("Could not sign in. Please try again.");
  }
}

/**
 * The refusal a sign-in screen was opened with, and where to go once somebody is in.
 *
 * `?error=` is the callback's road. `?redirect=/?error=` is better-auth's error page's: with no
 * `errorURL` configured it sends a production deployment to the root with the code, and the root,
 * signed out, forwards its own address here. That code is read as a refusal and then taken OUT of the
 * destination — left in, a later sign-out would carry `/?error=…` back to this screen and draw a
 * refusal for a sign-in nobody attempted.
 */
export function refusalOnArrival(search: {
  error?: string;
  redirect?: string;
}): {
  code: string | null;
  redirect: string | undefined;
} {
  if (search.error !== undefined) {
    return { code: search.error, redirect: search.redirect };
  }
  if (!search.redirect) return { code: null, redirect: undefined };
  let target: URL;
  try {
    // Any base will do: only a path on this app is ever read back out of it.
    target = new URL(search.redirect, "http://sign.invalid");
  } catch {
    return { code: null, redirect: search.redirect };
  }
  const code = target.searchParams.get("error");
  if (target.pathname !== "/" || code === null) {
    return { code: null, redirect: search.redirect };
  }
  target.searchParams.delete("error");
  target.searchParams.delete("error_description");
  const rest = target.searchParams.toString();
  return { code, redirect: `/${rest ? `?${rest}` : ""}${target.hash}` };
}
