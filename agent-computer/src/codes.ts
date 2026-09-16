/**
 * EVERY FACT THIS CONTAINER SENDS, AND HOW EACH ONE GOES OUT.
 *
 * The container is the source of truth for what happened inside the browser, and this is the list of
 * what it can say about it. Until 2026-09-14 there were two lists and neither was written down: this
 * process named its failures one way (`laf:navigation_failed`, `laf:file_not_found`) and the server's
 * client, which read statuses and Playwright's first line rather than `code`, named the same facts
 * another (`laf:page_failed`, `laf:workspace_file_unusable`) — and a Bot, the transcript and the
 * masked box each had words for one of the two.
 *
 * Every reader is held to THIS table: the server's client reads `code` and nothing else, through its
 * own one table (`COMPUTER_ANSWERS` in `server/src/computer/client.ts`); the model's words are in
 * `shared/prompt/tool-results.ko.ts`; the person's in the app's tables. `app/tests/computer-codes.test.ts`
 * fails when this can send a code any of them does not know, `server/tests/computer-routes-codes.test.ts`
 * drives every answer through the real client and routes, and `tests/code-list.test.ts` here fails
 * when a code is sent that is not listed, or listed and never sent.
 *
 * The status is decided here and nowhere else: `fact` in respond.ts takes a code and looks it up, so
 * one fact cannot leave two routes with two statuses. What each status tells the caller to do next:
 * 409 look again or wait, 403 never, 400 send something different, 504 and 502 the site did not, 500
 * and 502 the browser or the disk did not, 401 and 404 this computer and its caller disagree.
 */

/**
 * Whose calls a failure can be the answer to.
 *
 * - `any` — whatever was asked: the door (the token, the Bot's name, a route this build lacks) and
 *   the browser itself (it would not start, or would not do it). A person's screen meets these as
 *   surely as a Bot's tool does.
 * - `bot` — a Bot's own calls: a page, an action on it, a file.
 * - `person` — a person's own doors: the value typed into the masked box, their hands on the live
 *   screen.
 */
export type Caller = "any" | "bot" | "person";

type Answer = {
  /** The HTTP status it is answered with. */
  status: 400 | 401 | 403 | 404 | 409 | 499 | 500 | 502 | 504;
  caller: Caller;
  note?: true;
  screen?: true;
};

type Told =
  /** Carried on a result that worked — in `notes`, or on a frame — because nobody asked. */
  | { note: true }
  /** Sent down the live screen's socket, to the person watching it. */
  | { screen: true };

