import { t } from "@/lib/i18n";
import { failureSentence } from "@/lib/press";

/**
 * WHY A SAVE DID NOT GO THROUGH, as one sentence — for the routine and skill screens.
 *
 * They printed `error.message`, which is a Korean refusal when the server named one and the
 * browser's own English when nothing answered ("Failed to fetch", "Load failed"), and a sentence
 * with no reason when the refusal was one this screen had no words for (UI/UX audit 0.5.3, item 15).
 * `failureSentence` already tells the first two apart; this adds the one case a person can act on
 * that it cannot see — their own connection is down — because "the server could not be reached"
 * sends them looking at the wrong end.
 */
export function savingFailure(error: unknown): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return t("The internet connection is down, so this was not saved.");
  }
  return failureSentence(error);
}
