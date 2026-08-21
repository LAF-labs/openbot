import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";

/** A standing instruction a Bot runs on a clock. */
export type Routine = {
  id: string;
  agentId: string;
  name: string;
  instruction: string;
  scheduleKind: "interval" | "daily";
  intervalMinutes: number | null;
  dailyUtc: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
};

export type RoutineRun = {
  id: string;
  startedAt: string;
  ok: boolean | null;
  answer: string | null;
  error: string | null;
};

export const routineKeys = {
  all: ["routines"] as const,
  runs: (routineId: string) => ["routine-runs", routineId] as const,
};

export async function routineRequest(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : {},
    ...init,
  });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    // The server's sentence when there is one. `statusText` is "Internal Server Error", which
    // tells a person nothing they can act on.
    throw new Error(
      String(body?.error ?? t("That did not go through. Try again.")),
    );
  }
  return body;
}

/**
 * Every routine this person owns.
 *
 * One list rather than a per-Bot endpoint: a roster is a handful of Bots with a few routines each,
 * so the whole set is smaller than the round trip, and both readers — the Routines page and the
 * panel beside a conversation — then share one cache entry and one invalidation.
 */
export function routineListQueryOptions() {
  return queryOptions({
    queryKey: routineKeys.all,
    queryFn: async () =>
      (await routineRequest("/api/routines"))?.routines as Routine[],
  });
}

/** How a routine's schedule reads to a person. */
export function scheduleLabel(routine: Routine): string {
  return routine.scheduleKind === "daily"
    ? t("Daily at {time} UTC", { time: routine.dailyUtc ?? "" })
    : t("Every {minutes} minutes", {
        minutes: String(routine.intervalMinutes ?? 60),
      });
}
