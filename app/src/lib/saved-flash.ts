import { useEffect, useRef, useState } from "react";

/**
 * "저장됨", and then it stops saying it.
 *
 * A Save that does nothing visible is the most common small lie in this product: the request went,
 * the field kept the words that were already in it, and the only difference on screen was a button
 * that stopped being disabled for a moment. Somebody presses it again.
 *
 * A flash rather than a permanent line, because the message is about the press and not about the
 * state — a "saved" that is still there five minutes later is describing the past.
 */
export function useSavedFlash(milliseconds = 1800): [boolean, () => void] {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleared on unmount: the pane can close while the flash is up, and a timer that then calls
  // setState is React warning at somebody about a component that is no longer there.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return [
    saved,
    () => {
      setSaved(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), milliseconds);
    },
  ];
}
