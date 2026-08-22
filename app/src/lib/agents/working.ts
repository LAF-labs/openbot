import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";

/**
 * Which of this person's Bots are working right now.
 *
 * Polled rather than pushed, and that is the honest shape for what it reports. The socket only
 * carries what a browser told the server it saw — it is fed by the client that ran the turn — so
 * the one case this feature exists for, a routine firing at six in the morning with nobody at a
 * keyboard, would never reach it. A short poll of one indexed row set answers for every run path
 * the same way.
 */
export type WorkingRun = {
  agentId: string;
  /** `chat` | `routine` | `handoff` | `wake`. */
  origin: string;
  /** What it is doing, when somebody wrote it down — a routine's name. */
  label: string | null;
  startedAt: string;
};

export const workingKeys = {
  all: ["agents", "working"] as const,
};

export function workingQueryOptions() {
  return queryOptions({
    queryKey: workingKeys.all,
    queryFn: async (): Promise<WorkingRun[]> => {
      const response = await fetch("/api/agents/working", {
        credentials: "include",
      });
      // A roster that cannot reach the ledger should look calm, not broken.
      if (!response.ok) return [];
      return ((await response.json()) as { working: WorkingRun[] }).working;
    },
    /*
     * Four seconds. A turn takes tens of seconds, so this is comfortably inside one; going faster
     * buys nothing a person can perceive and costs a query per Bot per tick.
     */
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
    staleTime: 2000,
  });
}

/**
 * What to say a Bot is doing.
 *
 * A routine carries its own name, which is always better than anything this could invent — it is
 * the sentence the person wrote when they asked for the work. Everything else falls back to what
 * kind of run it is, because "working" alone tells you nothing you did not already see.
 */
export function workingLabel(run: WorkingRun): string {
  if (run.label) return run.label;
  if (run.origin === "routine") return t("Running a routine");
  if (run.origin === "handoff") return t("Helping another Bot");
  if (run.origin === "wake") return t("Following something up");
  if (run.origin === "room") return t("In a room");
  return t("Working…");
}
