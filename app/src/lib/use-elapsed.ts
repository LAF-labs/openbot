import { useEffect, useState } from "react";

/**
 * Whole seconds since the component using this mounted, ticking once a second.
 *
 * `useNow` is the clock everywhere else, and it moves once a minute — the right grain for "3분 전"
 * and far too coarse for "생각 중 · 14초", which exists because 25 s of an unchanging word reads as
 * a Bot that died (ux-review-0.5.4 §2 item 9).
 *
 * The clock is read in the effect, never while rendering (the React Compiler leaves a component that
 * does uncompiled), and the count is the distance from the mount rather than a tally of ticks: a
 * hidden tab's timer is throttled to about one tick a minute (measured), and a tally would come back
 * from the background having counted one second for that minute.
 */
export function useElapsedSeconds(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  return seconds;
}
