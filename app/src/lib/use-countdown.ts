import { useEffect, useState } from "react";
import { timeLeftToAnswer } from "@/lib/approvals";

/**
 * How long is left to answer a question, kept up to date while somebody is looking at it.
 *
 * A question expires ten minutes after it was raised, and until this existed the card just vanished
 * when it did: nothing counted down, nothing said it would, and a person who came back to the tab
 * found the buttons gone with no explanation (docs/laf/redesign-2026-09.md §5.6(g)-7).
 *
 * A second between ticks, and only while there is something to count. An approval that carries no
 * expiry gives null and no timer is started, which is also what happens once the question is over —
 * a card left on screen after the deadline is not going to become answerable by being redrawn.
 */
export function useCountdown(expiresAt: string | undefined): string | null {
  const [left, setLeft] = useState(() =>
    expiresAt ? timeLeftToAnswer(expiresAt) : null,
  );

  useEffect(() => {
    if (!expiresAt) {
      setLeft(null);
      return;
    }
    setLeft(timeLeftToAnswer(expiresAt));
    const timer = setInterval(() => {
      setLeft(timeLeftToAnswer(expiresAt));
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return left;
}
