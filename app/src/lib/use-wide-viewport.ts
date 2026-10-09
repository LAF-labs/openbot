import { useSyncExternalStore } from "react";

/**
 * WIDE ENOUGH FOR THE FULL SIDEBAR — Tailwind's `lg`, read in JavaScript rather than in CSS.
 *
 * A media query in the class list can hide the words but it cannot take them out of the document,
 * and a 64px rail whose names are still in the accessibility tree, still being measured, still being
 * truncated, is a rail only to the eye. `rem` inside a media query is the INITIAL root font size and
 * not this app's 14px root, so 64rem here is the same 1024px `lg:` compiles to.
 *
 * Read by the sidebar (full column or rail) and by the header's drawer, which lists the whole day
 * only below it (`presence-drawer.tsx` says why, and what became of the reason). The PC app's
 * window is never narrower than this (`desktop/src-tauri/tauri.conf.json`).
 */
const WIDE_QUERY = "(min-width: 64rem)";

/**
 * WIDE ENOUGH FOR THE ROW AT THE TOP — Tailwind's `md`, the same way. Below it the row is not drawn
 * (`app-header.tsx`), so a screen that would draw into the row keeps a row of its own there.
 */
const TOP_ROW_QUERY = "(min-width: 48rem)";

function viewportHook(media: string) {
  const matches = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(media).matches;

  const subscribe = (onChange: () => void) => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return () => {};
    }
    const query = window.matchMedia(media);
    query.addEventListener("change", onChange);
    /*
     * AND `resize`, because the media query's own event is not always delivered. Measured: with the
     * window emulated from 800 to 1280 while the tab was backgrounded, `matchMedia(…).matches` read
     * true and the column stayed a rail until the next reload — the `change` never arrived. Dragging
     * a window edge is how this switch is normally reached in the installed app, and a roster that
     * only notices on reload is a roster that noticed nothing. `resize` fires often and costs nothing
     * here: the snapshot is a boolean, so React re-renders only when it actually flips.
     */
    window.addEventListener("resize", onChange);
    return () => {
      query.removeEventListener("change", onChange);
      window.removeEventListener("resize", onChange);
    };
  };

  return function useViewport() {
    return useSyncExternalStore(subscribe, matches, () => true);
  };
}

export const useIsWideViewport = viewportHook(WIDE_QUERY);

export const useHasTopRow = viewportHook(TOP_ROW_QUERY);
