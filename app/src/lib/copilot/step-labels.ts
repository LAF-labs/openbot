import { bareNameOf, serverKeyOf } from "@shared/tools/bridge";
import { t } from "@/lib/i18n";
import { serviceLabel, toolLabel } from "@/lib/plugins/tool-labels";

/**
 * What a step line says a Bot did, in the owner's words, for any tool it can call.
 *
 * MEASURED 2026-09-27 (the 지원사업 walk): the transcript read "tool_search" and
 * "search_support_programs · public-data" to a shop owner on their first task. Two lines drew raw
 * names: the transcript's fallback for a call with no renderer, which printed the name itself, and
 * a connected service's line, which printed the tool's own name and the service's id. Both read
 * from here now.
 *
 * `tool_search` and `tool_call` are here too. They are how a Bot reaches a tool that is not in its
 * schema (`shared/tools/bridge.ts`) — the mechanism — and the owner is told what is being done, not
 * how.
 *
 * English keys read through `t(variable)`, which `i18n-coverage.test.ts` cannot see; the tables are
 * walked for their Korean by `step-labels.test.ts`, which also walks every tool the server's
 * catalogue and the shared tool list can hand a Bot.
 */
export const STEP_LABELS: Readonly<Record<string, string>> = {
  tool_search: "Finding a tool",
  tool_call: "Calling a tool",
  now: "Checking the clock",
  remember: "Writing it down",
  update_profile: "Updating the profile",
  manage_routine: "Managing routines",
  skill_view: "Opening a skill",
  routine_note: "Leaving a note for the routine",
  computer_navigate: "Opening a page",
  computer_read: "Reading the page",
  computer_snapshot: "Looking at the page",
  computer_click: "Clicking",
  // The browser's own words, as its card draws them.
  computer_type: "Filling in",
  computer_key: "Pressing a key",
  computer_scroll: "Scrolling",
  computer_switch_tab: "Switching tab",
  computer_upload_file: "Attaching a file",
  computer_request_secret: "Asking for a secret",
  computer_request_help: "Asking for help",
  computer_list_files: "Listing files",
  computer_read_file: "Reading a file",
  computer_write_file: "Saving a file",
};

/**
 * A connected service's tools, by `<service>/<tool>`. The six a person is asked about are named in
 * `plugins/tool-labels.ts` already, for the approval card, and are read from there.
 */
export const SERVICE_STEP_LABELS: Readonly<Record<string, string>> = {
  "public-data/search_support_programs": "Searching support programmes",
  "public-data/search_bids": "Searching public tenders",
  "gmail/search_messages": "Searching mail",
  "gmail/read_message": "Reading a mail",
  "gmail/create_draft": "Writing a draft",
  "google-calendar/list_events": "Reading the calendar",
  "google-business-profile/list_locations": "Reading the shop's listings",
  "google-business-profile/list_reviews": "Reading reviews",
  "google-drive/search_files": "Searching Drive",
  "google-drive/list_recent_files": "Listing recent files",
  "google-drive/get_file_metadata": "Reading a file's details",
  "google-drive/read_file_content": "Reading a Drive file",
  "google-sheets/list_sheet_tabs": "Listing a sheet's tabs",
  "google-sheets/read_sheet_values": "Reading a sheet",
  "google-sheets/append_sheet_row": "Adding a row to a sheet",
  "cafe24/list_orders": "Reading orders",
  "cafe24/read_order": "Reading an order",
  "cafe24/list_products": "Reading products",
  "cafe24/list_board_articles": "Reading board posts",
  "kakao-alimtalk/alimtalk_templates": "Reading KakaoTalk templates",
};

/**
 * The line for one call: what was done, and — for a connected service's tool — where.
 *
 * A tool nobody here has a name for still never shows its own name. A connected service's falls
 * back to the service's Korean title ("Notion 사용"), which is true of every tool it has; one on a
 * server somebody added by address, which has no title here, to "연결된 서비스 사용"; anything else
 * to "도구 사용".
 */
export function stepLineOf(name: string): { label: string; detail?: string } {
  const own = STEP_LABELS[name];
  if (own) return { label: t(own) };
  const server = serverKeyOf(name);
  if (!server) return { label: t("Used a tool") };
  const ref = `${server}/${bareNameOf(name)}`;
  const service = serviceLabel(server);
  const known = SERVICE_STEP_LABELS[ref];
  const label = known ? t(known) : toolLabel(ref);
  if (label) return service ? { label, detail: service } : { label };
  return {
    label: service
      ? t("Used {service}", { service })
      : t("Used a connected service"),
  };
}
