import type { Reading, Unavailability } from "@/lib/reading";

/**
 * WHAT THE ROSTER SAYS UNDER ITS ROWS — ONE LINE, DECIDED FROM TWO READS AND A SEARCH.
 *
 * The roster is two lists drawn as one: the Bots (`/api/agents`) and the rooms with several of them
 * (`/api/channels`). Before this, its only line was the empty one, and it was drawn whenever the
 * Bots list was not pending and had no rows — so a roster whose read FAILED said 아직 봇이 없습니다
 * (measured 2026-09-18, `/api/agents` answering 500): somebody with five Bots told they had none,
 * in the one column that is on screen all day.
 *
 * A pure function over the facts, so every combination can be pinned without drawing the sidebar
 * (`roster-state.test.ts`). The sidebar decides how much of it a 64px rail has room to say.
 */
export type RosterNotice =
  | { kind: "unavailable"; why: Unavailability }
  | { kind: "failed"; what: "bots" | "rooms" }
  | { kind: "stale"; isRetrying: boolean }
  | { kind: "empty"; hasHidden: boolean }
  | { kind: "no-match" }
  | null;

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
  if (bots.state === "unavailable")
    return { kind: "unavailable", why: bots.why };
  if (bots.state === "failed" && !bots.previous) {
    return { kind: "failed", what: "bots" };
  }
  // The skeleton says it: nothing about the list is known yet.
  if (bots.state === "loading") return null;
  // The rooms are a second list; failing to read them is said, and the Bots stay drawn above.
  if (rooms.state === "failed" && !rooms.previous) {
    return { kind: "failed", what: "rooms" };
  }
  if (bots.state === "failed" || rooms.state === "failed") {
    return {
      kind: "stale",
      isRetrying:
        (bots.state === "failed" && bots.isRetrying) ||
        (rooms.state === "failed" && rooms.isRetrying),
    };
  }
  if (shownCount > 0) return null;
  if (isSearching) return { kind: "no-match" };
  // "None" waits for the rooms as well: a person with no Bot on the list may still be in a room.
  if (rooms.state === "loading") return null;
  return { kind: "empty", hasHidden };
}
