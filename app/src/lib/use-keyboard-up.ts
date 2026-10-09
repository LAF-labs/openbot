import { useSyncExternalStore } from "react";

/**
 * WHETHER A PHONE'S ON-SCREEN KEYBOARD IS UP, for the pager to hold still under it
 * (`phone-pager.tsx`) — a sideways drag over a box being typed in is somebody moving the caret. It
 * was written for the bar at the bottom to step out of the keyboard's way; the bar went on
 * 2026-10-09 and the rule below is the same.
 *
 * NOT "THE COMPOSER HAS FOCUS". That was the first rule, and it hid the bar on every visit to the
 * conversation: the composer takes the caret the moment the screen opens (`composer.tsx`, so the
 * first keystroke on a PC lands in the box), and on a phone that focus raises no keyboard until the
 * box is touched — measured at 375 wide, 2026-09-27: the 대화 tab, and only it, had no bar.
 *
 * So: something that takes typing has the focus, AND the visual viewport is shorter than the layout
 * one by more than a toolbar — which is what a keyboard does on iOS Safari and on Chrome for
 * Android (its default since 108 resizes only the visual viewport). The scale is taken out, so
 * pinching to zoom is not a keyboard.
 */
const KEYBOARD_MIN_PX = 150;

function read(): boolean {
  if (typeof window === "undefined") return false;
  const viewport = window.visualViewport;
  if (!viewport) return false;
  const active = document.activeElement as HTMLElement | null;
  const takesTyping =
    active !== null &&
    (active.isContentEditable ||
      active.tagName === "TEXTAREA" ||
      (active.tagName === "INPUT" &&
        !["button", "checkbox", "radio", "range", "submit"].includes(
          (active as HTMLInputElement).type,
        )));
  if (!takesTyping) return false;
  return (
    window.innerHeight - viewport.height * viewport.scale > KEYBOARD_MIN_PX
  );
}

function subscribe(onChange: () => void): () => void {
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", onChange);
  window.addEventListener("focusin", onChange);
  window.addEventListener("focusout", onChange);
  return () => {
    viewport?.removeEventListener("resize", onChange);
    window.removeEventListener("focusin", onChange);
    window.removeEventListener("focusout", onChange);
  };
}

export function useIsKeyboardUp(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}

/** For tests: the same reading, without a component. */
export const isKeyboardUp = read;
