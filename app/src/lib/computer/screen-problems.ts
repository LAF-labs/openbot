import { t } from "@/lib/i18n";

/**
 * Why the Bot's screen cannot be shown, in the person's words.
 *
 * MEASURED 2026-09-06: the pane rendered English sentences that two other services had written.
 * The screenshot poll printed the server's `describe(error)` — "The assistant's computer did not
 * respond in time.", or a Playwright call log — and the live socket printed whatever the computer
 * container put in `error`, a process that has never heard of a locale. Both were shown under a
 * Korean heading, to a Korean reader.
 *
 * So neither service's prose crosses any more. The server and the container send a fact code, the
 * pane keeps the CODE as its state (a test can assert on it), and the one place a sentence is made
 * is here. English keys because that is how `t()` works; a table rather than literals because the
 * value arrives at runtime, which is why `app/tests/screen-problems.test.ts` walks it — the coverage
 * test cannot see a `t(variable)`.
 */
export const SCREEN_PROBLEM_SAID: Record<string, string> = {
  // The screenshot route, `server/src/computer/routes.ts` `codeFor`.
  "laf:bot_id_invalid": "This Bot's screen could not be found.",
  "laf:page_timeout": "The page is taking too long to open.",
  "laf:human_has_control": "Somebody is using this browser right now.",
  // The server's client's own facts: nothing answered, an answer too late, an answer with no code.
  "laf:computer_failed": "Something went wrong on the Bot's computer.",
  "laf:computer_unreachable": "The Bot's computer could not be reached.",
  "laf:computer_timed_out": "The Bot's computer did not answer in time.",
  /*
   * THE CONTAINER'S, WHATEVER WAS ASKED (`caller: "any"` in `agent-computer/src/codes.ts`): its door
   * and its browser, which the screenshot poll and the Computers page meet as surely as a Bot's tool
   * does. They reach here by their own names since 2026-09-14; before, the server said most of them
   * as `laf:computer_unavailable`, and `computer-codes.test.ts` now holds this table to the list.
   */
  "laf:navigation_guard_unavailable":
    "The Bot's browser did not start, because its address check could not be set up.",
  "laf:browser_failed": "The Bot's browser did not respond.",
  "laf:computer_token_refused":
    "The Bot's computer did not accept this server's connection.",
  "laf:bot_header_missing":
    "The Bot's computer was not told which Bot's screen this is.",
  "laf:computer_route_unknown":
    "The Bot's computer and this server are different versions.",
  // The live-screen socket, `agent-computer`'s `{type:"error"}` messages.
  "laf:screen_not_started": "The live picture could not be started.",
  "laf:take_control_first":
    "Take control before clicking or typing on the page.",
  "laf:input_not_applied": "That click or keystroke did not reach the page.",
  // The pane's own three: an answer that carried no code at all, and a picture that never came.
  "laf:screen_unavailable": "The screen could not be shown.",
  "laf:screen_unreachable": "The live screen could not be reached.",
  "laf:screen_stalled": "The picture has not come through for five seconds.",
};

/** The route answered, or the socket sent an error, without saying which. */
export const SCREEN_UNAVAILABLE = "laf:screen_unavailable";
/** The socket itself failed: nothing was said because nothing connected. */
export const SCREEN_UNREACHABLE = "laf:screen_unreachable";
/**
 * Nothing failed and nothing arrived: no frame within `SCREEN_STALL_MS` of asking for one.
 *
 * The one the 0.5.3 audit found (item 14): a socket that opened, or never finished opening, and
 * then sent no picture left "화면에 연결하는 중…" up for twenty seconds and more, with no reason
 * and nothing to press. Measured 2026-09-24 in two of three opens against a computer image from
 * before `d1ad9e74`, where the socket on its way out stopped the newer socket's cast.
 */
export const SCREEN_STALLED = "laf:screen_stalled";

/**
 * The sentence for a code.
 *
 * A code this table does not know gets the generic line, never the identifier: the container may
 * grow a fact before this table learns its words, and `laf:screen_not_started` in the middle of a
 * card is not a thing a shop owner can act on. Unlike `refusalSaid`, nothing passes through — every
 * caller hands this a code it chose itself, so a sentence arriving here IS the regression.
 */
export function screenProblemText(code: string | null | undefined): string {
  const said = code ? SCREEN_PROBLEM_SAID[code] : undefined;
  return said ? t(said) : t("The screen is not available right now.");
}
