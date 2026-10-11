import { bareNameOf, serverKeyOf } from "@shared/tools/bridge";
import { t } from "@/lib/i18n";
import { serviceLabel, toolLabel } from "@/lib/plugins/tool-labels";
import { own } from "@/lib/own";

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
  // The conversation's Bot handing its browsing over (`shared/tools/delegate.ts`). What is done
  // with it is drawn under this line, as the browsing it is.
  delegate: "Handing the browsing over",
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
 * What a line says once the step is over, where "…는 중" would no longer be true.
 *
 * The lines above are drawn by the transcript for a call nothing else draws, and they are all "…는
 * 중": right while the call is out, and wrong for as long as the conversation is kept afterwards.
 * Nearly every tool here has a line of its own that already says both (`now-tool-line.tsx`,
 * `computer-tools.tsx`), and a finished `tool_search` is not drawn at all (`chat-messages.ts`), so
 * this holds only what can still be seen finished under its in-progress words.
 */
export const STEP_DONE_LABELS: Readonly<Record<string, string>> = {
  tool_call: "Used a tool",
  delegate: "Used the browser",
};

/**
 * `delegate`, by who the work was handed to (`to`, `shared/tools/delegate.ts`).
 *
 * The line is the work, not the hand-over. With one target the tool's name was enough; with two,
 * a Bot thinking a problem through for half a minute under "브라우저로 알아보는 중" would be a line
 * that says something that is not happening. The browser has no entry here and reads as the
 * tables above have it.
 *
 * UNTIL `to` HAS ARRIVED THE LINE DOES NOT SAY WHICH (`DELEGATING`). Seen on the real stack
 * (2026-10-11): the model writes `task` first and `to` last, so for the five seconds the task
 * took to stream, a problem being handed to thinking read "브라우저로 알아보는 중". A line that
 * guesses is right for one kind of work and wrong for the other.
 */
export const DELEGATED_STEP_LABELS: Readonly<
  Record<string, { doing: string; done: string }>
> = {
  think: { doing: "Thinking it through", done: "Thought it through" },
};

/** What a `delegate` call's line says while who it is handed to has not arrived. */
export const DELEGATING = "Getting ready";

/** Who a `delegate` call hands its work to, read from arguments that may still be arriving. */
function delegatedTo(rawArguments: string | undefined): string | undefined {
  return /"to"\s*:\s*"([a-z]+)"/.exec(rawArguments ?? "")?.[1];
}

/**
 * A connected service's tools, by `<service>/<tool>`. The six a person is asked about are named in
 * `plugins/tool-labels.ts` already, for the approval card, and are read from there.
 */
export const SERVICE_STEP_LABELS: Readonly<Record<string, string>> = {
  "public-data/search_support_programs": "Searching support programmes",
  "public-data/search_bids": "Searching public tenders",
  "web-search/search": "Searching the web",
  "kma-weather/get_weather": "Checking the weather",
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
  // 목표's own tools (`shared/tools/goals.ts`), served by this deployment, not a connected service.
  "goals/save_goal": "Saving a goal",
  "goals/update_goal": "Changing a goal",
  "goals/log_progress": "Logging progress",
  "goals/list_goals": "Reading the goals",
  // The main conversation's way into the projects (`shared/tools/projects.ts`), this deployment's too.
  "projects/read": "Looking in the projects",
};

/**
 * Services whose one step already says where it happens. "웹 검색하기 · 웹 검색" said the same thing
 * twice, on a line of its own between two cards (the owner's screenshot, 2026-10-03): the place IS
 * what was done.
 */
const SAID_BY_ITS_OWN_STEP: ReadonlySet<string> = new Set(["web-search"]);

/**
 * The line for one call: what was done, and — for a connected service's tool — where.
 *
 * A tool nobody here has a name for still never shows its own name. A connected service's falls
 * back to the service's Korean title ("Notion 사용"), which is true of every tool it has; one on a
 * server somebody added by address, which has no title here, to "연결된 서비스 사용"; anything else
 * to "도구 사용".
 */
export function stepLineOf(
  name: string,
  /** The step has its result: say what was done, not what is being done. */
  isDone = false,
  /** The call's arguments as they stand, for the one line that depends on them (`delegate`). */
  rawArguments?: string,
): { label: string; detail?: string } {
  if (name === "delegate") {
    const to = delegatedTo(rawArguments);
    const handed = own(DELEGATED_STEP_LABELS, to ?? "");
    if (handed) return { label: t(isDone ? handed.done : handed.doing) };
    // Arguments are arriving and `to` is not among them yet. A caller with no arguments at all
    // (a line drawn from the name alone) reads as the tables have it, as it always did.
    if (to === undefined && rawArguments !== undefined && !isDone) {
      return { label: t(DELEGATING) };
    }
  }
  const said =
    (isDone ? own(STEP_DONE_LABELS, name) : undefined) ??
    own(STEP_LABELS, name);
  if (said) return { label: t(said) };
  const server = serverKeyOf(name);
  if (!server) return { label: t("Used a tool") };
  const ref = `${server}/${bareNameOf(name)}`;
  const service = serviceLabel(server);
  const known = own(SERVICE_STEP_LABELS, ref);
  const label = known ? t(known) : toolLabel(ref);
  if (label) {
    return service && !SAID_BY_ITS_OWN_STEP.has(server)
      ? { label, detail: service }
      : { label };
  }
  return {
    label: service
      ? t("Used {service}", { service })
      : t("Used a connected service"),
  };
}
