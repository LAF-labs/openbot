import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useControl } from "@/components/computer/use-control";
import { type Presence, presenceOf, useTurnPhase } from "@/lib/agents/presence";
import { workingQueryOptions } from "@/lib/agents/working";
import { openQuestions, watchQuestions } from "@/lib/approvals";
import { isInUse, useBrowsingNow } from "@/lib/computer/browsing-now";

/**
 * The facts `presenceOf` decides from, gathered where they already live. See `lib/agents/presence.ts`
 * for why each one and in what order.
 *
 * The control state is read with `isLive: false`: a few reads when the header mounts, then only
 * what the help card's own live watch hears — the card is mounted exactly while the Bot is waiting,
 * so the header learns of a request when the card does, without a second poll of its own.
 */
export function usePresence(botId: string | undefined): Presence {
  const turn = useTurnPhase(botId);
  const isBrowsing = isInUse(useBrowsingNow(), botId);
  const approvals = useSyncExternalStore(
    watchQuestions,
    () => countOpenFor(botId),
    () => 0,
  );
  const control = useControl(botId, false);
  const working = useQuery(workingQueryOptions());
  const isRoutineRunning =
    working.data?.some(
      (run) => run.agentId === botId && run.origin === "routine",
    ) ?? false;
  return presenceOf({
    turn,
    isBrowsing,
    approvals,
    isHelpWanted:
      control !== null &&
      (control.requested || control.secretWanted !== undefined),
    isRoutineRunning,
  });
}

function countOpenFor(botId: string | undefined): number {
  if (!botId) return 0;
  return openQuestions().filter((question) => question.botId === botId).length;
}
