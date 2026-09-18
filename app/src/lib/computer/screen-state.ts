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
  /** The browser is open on nothing. */
  | { kind: "blank"; sentence: string }
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
}: {
  hasFrame: boolean;
  isBlank: boolean;
  problem: string | null;
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
  if (hasFrame) {
    return { kind: "blank", sentence: t("The Bot has not opened a page yet.") };
  }
  return { kind: "waiting", label: t("Waiting for the Bot's screen…") };
}
