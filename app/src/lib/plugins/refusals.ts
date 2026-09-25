/**
 * What the plugin routes refuse, in the words of the screens that asked.
 *
 * The routes answered English until 2026-09-14 — "A slug is lower-case letters, numbers and
 * hyphens.", "`/standup` is somebody else's skill.", "Give a hostname rather than an IP address." —
 * and four screens printed it as it came: the skill form, a skill's Bot list, the skills page and a
 * teaching session's 스킬로 저장, and the admin Plugins page. The routes send `laf:` codes and no
 * prose now (`server/src/plugins/routes.ts`, `servers.ts`, `catalogue.ts`); these tables own the
 * sentences, read through `refusalText`, and `plugin-refusals.test.ts` walks them against the
 * server's own source — the coverage walk only sees a literal `t()`.
 *
 * The connect button's refusals are not here: `components/plugins/connections.tsx` has read those by
 * code since before this, and the Bot's own tool call is told in the model's words
 * (`shared/prompt/tool-results.ko.ts`).
 */

/** Writing a skill, deleting one, and putting one on a Bot or taking it off. */
export const SKILL_REFUSALS: Record<string, string> = {
  "laf:skill_incomplete": "A skill needs a command, a title and instructions.",
  // Korean names are commands too since 2026-09-24 (`SKILL_SLUG_PATTERN`); the old sentence said not.
  "laf:skill_slug_invalid":
    "Letters (Korean too), numbers and hyphens, 2 to 40, with no spaces.",
  "laf:skill_not_yours":
    "That skill is somebody else's, so only they can change it or put it on a Bot.",
  "laf:skill_belongs_to_deployment":
    "That skill was written for everyone here, so only an administrator can change it or choose its Bots.",
  "laf:skill_unknown": "There is no skill by that name.",
  // A skill the package ships (`built-in-skill-sync.ts`): the next upgrade would undo any edit.
  "laf:skill_built_in":
    "This skill comes with the app and is updated with it, so it cannot be changed or deleted here.",
  "laf:bot_not_owned": "You can only put your own skills on Bots you own.",
  // The client builds this request itself, so these two are a bug or a race, not a mistake to fix.
  "laf:grant_incomplete": "That change could not be read. Try again.",
  "laf:bot_not_found": "That Bot is no longer there.",
};

/** The admin Plugins page: adding a server from the catalogue or by address, refreshing, granting. */
export const PLUGIN_ADMIN_REFUSALS: Record<string, string> = {
  ...SKILL_REFUSALS,
  "laf:catalogue_key_required": "Choose a server from the list first.",
  // The same situation, and the same sentence, as the connect button's for an unconfigured service.
  "laf:deployment_key_missing":
    "This service is not available on this machine yet. Nothing here needs fixing — get in touch and we will turn it on.",
  "laf:server_unknown": "This deployment does not connect to that server.",
  "laf:tool_unknown": "That tool is no longer there. Refresh the list.",
  "laf:custom_server_incomplete":
    "A server needs a name, a title and an address.",
  "laf:server_name_invalid":
    "A server name is lower-case letters, numbers and hyphens.",
  "laf:server_name_taken":
    "That name belongs to a server this deployment already knows. Choose another.",
  "laf:server_address_moved":
    "That server is already here at another address and holds a token. Remove it, then add it again with the token for the new address.",
  "laf:server_takes_no_credential":
    "This server takes no token when it is added.",
  "laf:credential_not_for_server":
    "That token cannot be used for this server. Add the server's own token.",
  "laf:not_an_oauth_server":
    "This server is not connected through an OAuth client.",
  "laf:oauth_client_id_required": "Enter the client ID.",
  // What the address itself was refused for (`customUrlRefusal` and where the name resolves).
  "laf:custom_url_invalid": "That is not a web address.",
  "laf:custom_url_not_https": "The address has to start with https://.",
  "laf:custom_url_holds_credential":
    "Put the token in the token field, not in the address.",
  "laf:custom_url_is_address": "Use the server's host name, not an IP address.",
  "laf:custom_url_metadata":
    "That address holds this deployment's own cloud credentials, so it cannot be added.",
  "laf:custom_url_local":
    "That address is this deployment itself, so it cannot be added.",
  "laf:custom_url_internal":
    "That address cannot be reached from outside this network, so it cannot be added.",
  "laf:host_unresolvable":
    "That address could not be found, so it cannot be added.",
  "laf:host_resolves_privately":
    "That address points inside this network, so it cannot be added.",
  // A per-instance vendor's shop name, which the admin page can send as well as the connect button.
  "laf:instance_name_required": "Type your shop's name first.",
  "laf:instance_name_refused": "Check the shop ID and try again.",
};
