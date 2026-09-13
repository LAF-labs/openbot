import type { QueryState } from "@tanstack/react-query";

/**
 * How often a poll asks, and how it backs away when the answer is a failure.
 *
 * MEASURED 2026-09-10 (audit A4, finding 4): one idle conversation on screen made 53 requests a
 * minute, and while the API was stopped every poll kept its rhythm — twelve 500s in twelve seconds
 * from one loop alone — so the moment the front door came back, every waiting request landed on it
 * at once. The product is a window left open all day on a shop owner's PC; a poll that never backs
 * off is a cost paid every minute of that day and a crowd at the door on every upgrade.
 *
 * The rule: wait as long as the query has already been failing, between its own interval and a
 * minute. Each wait is the sum of the waits before it, so they double — base, 2×, 4× — without a
 * counter anybody has to reset: the next success brings `status` back and the base interval with
 * it. `refetchOnWindowFocus` on the same query is what makes coming back to the window an instant
 * probe rather than a wait for the next tick.
 */

/** The longest a failing poll waits between attempts. */
export const OUTAGE_CAP_MS = 60_000;

/** The part of a query this reads. TanStack hands its whole `Query`; a test hands a state. */
type Polled = {
  state: Pick<
    QueryState,
    "status" | "dataUpdatedAt" | "errorUpdatedAt" | "errorUpdateCount"
  >;
};

export function pollEvery(baseMs: number): (query: Polled) => number {
  return (query) => {
    const { status, dataUpdatedAt, errorUpdatedAt, errorUpdateCount } =
      query.state;
    if (status !== "error") return baseMs;
    /*
     * A query that has never succeeded has no success to measure from, but every one of its
     * errors was consecutive, so the count is the exponent.
     */
    const failingFor =
      dataUpdatedAt > 0
        ? errorUpdatedAt - dataUpdatedAt
        : baseMs * 2 ** Math.max(0, errorUpdateCount - 1);
    return Math.min(OUTAGE_CAP_MS, Math.max(baseMs, failingFor));
  };
}

/**
 * The options every poll in this app shares, beside its interval.
 *
 * `retry: false` because the interval IS the retry: with the default single retry a second later,
 * an outage cost two requests per tick instead of one. `refetchIntervalInBackground: false` because
 * a hidden tab's timers are throttled to about one a minute anyway (memory note
 * `background-tab-throttling`), so what the interval bought there was a queue of requests fired
 * together on return. `refetchOnWindowFocus: true` is that return, done once, on purpose.
 */
export function polled(baseMs: number) {
  return {
    refetchInterval: pollEvery(baseMs),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  } as const;
}
