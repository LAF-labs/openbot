import { IconHome } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { useState } from "react";
import { BotDay } from "@/components/app-sidebar/bot-day";
import { shellLightsInset } from "@/components/layout/shell-titlebar";
import { Button } from "@/components/ui/button";
import { focusRing } from "@/components/ui/focus";
import { primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  HOME_PANEL_STEP,
  setHomePanelOpen,
  setHomePanelWidth,
  useHomePanel,
} from "@/lib/home-panel";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * THE HOME PANEL: A COLUMN OF WIDGETS AT THE LEFT, FOLDED AND OPENED BY THE HOME BUTTON
 * (`docs/laf/redesign-2026-10.md` §1 and §2; the reference is Hark's).
 *
 * THIS IS THE FRAME. It stands where the sidebar stood, a fifth of the window by default and never
 * under 280px, dragged by its right edge up to seven tenths — less wherever that would leave the
 * screen beside it under 360px. The bounds are the stylesheet's (`w-home-panel`), so the window
 * being resized needs nothing from here; what is handed down is only the width the person chose.
 *
 * WHAT IS IN IT TODAY IS 오늘, the Bot's day, which lived on this height once before and was drawn
 * for a column this narrow (`bot-day.tsx`). The panels a person asks the Bot to make come later;
 * nothing here offers to make one, because nothing can yet.
 *
 * NOT DRAWN ON A PHONE: there home is a screen of its own, swiped to, and that comes with the
 * phone's three screens.
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
      className="relative flex h-full w-home-panel shrink-0 select-none flex-col max-md:hidden"
      data-home-panel
      id="home-panel"
      style={chosen}
    >
      {/*
       * The height of the window chrome it sits under, and the window's handle: the installed app
       * draws its traffic lights over this corner, so the button starts to their right there.
       */}
      <div
        className={cn(
          "flex h-titlebar shrink-0 items-center px-3",
          shellLightsInset(),
        )}
        data-tauri-drag-region
      >
        <HomeButton />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 pb-3">
        <TodayWidget />
      </div>
      <PanelEdge />
    </aside>
  );
}

/**
 * The home button: one control, drawn at the window's top left whichever way the panel is — in the
 * panel's own first row while it is open, in the row at the top of the screen while it is folded.
 */
export function HomeButton() {
  const { isOpen } = useHomePanel();
  const name = isOpen ? t("Close the home panel") : t("Open the home panel");
  return (
    <Button
      aria-controls="home-panel"
      aria-expanded={isOpen}
      aria-label={name}
      /*
       * The ink's own colour in every state. The ghost button it is built on greys itself while
       * `aria-expanded` is true and on hover, each under its own variant, so each is answered
       * under the same one — a plain `bg-foreground` lost to them (measured: the open panel's
       * button was the muted fill).
       */
      className="size-8 rounded-full bg-foreground text-background not-disabled:hover:bg-foreground/85 not-disabled:hover:text-background aria-expanded:bg-foreground aria-expanded:text-background dark:not-disabled:hover:bg-foreground/85"
      data-home-button
      onClick={() => setHomePanelOpen(!isOpen)}
      size="icon-sm"
      title={name}
      variant="ghost"
    >
      <IconHome className="size-4.5" />
    </Button>
  );
}

/** A widget's card: a pane of glass on the backdrop — 18px corners, a bright edge, and the card's lift. */
function Widget({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <section className="rounded-3xl border border-glass-border bg-glass text-card-foreground shadow-card backdrop-blur-xl">
      <h2 className="px-3.5 pt-3 pb-1 font-medium text-sm">{title}</h2>
      {children}
    </section>
  );
}

function TodayWidget() {
  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());
  const bot = mine.bots ? primaryBot(mine.bots, channels.data) : undefined;
  if (!bot) return null;
  return (
    <Widget title={t("Today")}>
      <BotDay
        botId={bot.id}
        empty={
          <p className="px-3.5 pb-3.5 text-muted-foreground text-sm">
            {t(
              "Nothing yet today. What you hand over in the conversation shows up here.",
            )}
          </p>
        }
      />
    </Widget>
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
