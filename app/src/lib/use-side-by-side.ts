import { useSyncExternalStore } from "react";

/**
 * WIDE ENOUGH FOR THE HOME PANEL TO STAND BESIDE THE SCREEN — Tailwind's `md`, read in JavaScript
 * rather than in CSS. Below it the two are pages a person swipes between (`phone-pager.tsx`), and
 * what belongs to a panel standing beside something — folding it away, dragging its edge — has
 * nothing to act on.
 *
 * A media query in the class list can hide a control but it cannot take it out of the document, and
 * a button to fold a panel that is a whole page is a button only to the eye. `rem` inside a media
 * query is the INITIAL root font size and not this app's 14px root, so 48rem here is the same 768px
 * `md:` compiles to.
 *
 * (`lg` was read the same way for the sidebar's rail and the state drawer until both went,
 * 2026-10-09.)
 */
const SIDE_BY_SIDE_QUERY = "(min-width: 48rem)";

const isSideBySide = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia(SIDE_BY_SIDE_QUERY).matches;

const subscribeToViewport = (onChange: () => void) => {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return () => {};
  }
  const query = window.matchMedia(SIDE_BY_SIDE_QUERY);
  query.addEventListener("change", onChange);
  /*
   * AND `resize`, because the media query's own event is not always delivered. Measured: with the
   * window emulated from 800 to 1280 while the tab was backgrounded, `matchMedia(…).matches` read
   * true and the layout stayed as it was until the next reload — the `change` never arrived.
   * Dragging a window edge is how this switch is normally reached, and a layout that only notices
   * on reload noticed nothing. `resize` fires often and costs nothing here: the snapshot is a
   * boolean, so React re-renders only when it actually flips.
   */
  window.addEventListener("resize", onChange);
  return () => {
    query.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
  };
};

export const useIsSideBySide = () =>
  useSyncExternalStore(subscribeToViewport, isSideBySide, () => true);
