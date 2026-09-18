import { t } from "@/lib/i18n";
import { type ReadLine, unavailableText } from "@/lib/read-line";
import type { Reading } from "@/lib/reading";

/**
 * WHAT THE ROSTER SAYS BESIDES ITS ROWS — DECIDED FROM TWO READS AND A SEARCH.
 *
 * The roster is two lists drawn as one: the Bots (`/api/agents`) and the rooms with several of them
 * (`/api/channels`). Before this, its only line was the empty one, and it was drawn whenever the
 * Bots list was not pending and had no rows — so a roster whose read FAILED said 아직 봇이 없습니다
 * (measured 2026-09-18, `/api/agents` answering 500): somebody with five Bots told they had none,
 * in the one column that is on screen all day.
 *
 * Two answers, because they are drawn two ways. `line` is what the reads came to — a failure, a
 * refresh that failed over rows, a roster this place does not offer — for the roster's `ReadNotice`,
 * which is mounted before it speaks. `list` is what the list says when it has no rows once the reads
 * are in. A pure function over the facts, so every combination can be pinned without drawing the
 * sidebar (`roster-state.test.ts`); the sidebar decides how much of it a 64px rail has room to say.
 */
export type RosterNotice = {
  line: ReadLine;
  list: "empty" | "all-hidden" | "no-match" | null;
};

const QUIET: RosterNotice = { line: null, list: null };

export function rosterNotice({
  bots,
  rooms,
  isSearching,
  shownCount,
  hasHidden,
}: {
  bots: Reading<unknown>;
  rooms: Reading<unknown>;
  /** Whether a search is typed: a roster filtered to nothing is not an empty roster. */
  isSearching: boolean;
  /** Rows and rooms left on screen after the search. */
  shownCount: number;
  /** Whether any Bot is hidden — "none yet" is false for somebody who hid theirs. */
  hasHidden: boolean;
}): RosterNotice {
  if (bots.state === "unavailable") {
    return {
      line: {
        kind: "unavailable",
        message: unavailableText(bots.why, t("Bots are not offered here.")),
      },
      list: null,
    };
  }
  if (bots.state === "failed" && !bots.previous) {
    return {
      line: {
        kind: "failed",
        message: t("Your Bots could not be loaded."),
        isRetrying: false,
      },
      list: null,
    };
  }
  // The skeleton says it: nothing about the list is known yet.
  if (bots.state === "loading") return QUIET;
  // The rooms are a second list; failing to read them is said, and the Bots stay drawn with it.
  if (rooms.state === "failed" && !rooms.previous) {
    return {
      line: {
        kind: "failed",
        message: t("Your conversations could not be loaded."),
        isRetrying: false,
      },
      list: null,
    };
  }
  if (bots.state === "failed" || rooms.state === "failed") {
    return {
      line: {
        kind: "stale",
        isRetrying:
          (bots.state === "failed" && bots.isRetrying) ||
          (rooms.state === "failed" && rooms.isRetrying),
      },
      list: null,
    };
  }
  if (shownCount > 0) return QUIET;
  if (isSearching) return { line: null, list: "no-match" };
  // "None" waits for the rooms as well: a person with no Bot on the list may still be in a room.
  if (rooms.state === "loading") return QUIET;
  return { line: null, list: hasHidden ? "all-hidden" : "empty" };
}
