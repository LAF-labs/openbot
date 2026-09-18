import { useMemo, useSyncExternalStore } from "react";

/**
 * The time, to the minute, as something React can watch change.
 *
 * A label computed from `new Date()` while rendering — "14:32" against "어제", "내일 오전 9:00", a
 * greeting that knows it is evening — is only as current as the render that drew it. Under the React
 * Compiler it is not even that: the compiler assumes rendering is pure, so it keeps such a label
 * until one of its other inputs changes. Read off the compiled output when the compiler was turned
 * on: the audit trail's 오늘 and 어제, and Home's greeting, sat in blocks with no inputs at all —
 * computed once per visit, the one thing the audit page's own comment says must not happen — and
 * the roster's times and the routine list's 오늘/내일 were recomputed only when their row's data
 * changed, so none of them would turn over at midnight. Reading the clock through this makes the
 * minute an input like any other.
 *
 * ONE TICKER FOR THE WHOLE PAGE, and only while something is watching. It looks four times a minute
 * and wakes a component only when the minute has actually turned; it looks again when the window
 * comes back, because a laptop that slept through midnight has no tick to say so.
 */

const MINUTE_MS = 60_000;
/** How often the ticker looks. A new minute is noticed at most this late. */
const LOOK_EVERY_MS = 15_000;

const watchers = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | undefined;

const tell = () => {
  for (const watcher of watchers) watcher();
};

function watch(onChange: () => void): () => void {
  watchers.add(onChange);
  if (watchers.size === 1) {
    ticker = setInterval(tell, LOOK_EVERY_MS);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", tell);
    }
  }
  return () => {
    watchers.delete(onChange);
    if (watchers.size > 0) return;
    clearInterval(ticker);
    ticker = undefined;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", tell);
    }
  };
}

/** Minutes since the epoch: one number for a whole minute, so React sees nothing change until it does. */
const currentMinute = () => Math.floor(Date.now() / MINUTE_MS);

/** The start of the current minute, the same Date object until the next one. */
export function useNow(): Date {
  const minute = useSyncExternalStore(watch, currentMinute, currentMinute);
  return useMemo(() => new Date(minute * MINUTE_MS), [minute]);
}
