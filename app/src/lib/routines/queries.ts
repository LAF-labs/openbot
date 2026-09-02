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
  /** "HH:MM" in `dailyTimeZone`. Called `dailyUtc` until the column stopped claiming to be UTC. */
  dailyLocal: string | null;
  /** The IANA zone the daily time is written in. Null on rows that predate zones, meaning UTC. */
  dailyTimeZone: string | null;
  /** Weekdays it may run on, 0 = Sunday. Null or empty means every day. */
  dailyDays: number[] | null;
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
  /** The turns the run took; null on runs recorded before the server kept them. */
  steps: Array<{
    ms: number;
    text: number;
    calls: Array<{ name: string; ok: boolean }>;
  }> | null;
};

/**
 * One line for what a run did: "3 turns · 2 tools · 41s". Nothing for a run that has no record of
 * its turns, rather than a row of zeros that reads as a Bot that did nothing.
 */
export function runShape(
  steps: RoutineRun["steps"],
  t: (text: string) => string,
): string | null {
  if (!steps?.length) return null;
  const tools = steps.reduce((total, step) => total + step.calls.length, 0);
  const seconds = Math.round(
    steps.reduce((total, step) => total + step.ms, 0) / 1000,
  );
  const parts = [
    steps.length === 1 ? t("1 turn") : `${steps.length} ${t("turns")}`,
    tools === 1 ? t("1 tool") : `${tools} ${t("tools")}`,
    `${seconds}s`,
  ];
  return parts.join(" · ");
}

export const routineKeys = {
  all: ["routines"] as const,
  runs: (routineId: string) => ["routine-runs", routineId] as const,
};

/**
 * The refusals the routines API names, translated here because the code is a fact and this surface
 * owns the words — the same arrangement as MODEL_FAILURES in lib/copilot/stopped-turn.ts.
 *
 * The screen renders these straight into the create and delete forms, and what it rendered before
 * was the server's own English sentence: "This account holds 20 routines already. Delete one to
 * make room." on a Korean page. `app/tests/routines-copy.test.ts` walks this table, because `t()`
 * called on a variable is invisible to the i18n coverage test.
 */
export const ROUTINE_REFUSALS: Record<string, string> = {
  "laf:routine_cap_reached":
    "This account already holds as many routines as it can. Delete one to make room.",
  "laf:routine_not_found": "That routine is no longer there.",
  "laf:routine_incomplete": "Pick a Bot first.",
  /*
   * The three a Bot can provoke, because a Bot creates routines too now (`manage_routine`).
   *
   * They reach this screen as well: the same route answers both callers, and a refusal that had
   * words only for the Bot would fall through to the server's English sentence here — the exact
   * failure this table was written to end.
   */
  "laf:routine_needs_name": "Give the routine a name.",
  "laf:routine_needs_instruction": "Say what the routine should do each time.",
  "laf:routine_needs_schedule": "Say when it should run.",
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
    const known =
      typeof body?.code === "string" ? ROUTINE_REFUSALS[body.code] : undefined;
    // The code first, the server's sentence only where there is no code for what happened.
    // `statusText` is "Internal Server Error", which tells a person nothing they can act on.
    throw new Error(
      known
        ? t(known)
        : String(body?.error ?? t("That did not go through. Try again.")),
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

/** The weekday names this browser uses, indexed 0 = Sunday to match the stored values. */
export function weekdayNames(): string[] {
  const format = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  // 2026-08-23 is a Sunday, so seven steps from it name the week in order.
  return Array.from({ length: 7 }, (_, index) =>
    format.format(new Date(Date.UTC(2026, 7, 23 + index))),
  );
}

/**
 * How a routine's schedule reads to a person.
 *
 * It used to read "Daily at 22:30 UTC", which asks a shop owner in Seoul to do arithmetic to find
 * out that their routine runs at half past seven in the morning. The zone is named only when it is
 * not the one the reader is in — telling somebody the time is in their own zone is noise.
 */
export function scheduleLabel(routine: Routine): string {
  if (routine.scheduleKind !== "daily") {
    return t("Every {minutes} minutes", {
      minutes: String(routine.intervalMinutes ?? 60),
    });
  }

  const time = routine.dailyLocal ?? "";
  const zone = routine.dailyTimeZone ?? "UTC";
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const suffix = zone === here ? "" : ` ${zone}`;
  /*
   * ONE BAD ROW MUST NOT TAKE THE WHOLE ROUTINES SCREEN DOWN, AND ONE DID.
   *
   * Measured on a development database: a routine stored `daily_days` as `{}` rather than as an
   * array — an empty jsonb object, which `?? []` waves straight through because it is not null.
   * `{}.length` is undefined, so both early returns miss, and the spread below threw "days is not
   * iterable" out of a LABEL. The error boundary caught it at the page, so every routine somebody
   * had disappeared behind "문제가 생겼습니다" because one of them had a shape nobody expected.
   *
   * A label is the last place that should be able to fail. An unreadable day list reads as "every
   * day", which is what an empty one already means and is the honest degradation: the routine is
   * still listed, still switchable, still deletable.
   */
  const days = Array.isArray(routine.dailyDays) ? routine.dailyDays : [];

  if (days.length === 0 || days.length === 7) {
    return `${t("Daily at {time}", { time })}${suffix}`;
  }
  const names = weekdayNames();
  const isWeekdays =
    days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day));
  if (isWeekdays) {
    return `${t("Weekdays at {time}", { time })}${suffix}`;
  }
  return `${[...days]
    .sort((a, b) => a - b)
    .map((day) => names[day])
    .join(", ")} ${time}${suffix}`;
}
