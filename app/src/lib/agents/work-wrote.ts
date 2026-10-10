import type { QueryClient } from "@tanstack/react-query";
import { feedKeys } from "@/lib/feed/queries";
import { goalKeys } from "@/lib/goals/queries";
import { madeKeys } from "@/lib/made/queries";

/**
 * WHAT A BOT'S WORK MAY HAVE WRITTEN, ASKED FOR AGAIN: 소식's posts and count (a feed run's posts
 * land when it ends), 목표 (a goal is saved, and progress logged, by a turn or a check-in run) and
 * 만든 것 (a table or a file is the newest thing it made).
 *
 * These are on every screen now — the menu's counts, and 홈's cards (`layout/home-cards.tsx`) —
 * where their pages were read only when somebody opened them. So the two moments the app already
 * notices work ending both come here: a run leaving the working poll's list
 * (`layout/profile-menu.tsx`), which is the only sign a silent routine gives, and a Bot's answer
 * landing in a conversation (`lib/channels/use-channel-events.ts`).
 *
 * BOTH, BECAUSE THE POLL ALONE MISSES A SHORT TURN. MEASURED 2026-10-10: a table asked for in the
 * conversation was made in three seconds, the poll never saw the run, and 홈's 만든 것 card went on
 * naming the table before it until the window was brought forward again.
 */
export function refreshWhatWorkWrote(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: feedKeys.all });
  void queryClient.invalidateQueries({ queryKey: goalKeys.all });
  void queryClient.invalidateQueries({ queryKey: madeKeys.all });
}
