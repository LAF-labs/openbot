import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { workingQueryOptions } from "@/lib/agents/working";
import { channelKeys } from "@/lib/channels/queries";
import { feedKeys } from "@/lib/feed/queries";
import { goalKeys } from "@/lib/goals/queries";
import { madeKeys } from "@/lib/made/queries";

/**
 * A RUN ENDING IS THE MOMENT A ROUTINE'S ANSWER LANDS IN THE CONVERSATION, and nothing pushes that
 * to the window — the socket carries only what a window reported. The working poll already notices
 * the run end; this turns that into a refresh of the conversations, so the delivered answer and its
 * unread mark appear within a poll interval.
 *
 * IT LIVED IN THE SIDEBAR, which was mounted on every screen and on a phone too, only hidden there,
 * for exactly this watch. The sidebar went on 2026-10-09 (`docs/laf/redesign-2026-10.md` §1) and
 * the watch did not: whatever is mounted on every screen calls this, once.
 */
export function useRunEndRefresh() {
  const queryClient = useQueryClient();
  const working = useQuery(workingQueryOptions());
  const workingIds = (working.data ?? []).map((run) => run.agentId).join(",");
  const previousWorkingIds = useRef(workingIds);

  useEffect(() => {
    const before = new Set(
      previousWorkingIds.current.split(",").filter(Boolean),
    );
    const after = new Set(workingIds.split(",").filter(Boolean));
    previousWorkingIds.current = workingIds;
    if ([...before].some((id) => !after.has(id))) {
      void queryClient.invalidateQueries({ queryKey: channelKeys.list() });
      // And 소식's count: a feed run's posts land when it ends, and nothing else says so.
      void queryClient.invalidateQueries({ queryKey: feedKeys.all });
      // And 목표's: a goal is saved, and progress logged, by a turn or a check-in run.
      void queryClient.invalidateQueries({ queryKey: goalKeys.all });
      // And what the Bot made: the home panel lists the newest on every screen, and a thing made
      // in a turn is there when the turn ends.
      void queryClient.invalidateQueries({ queryKey: madeKeys.all });
    }
  }, [workingIds, queryClient]);
}
