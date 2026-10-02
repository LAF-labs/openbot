import { useEffect, useState } from "react";

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
    const timer = setTimeout(() => setLasted(what), afterMs);
    return () => {
      clearTimeout(timer);
      setLasted(null);
    };
  }, [what, afterMs]);
  return what !== null && lasted === what;
}
