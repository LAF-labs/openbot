import { screenProblemText } from "@/lib/computer/screen-problems";
import { t } from "@/lib/i18n";
import { UNAVAILABLE_REFUSALS, type Unavailability } from "@/lib/reading";

/**
 * WHAT THE BOT'S SCREEN CARD SHOWS, DECIDED FROM ITS THREE FACTS RATHER THAN INSIDE ITS JSX.
 *
 * The card holds a frame (or none), whether that frame is a blank browser, and the fact code of the
 * last thing that went wrong (or none). What it drew from them was decided in the markup, and two
 * cases fell through it:
 *
 * A FROZEN PICTURE LOOKED LIVE. A poll that failed after a frame had arrived set the problem and
 * kept the old frame — and the problem was only ever drawn when there was no frame, so the card went
 * on showing the last picture as though it were the screen now, with nothing to say it had stopped.
 * It says so now, under the picture, until the next frame lands.
 *
 * A SCREEN THIS PLACE DOES NOT HAVE WAS A FAULT. A deployment with no computer answers the route
 * with `laf:not_found`, and an account that may not see this Bot with `laf:bot_not_found`; both got
 * "the Bot may still be working — an administrator can check whether its computer is running",
 * which sends somebody to check on a computer that does not exist or is not theirs.
 *
 * A CLOSED PAGE WAS CALLED A BROWSER THAT HAD NEVER BEEN USED. Fourth fact, and the reason it has
 * to be one. MEASURED 2026-09-21 against the shipping `agent-computer` image: with the Bot's tabs
 * closed, `GET /api/computers/:bot/screenshot` answers **200** with a white PNG and
 * `url: "about:blank"` — byte for byte the same 6,288-character frame a browser that has never been
 * sent anywhere returns, same sha256, same `url`. The container opens a fresh blank tab on the very
 * request that asks (`profiles.page`), so looking is what turns "closed" into "blank". Nothing 404s
 * and no socket drops, so there is no fact in the ANSWER that tells the two apart.
 *
 * The fact that does is the pane's own: it watched a real page here a moment ago. `sawPage` carries
 * it, and the difference matters to a person — "봇이 보고 있던 페이지를 닫았습니다" is the Bot having
 * finished with something, "아직 페이지를 열지 않았습니다" is a Bot that has not started, and a
 * connection that dropped is `problem`. Three states, three sentences, one blank white rectangle.
 *
 * The sentences for each code stay in `screen-problems.ts`, the one table the pane reads them from.
 */

/** Refusals that mean this screen cannot be had here, by this account — nothing to wait for. */
const SCREEN_UNAVAILABLE_REFUSALS: Readonly<Record<string, Unavailability>> = {
  ...UNAVAILABLE_REFUSALS,
  // `requireBotAccess`: one word for "not yours" and "not here", deliberately (`auth/guards.ts`).
  "laf:bot_not_found": "not_allowed",
};

/**
 * Problems about the wheel rather than the computer: somebody else is driving, or a key did not
 * land. The picture is not stale because of them, and no administrator can help with them.
 */
const ABOUT_THE_WHEEL = new Set([
  "laf:human_has_control",
  "laf:take_control_first",
  "laf:input_not_applied",
]);

export type ScreenView =
  /** Nothing yet and nothing wrong: the one state that is genuinely loading. */
  | { kind: "waiting"; label: string }
  /** A page on screen — with a line under it when it has stopped updating. */
  | { kind: "showing"; stale: string | null }
  /** The browser is open on nothing, and never was on anything. */
  | { kind: "blank"; sentence: string }
  /** The browser is open on nothing, and a page this pane was watching has gone. */
  | { kind: "closed"; sentence: string; advice: string }
  | { kind: "unavailable"; sentence: string }
  | {
      kind: "problem";
      heading: string;
      sentence: string;
      advice: string | null;
    };

export function screenView({
  hasFrame,
  isBlank,
  problem,
  sawPage = false,
}: {
  hasFrame: boolean;
  isBlank: boolean;
  problem: string | null;
  /**
   * Whether this pane has already watched a real page on this computer.
   *
   * The server cannot answer this — see the header. It is deliberately not remembered across a
   * reload either: a pane that reopens on a blank browser genuinely does not know whether the Bot
   * closed something an hour ago, and "봇이 페이지를 닫았습니다" about a Bot that has been idle since
   * yesterday would be the same lie in the other direction.
   */
  sawPage?: boolean;
}): ScreenView {
  const unavailable = problem
    ? SCREEN_UNAVAILABLE_REFUSALS[problem]
    : undefined;
  if (unavailable) {
    return {
      kind: "unavailable",
      sentence:
        unavailable === "not_allowed"
          ? t("This account cannot see this Bot's screen.")
          : t(
              "This place has no computer for its Bots, so there is no screen to show.",
            ),
    };
  }
  if (hasFrame && !isBlank) {
    return {
      kind: "showing",
      stale:
        problem && !ABOUT_THE_WHEEL.has(problem)
          ? `${t("The picture is not updating. This is the last one that arrived.")} ${screenProblemText(problem)}`
          : null,
    };
  }
  if (problem) {
    return {
      kind: "problem",
      heading: t("You cannot see the screen right now"),
      sentence: screenProblemText(problem),
      advice: ABOUT_THE_WHEEL.has(problem)
        ? null
        : t(
            "The Bot may still be working. An administrator can check whether its computer is running.",
          ),
    };
  }
  if (hasFrame && sawPage) {
    return {
      kind: "closed",
      sentence: t("The Bot closed the page it was looking at."),
      // Said because a white rectangle where a page was reads as a fault, and it is not one: the
      // Bot finishing with a tab is the ordinary end of a piece of work.
      advice: t("Nothing has gone wrong. It opens another when it needs one."),
    };
  }
  if (hasFrame) {
    return { kind: "blank", sentence: t("The Bot has not opened a page yet.") };
  }
  return { kind: "waiting", label: t("Waiting for the Bot's screen…") };
}

/** The host of the page on screen, or null when there is not one to name. */
function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    // A URL the browser reports and this parser cannot read is still a page; it just has no name.
    return null;
  }
}

/**
 * THE WHOLE CARD IN ONE LINE — what the folded panel keeps.
 *
 * A screen that can be folded away has to leave something behind, or folding it is the same gesture
 * as closing it. This is that line, and it is the card's own state said in one sentence rather than
 * a second opinion about it: every branch below is a `ScreenView` this file already decided.
 *
 * `showing` is the only kind with nothing to say for itself — the picture was the sentence — so it
 * is the one that reads the address. A page whose host cannot be parsed is still a page.
 */
export function screenLine(view: ScreenView, url: string | null): string {
  if (view.kind === "waiting") return view.label;
  if (view.kind !== "showing") return view.sentence;
  if (view.stale) return view.stale;
  const host = hostOf(url);
  return host
    ? t("The Bot is on {site}.", { site: host })
    : t("The Bot is looking at a page.");
}
