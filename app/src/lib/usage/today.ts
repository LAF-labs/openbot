import type { QueryClient } from "@tanstack/react-query";
import {
  authKeys,
  type CurrentUserResult,
  type Trial,
} from "@/lib/auth/queries";

/**
 * How much of a free trial's day is used, for the two places that say so before a question is
 * refused: the 오늘 사용량 row in Settings and the notice above the composer.
 *
 * The count is the server's (`GET /api/me` → `deployment.trial.tokensUsedToday`), made by the same
 * judge that refuses a run once the day is spent — nothing here counts anything. What this adds is
 * the arithmetic of drawing it, and the day it is drawn for: SEOUL'S, because that is the day the
 * server counts and the fleet ends a trial on, whatever clock this machine keeps.
 */

/** From here the notice above the composer is shown. */
export const USAGE_NOTICE_AT = 0.8;

/** Where this viewer's dismissal of the notice is kept: the Seoul day it was dismissed on. */
export const NOTICE_DISMISSED_KEY = "laf.usage-notice.dismissed";

const USAGE_TIME_ZONE = "Asia/Seoul";

export type TodayUsage = {
  used: number;
  budget: number;
  /** Used over budget; above 1 on a day that ran over (a run is judged when it starts). */
  ratio: number;
  /** Whole percent, rounded down so it never says more was used than was, and at most 100. */
  percent: number;
};

/** Today's use, or nothing to draw — no trial, a count the server could not read, or no budget. */
export function usageOf(trial: Trial | undefined): TodayUsage | null {
  if (!trial || trial.tokensUsedToday === undefined) return null;
  const budget = trial.dailyTokenBudget;
  if (!(budget > 0)) return null;
  const used = trial.tokensUsedToday;
  const ratio = used / budget;
  return {
    used,
    budget,
    ratio,
    percent: Math.min(100, Math.floor(ratio * 100)),
  };
}

const seoulDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: USAGE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Seoul calendar day an instant falls on, as `YYYY-MM-DD`. */
export function seoulDayKey(at: Date): string {
  return seoulDate.format(at);
}

/** Whether the notice is shown: at 80% or more, unless it was dismissed on this same Seoul day. */
export function noticeDue(
  usage: TodayUsage | null,
  dismissedDay: string | null,
  now: Date,
): boolean {
  if (!usage || usage.ratio < USAGE_NOTICE_AT) return false;
  return dismissedDay !== seoulDayKey(now);
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Seoul day this viewer dismissed the notice on, if any.
 *
 * Per viewer and per browser on purpose: it only saves somebody being told the same thing twice in
 * one day. Storage that throws — a private window, blocked site data — reads as never dismissed,
 * which costs one line of text coming back, never a broken screen.
 */
export function readDismissedDay(): string | null {
  try {
    const day = globalThis.localStorage?.getItem(NOTICE_DISMISSED_KEY) ?? null;
    return day && DAY_PATTERN.test(day) ? day : null;
  } catch {
    return null;
  }
}

export function writeDismissedDay(day: string): void {
  try {
    globalThis.localStorage?.setItem(NOTICE_DISMISSED_KEY, day);
  } catch {
    // Nowhere to keep it; the notice comes back on the next screen, which is harmless.
  }
}

/**
 * How long after a turn ends before `/api/me` is asked again.
 *
 * A turn's cost is written to the trail as the Bot's stream reports it, and that write is not
 * awaited by the stream (`server/src/copilot.ts`) — so the finished run reaches this window at about
 * the same moment the row lands. Asked at once, the count could still be the one from before the
 * turn, and the meter would lag by exactly the turn it was refreshed for.
 */
const AFTER_TURN_MS = 1_500;

/**
 * After a turn: ask `/api/me` again, on a trial only.
 *
 * No poll of its own — the page refreshes `/api/me` as it always has — and nothing at all on a
 * deployment that is not a trial, where there is no meter to move and the request would be for
 * nothing.
 */
export function refreshTodayUsage(queryClient: QueryClient): void {
  const current = queryClient.getQueryData<CurrentUserResult>(
    authKeys.currentUser(),
  );
  if (!current || typeof current !== "object" || !current.deployment.trial) {
    return;
  }
  setTimeout(() => {
    void queryClient.invalidateQueries({ queryKey: authKeys.currentUser() });
  }, AFTER_TURN_MS);
}
