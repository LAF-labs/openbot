import { t } from "@/lib/i18n";
import type { Reading, Unavailability } from "@/lib/reading";

/**
 * WHAT A READ SAYS BESIDES ITS DATA, AS WORDS — THE ONE LINE `ReadNotice` DRAWS.
 *
 * Kept apart from `lib/reading.ts`, which holds no words, and from the component, so a pure function
 * that decides a screen's state (`lib/routines/list-state.ts`) can hand back its line without
 * reaching into `components/`.
 */

/** What a read says besides its data, or null while it has nothing to say. */
export type ReadLine =
  | { kind: "failed"; message: string; isRetrying: boolean }
  | { kind: "stale"; isRetrying: boolean }
  | { kind: "unavailable"; message: string }
  | null;

/**
 * The sentence for a read this place or this account cannot have.
 *
 * An account refused is the same fact on every screen, so it is one sentence; a place without the
 * thing is about the thing, so the screen says which (`notHere`).
 */
export function unavailableText(why: Unavailability, notHere: string): string {
  return why === "not_allowed"
    ? t("This account cannot see this here.")
    : notHere;
}

/** A reading's line, in the screen's own words. */
export function readLineOf<T>(
  reading: Reading<T>,
  words: {
    /** What could not be loaded, already through `t()`. */
    failed: string;
    /** What this place does not offer, already through `t()`. */
    notHere: string;
  },
): ReadLine {
  if (reading.state === "unavailable") {
    return {
      kind: "unavailable",
      message: unavailableText(reading.why, words.notHere),
    };
  }
  if (reading.state !== "failed") return null;
  return reading.previous
    ? { kind: "stale", isRetrying: reading.isRetrying }
    : { kind: "failed", message: words.failed, isRetrying: reading.isRetrying };
}
