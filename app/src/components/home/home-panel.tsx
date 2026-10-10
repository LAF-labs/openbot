import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { useState } from "react";
import { HomeButton } from "@/components/home/home-button";
import { LIGHTS_CLEARANCE } from "@/components/layout/app-top-bar";
import { focusRing } from "@/components/ui/focus";
import {
  HOME_PANEL_STEP,
  setHomePanelWidth,
  useHomePanel,
} from "@/lib/home-panel";
import { t } from "@/lib/i18n";
import { inShell } from "@/lib/notifications/shell";
import { cn } from "@/lib/utils";

/**
 * The panel's place beside the screen. Also what its seam is given (`routes/_authed/_app.tsx`), so
 * a panel that could not be drawn says so in the room it had instead of taking the screen's.
 */
export const HOME_PANEL_PLACE = "w-home-panel shrink-0 max-md:hidden";

/**
 * THE HOME PANEL: A COLUMN AT THE LEFT OF THE WINDOW, FOLDED AND OPENED BY THE HOME BUTTON
 * (`docs/laf/redesign-2026-10.md` §1 and §2, piece 3-2; the reference is Hark's).
 *
 * THIS IS THE FRAME. It stands beside the top row and the screen, the whole height of the window, a
 * fifth of it wide by default and never under 280px, dragged by its right edge up to seven tenths —
 * less wherever that would leave the screen beside it under 360px. The bounds are the stylesheet's
 * (`w-home-panel`), so the window being resized needs nothing from here; what is handed down is
 * only the width the person chose.
 *
 * ITS FIRST ROW IS THE WINDOW'S HANDLE WHILE IT IS OPEN. The installed app draws its traffic
 * lights over the window's top left corner, and that corner is this panel's then, not the top
 * row's: so this row is the height the lights sit in, carries `data-tauri-drag-region`, and leaves
 * their width empty before the home button. The top row stops leaving it (`app-top-bar.tsx`).
 *
 * NOT IN A NARROW WINDOW. Under `md` there is no room for a column beside the screen, and a
 * phone's browser is not a surface this app is made for (owner, 2026-10-10): the panel and its
 * button are not drawn there, and the bar under the screen is what it was.
 */
export function HomePanel() {
  const panel = useHomePanel();
  if (!panel.isOpen) return null;

  /*
   * The chosen width goes down as a custom property, not as a width: the stylesheet holds it
   * between the two bounds, and a width set here would be the one thing in the window that did not
   * follow the window.
   */
  const chosen =
    panel.width === null
      ? undefined
      : ({ "--home-panel-chosen": `${panel.width}px` } as CSSProperties);

  return (
    <aside
      aria-label={t("Home")}
      className={cn(
        "relative flex h-full min-h-0 select-none flex-col border-border border-e bg-sidebar",
        HOME_PANEL_PLACE,
      )}
      data-home-panel
      id="home-panel"
      style={chosen}
    >
      <div
        className={cn(
          "flex h-titlebar shrink-0 items-center pe-3",
          inShell() ? LIGHTS_CLEARANCE : "ps-3",
        )}
        data-tauri-drag-region
      >
        <HomeButton />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 pb-3" />
      <PanelEdge />
    </aside>
  );
}

/**
 * THE PANEL'S RIGHT EDGE, DRAGGED OR STEPPED. A separator a person can focus is a control with a
 * value, so it says the width it is at; the arrows move it by 16px for somebody who has no pointer.
 *
 * The pointer is captured on the way down. Without that the drag ended the moment the pointer
 * crossed onto the conversation, which is where every drag to the right goes.
 */
function PanelEdge() {
  const [isDragging, setIsDragging] = useState(false);
  const [width, setWidth] = useState<number | undefined>(undefined);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    // The panel starts at the window's left edge, so where the pointer is is how wide it is.
    setHomePanelWidth(event.clientX, window.innerWidth);
    setWidth(Math.round(event.clientX));
  };
  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDragging(false);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const drawn = event.currentTarget.parentElement?.offsetWidth;
    if (drawn === undefined) return;
    const next =
      drawn + (event.key === "ArrowRight" ? HOME_PANEL_STEP : -HOME_PANEL_STEP);
    setHomePanelWidth(next, window.innerWidth);
    setWidth(next);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take focus or a drag; this is the window splitter pattern.
    <div
      aria-label={t("Home panel width")}
      aria-orientation="vertical"
      aria-valuenow={width}
      className={cn(
        "-right-1 absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none rounded-full transition-colors hover:bg-border",
        isDragging && "bg-border",
        focusRing,
      )}
      data-home-panel-edge
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      role="separator"
      tabIndex={0}
    />
  );
}
