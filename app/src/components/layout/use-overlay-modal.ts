import { type RefObject, useLayoutEffect } from "react";

/**
 * A FULL-SCREEN OVERLAY DRAWN BY HAND IS A MODAL TOO: the page under it is inert while it is up, and
 * focus goes back to what opened it when it goes.
 *
 * The Bot's screen and the sign-in handoff are drawn on a portal of their own rather than as Base
 * UI dialogs — the live screen owns the keyboard while somebody drives, and Escape has to hand the
 * wheel back before anything closes. Each said `aria-modal="true"`, and neither kept the promise:
 * Tab walked out of the overlay into the page behind it, and closing it left the focus on `<body>`.
 * `inert` on the app's root is what `aria-modal` promised — nothing behind can be focused, pressed
 * or read while the overlay is up — and the overlays are portalled to `<body>`, outside it.
 *
 * A LAYOUT EFFECT, because of whose effect runs first. The live screen focuses its keyboard field in
 * a passive effect as it mounts, and the children's passive effects run before this component's;
 * read there, "what was focused" is the overlay's own field, not the button that opened it. Layout
 * effects all run before any passive one, so here it is still the opener.
 */
export function useOverlayModal(
  isOpen: boolean,
  /**
   * Where focus goes when the opener is gone by the time the overlay closes. The Bot's screen is
   * opened from 전체 크기로 열기 while somebody drives, and handing back is what takes that button
   * away; its own picture is always there.
   */
  fallback?: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    if (!isOpen) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const page = document.getElementById("root");
    page?.setAttribute("inert", "");
    return () => {
      page?.removeAttribute("inert");
      if (opener?.isConnected) opener.focus();
      else fallback?.current?.focus();
    };
  }, [isOpen, fallback]);
}
