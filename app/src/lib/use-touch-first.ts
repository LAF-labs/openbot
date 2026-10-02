import { useSyncExternalStore } from "react";

/**
 * A DEVICE WHOSE FIRST WAY IN IS A FINGER — a phone, a tablet without a mouse.
 *
 * Asked of the device, not of the window's width: a narrow window on a PC still has a keyboard with
 * a Shift key, and a wide tablet still has none. `hover: none` and `pointer: coarse` together are
 * what a touch screen with no mouse reports; a laptop with a touch screen reports a fine pointer.
 *
 * Read by the composer, where it decides what Return does (`composer.tsx`).
 */
const TOUCH_FIRST_QUERY = "(hover: none) and (pointer: coarse)";

const isTouchFirst = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia(TOUCH_FIRST_QUERY).matches;

const subscribeToPointer = (onChange: () => void) => {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return () => {};
  }
  // A mouse plugged into a tablet, or taken away again.
  const query = window.matchMedia(TOUCH_FIRST_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

export const useIsTouchFirst = () =>
  useSyncExternalStore(subscribeToPointer, isTouchFirst, () => false);
