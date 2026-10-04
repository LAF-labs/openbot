import { useEffect, useState } from "react";

/**
 * How long every wait here is, as a share of what its caller asked for: 1, always, in the app.
 *
 * A TEST SEAM, and only that. The waits are the product's and stay where they are written — the
 * thinking line's 1.2 s between steps in `chat-transcript.tsx`, the queued line's 2 s in
 * `server-channel-chat.tsx` — but a test of them waited them out on the real clock, several times
 * a test: the two files that do took 23 s of the app suite (measured 2026-10-04). Scaled, a test
 * keeps every proportion it asserts — "not yet" at a fraction of the wait, "said" once it has
 * passed — in a fraction of the time. Read when the timer is set, never while rendering.
 */
let lastingScale = 1;

/** Test seam: scale every lasting wait; with no argument, back to the waits as written. */
export function setLastingScale(scale = 1): void {
  lastingScale = scale;
}

/**
 * Whether something has lasted long enough to be worth saying.
 *
 * `what` names the thing that is going on — a turn's id while it waits for the Bot — or is null
 * while nothing is. True once the same thing has gone on for `afterMs` without a break, and false
 * the moment it stops.
 *
 * FOR STATES THAT ARE USUALLY OVER BEFORE ANYBODY COULD READ THEM. Every turn is `queued` for a few
 * milliseconds before it runs; said the instant it was true, "다른 일을 먼저 마치는 중" would flash
 * under every message somebody sends, about a Bot that was free all along.
 *
 * The answer is held against the thing it was earned by, not as a bare yes: a second thing that
 * begins in the same commit the first ended in starts from nothing, without a frame of the first
 * one's yes. And it is forgotten when the thing stops, so the same thing beginning again — a turn
 * queued a second time — waits as long as it did the first time.
 */
export function useLasting(what: string | null, afterMs: number): boolean {
  const [lasted, setLasted] = useState<string | null>(null);
  useEffect(() => {
    if (what === null) return;
    const timer = setTimeout(() => setLasted(what), afterMs * lastingScale);
    return () => {
      clearTimeout(timer);
      setLasted(null);
    };
  }, [what, afterMs]);
  return what !== null && lasted === what;
}
