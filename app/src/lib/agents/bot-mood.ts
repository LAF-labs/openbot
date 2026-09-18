import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BotAvatarState } from "@/components/avatar/bot-avatar";

/**
 * What a Bot's face should be doing on the roster, from what the roster knows.
 *
 * Four signals, in the order they win: a question the Bot has stopped to ask beats everything (the
 * person is the one thing it is waiting on); work beats rest; a Bot whose turn just ended is glad
 * for a moment; and a Bot nobody has spoken to in half an hour has dozed off. The rest are awake —
 * a Bot that was just made has no history, and a fresh face asleep on its first screen reads as a
 * product that is off.
 */

/** Half an hour of silence, and the face closes its eyes. */
export const ASLEEP_AFTER_MS = 30 * 60 * 1000;
/** How long the face stays glad after its work ends. */
export const DONE_FOR_MS = 2000;

export function moodFor(input: {
  working: boolean;
  blocked: boolean;
  lastMessageAt: string | undefined;
  /** When the Bot's work last ended, if it did; drives the moment of gladness. */
  workedUntil: number | null;
  now: number;
}): BotAvatarState {
  if (input.blocked) return "blocked";
  if (input.working) return "working";
  if (input.workedUntil !== null && input.now - input.workedUntil < DONE_FOR_MS)
    return "done";
  if (input.lastMessageAt) {
    const at = Date.parse(input.lastMessageAt);
    if (Number.isFinite(at) && input.now - at > ASLEEP_AFTER_MS)
      return "asleep";
  }
  return "idle";
}

/**
 * The mood as a hook: it re-evaluates when the signals change, once a minute so a quiet Bot can
 * doze off without anybody touching the roster, and once more when the moment of gladness ends.
 *
 * THE CLOCK IS READ IN EFFECTS, NEVER WHILE RENDERING. This used to note the end of work, and take
 * the time, in the middle of a render, which is exactly what the React Compiler assumes a component
 * does not do: compiled, a render-time `Date.now()` is read once and kept. Time is state here, moved
 * by the minute tick, by the end of work and by the end of the moment of gladness, so a sleeping face
 * can be up to a minute late and never early.
 */
export function useBotMood(input: {
  working: boolean;
  blocked: boolean;
  lastMessageAt: string | undefined;
}): BotAvatarState {
  const [now, setNow] = useState(() => Date.now());
  const [workedUntil, setWorkedUntil] = useState<number | null>(null);
  const wasWorking = useRef(input.working);

  // A layout effect, so the glad face is on the first frame after the work rather than the second.
  useLayoutEffect(() => {
    if (wasWorking.current && !input.working) {
      const ended = Date.now();
      setWorkedUntil(ended);
      setNow(ended);
    }
    wasWorking.current = input.working;
  }, [input.working]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (input.working || workedUntil === null) return;
    const remaining = DONE_FOR_MS - (Date.now() - workedUntil);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining + 16);
    return () => clearTimeout(timer);
  }, [input.working, workedUntil]);

  return moodFor({
    working: input.working,
    blocked: input.blocked,
    lastMessageAt: input.lastMessageAt,
    workedUntil,
    now,
  });
}