export const COMPUTER_CODES = {
  /* ── The door ─────────────────────────────────────────────────────────────────────────── */

  // The caller does not hold this deployment's token. Says nothing else about what is here.
  "laf:computer_token_refused": { status: 401, caller: "any" },
  // The caller named no Bot, or named one that is a path rather than a name.
  "laf:bot_header_missing": { status: 400, caller: "any" },
  "laf:bot_id_invalid": { status: 400, caller: "any" },
  // A route this build does not have: the server and this image are not the same version.
  "laf:computer_route_unknown": { status: 404, caller: "any" },
  // `/stream` asked for without a websocket upgrade. Only the server's proxy opens that door.
  "laf:stream_upgrade_required": { status: 400, caller: "person" },

  /* ── The request, and the browser ─────────────────────────────────────────────────────── */

  // A part of the request is missing or unusable; `field` rides beside it.
  "laf:request_invalid": { status: 400, caller: "bot" },
  // The browser did not do what it was asked, for a reason that is not a refusal.
  "laf:browser_failed": { status: 502, caller: "any" },
  // The address check could not be put on a browser, so the browser was not opened at all.
  "laf:navigation_guard_unavailable": { status: 502, caller: "any" },

  /* ── Opening a page ───────────────────────────────────────────────────────────────────── */

  // The page did not arrive by the deadline. The tab or the browser was replaced (`recycled`).
  "laf:page_timeout": { status: 504, caller: "bot" },
  // It could not be opened for a reason that is the site's or the network's: a name that does not
  // resolve, a connection refused. Not the deadline, and not the browser.
  "laf:navigation_failed": { status: 502, caller: "bot" },
  // A hop into the deployment's own network, stopped before it was sent. The answer to `/navigate`,
  // and a note on the next result when a click or a script took the page there.
  "laf:navigation_refused": { status: 403, caller: "bot", note: true },

  /* ── Acting on a page ─────────────────────────────────────────────────────────────────── */

  // A person holds the wheel. Nothing is broken; the Bot waits.
  "laf:human_has_control": { status: 409, caller: "bot" },
  // The ref is from an older snapshot, or names nothing on the page.
  "laf:stale_refs": { status: 409, caller: "bot" },
  // The control is still there and is not called what the server judged it as (label-hold.ts).
  "laf:label_changed": { status: 409, caller: "bot" },
  // The element would not take the action: hidden, covered, disabled, not a field. Also what the
  // masked box's own door answers when the box a person's value was for cannot take it.
  "laf:element_not_actionable": { status: 409, caller: "bot" },
  // The caller went away while the action ran: a person's Stop, or a routine's deadline.
  "laf:stopped": { status: 499, caller: "bot" },
  // A tab index that names no open tab.
  "laf:tab_missing": { status: 400, caller: "bot" },

  /* ── The workspace ────────────────────────────────────────────────────────────────────── */

  // A path the workspace never lets a Bot name: absolute, `..`, or out through a link.
  "laf:file_path_refused": { status: 403, caller: "bot" },
  // A path it may name, and what is there does not fit the request.
  "laf:file_not_found": { status: 400, caller: "bot" },
  "laf:file_wrong_kind": { status: 400, caller: "bot" },
  // More than the workspace takes in one write; `bytes` and `limit` ride beside it.
  "laf:file_too_large": { status: 400, caller: "bot" },
  // The disk did not do it.
  "laf:file_failed": { status: 500, caller: "bot" },

  /* ── A person's own doors ─────────────────────────────────────────────────────────────── */

  // A value arrived for a secret request that is no longer open.
  "laf:secret_not_pending": { status: 409, caller: "person" },
  // A person's input before they took the wheel — over HTTP, and down the live screen's socket.
  "laf:take_control_first": { status: 409, caller: "person", screen: true },
  // The live picture could not be started, or a press on it did not reach the page.
  "laf:screen_not_started": { screen: true },
  "laf:input_not_applied": { screen: true },

  /* ── What the browser noticed that nobody asked about ─────────────────────────────────── */

  "laf:dialog": { note: true },
  "laf:downloaded": { note: true },
  "laf:download_too_large": { note: true },
  "laf:download_failed": { note: true },
  "laf:secret_request_lost": { note: true },
  // An upgrade from a profile per Bot took over the most recently used one as the deployment's
  // shared browser; `adopted` and `kept` ride beside it. Once, to the Bot whose call started the
  // first browser after the upgrade (profiles.ts, `resolveProfile`).
  "laf:profile_adopted": { note: true },
  // A frame the page text could not include, on the `frames` of a read.
  "laf:frame_opaque": { note: true },
  // The tab's document is on its way and answers nothing until it arrives, so a look carries only what
  // the browser can say without it; `origin` and `loadingMs` ride beside it (page-arrival.ts).
  "laf:page_loading": { note: true },
} as const satisfies Record<`laf:${string}`, Answer | Told>;

export type ComputerCode = keyof typeof COMPUTER_CODES;

type CodesWhere<Shape> = {
  [Code in ComputerCode]: (typeof COMPUTER_CODES)[Code] extends Shape
    ? Code
    : never;
}[ComputerCode];

/** A code this process answers a failed call with, over HTTP. */
export type AnswerCode = CodesWhere<{ status: number }>;
/** A code that rides on a result that worked. */
export type NoteCode = CodesWhere<{ note: true }>;
/** A code sent down the live screen's socket. */
export type ScreenCode = CodesWhere<{ screen: true }>;

/** Whether a string is one of this process's answers — a thrown error's message, say. */
export function isAnswerCode(value: unknown): value is AnswerCode {
  return (
    typeof value === "string" &&
    Object.hasOwn(COMPUTER_CODES, value) &&
    "status" in COMPUTER_CODES[value as ComputerCode]
  );
}

/** The status a failure is answered with. One per code; see the top of this file. */
export function statusOf(code: AnswerCode): number {
  return COMPUTER_CODES[code].status;
}
