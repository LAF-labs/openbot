import { IconHome } from "@tabler/icons-react";
import type { QueryKey } from "@tanstack/react-query";
import { type KeyboardEvent, type PointerEvent, useId, useRef } from "react";
import { BotDay } from "@/components/app-sidebar/bot-day";
import { HomeWidgets } from "@/components/layout/home-widgets";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyBots } from "@/lib/agents/my-bots";
import {
  HOME_PANEL_MIN,
  setHomeOpen,
  setHomeWidth,
  useHomePanelFit,
} from "@/lib/home/home-panel";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 홈: THE PANEL AT THE LEFT OF THE WINDOW (2026-10-10, record §1 and §2, piece 3-2).
 *
 * The frame, and the first thing in it. The frame is a column beside the screen that a person
 * folds with the home button in the top row and drags by its right edge; how wide it may be, and
 * when it steps aside, is `lib/home/home-panel.ts`. What it will hold is cards a person asks for
 * in a sentence (§2), and those are later pieces.
 *
 * WHAT IT HOLDS TODAY IS 오늘 (`app-sidebar/bot-day.tsx`): what is waiting on the person, what the
 * Bot did, what comes next. A frame with nothing in it would be a button that opens an empty
 * box, and 오늘 is the one thing here that is already a panel — the record names it the first
 * candidate. THE SAME LIST WAS TAKEN OUT OF THE OLD COLUMN ON 2026-10-04 for being too many words,
 * and that has to be answered: there it stood under the conversation's row on every screen,
 * whether or not anybody wanted it, and could not be put away. Here one press folds it, the fold
 * is remembered, and the width is the person's.
 *
 * UNDER 오늘 ARE 소식 · 목표 · 만든 것 (piece 3-4, `home-widgets.tsx`): the other three screens that
 * already behaved like panels, each the top three rows of its screen under a title that leads to
 * the whole of it.
 *
 * THE WIDTH IS ONE CSS VARIABLE ON THE APP'S FRAME (`--home-panel-width`, set in
 * `routes/_authed/_app.tsx`), read by this panel and by the top row's left cell, so the screen's
 * own header starts where the screen does. A drag writes that variable on the frame directly —
 * a store write on every pixel would draw the whole app on every pixel — and what the store
 * keeps is where the drag ended.
 */

/** What the home button says it controls. */
export const HOME_PANEL_ID = "home-panel";

/** One press of an arrow key on the edge, and with Shift held. */
const KEY_STEP = 16;
const KEY_STRIDE = 64;

const frameOf = (element: Element): HTMLElement | null =>
  element.closest<HTMLElement>("[data-home-frame]");

export function HomePanel({
  rosterQueries,
}: {
  /** What 오늘 reads that the row reads too: asked for again by 다시 불러오기. */
  rosterQueries: readonly QueryKey[];
}) {
  const { hasRoom, max, width } = useHomePanelFit();
  const isDrawn = width > 0;
  /** Where the edge has been dragged to; null when it is not being dragged. */
  const dragged = useRef<number | null>(null);

  const fit = (wanted: number) =>
    Math.round(Math.min(Math.max(wanted, HOME_PANEL_MIN), max));

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const frame = frameOf(event.currentTarget);
    if (!frame) return;
    // The edge keeps the pointer: a drag that crosses the Bot's screen or leaves the window ends here.
    event.currentTarget.setPointerCapture(event.pointerId);
    // No easing while it follows the hand.
    frame.dataset.resizing = "true";
    dragged.current = width;
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragged.current === null) return;
    // The panel starts at the window's left edge, so where the pointer is, is how wide it is.
    const next = fit(event.clientX);
    dragged.current = next;
    frameOf(event.currentTarget)?.style.setProperty(
      "--home-panel-width",
      `${next}px`,
    );
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const ended = dragged.current;
    if (ended === null) return;
    dragged.current = null;
    const frame = frameOf(event.currentTarget);
    if (frame) delete frame.dataset.resizing;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (ended !== width) setHomeWidth(ended);
  };

  /** The same edge from the keyboard: arrows move it, Home and End take it to its ends. */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STRIDE : KEY_STEP;
    const next =
      event.key === "ArrowLeft"
        ? fit(width - step)
        : event.key === "ArrowRight"
          ? fit(width + step)
          : event.key === "Home"
            ? HOME_PANEL_MIN
            : event.key === "End"
              ? max
              : null;
    if (next === null) return;
    event.preventDefault();
    if (next !== width) setHomeWidth(next);
  };

  return (
    <aside
      aria-label={t("Home")}
      className={cn(
        // Below `lg` this app has no 홈 (`home-panel.ts`); the variable is 0 while it is folded.
        "relative hidden w-(--home-panel-width) shrink-0 overflow-hidden lg:block",
        "transition-[width] duration-300 ease-out group-data-resizing/frame:transition-none motion-reduce:transition-none",
      )}
      data-home-panel={isDrawn ? "open" : hasRoom ? "folded" : "aside"}
      id={HOME_PANEL_ID}
      // Folded it is zero pixels of markup: nothing in it may be reached by Tab or a screen reader.
      inert={!isDrawn}
    >
      {/*
       * Never laid out narrower than 홈's least, so folding slides the edge over what is there
       * instead of squeezing every row on the way to nothing. In pixels, as `HOME_PANEL_MIN` is:
       * a step of the spacing scale is a share of the root's type size, which is 14 here, and
       * `min-w-70` was 245 (measured), 35 short of the least it was written to be.
       */}
      <div
        className="flex h-full min-w-[280px] flex-col border-border border-r"
        data-home-content
      >
        <SectionBoundary
          className="min-h-0 flex-1"
          queryKeys={rosterQueries}
          section="home"
        >
          <HomeToday />
        </SectionBoundary>
      </div>
      {/*
       * THE EDGE. A separator that can be moved is the control a screen reader knows for this
       * (the value is the panel's width in pixels); six pixels of it is a mouse's, the arrow keys
       * are everybody's.
       */}
      {/* biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be focused, dragged or given a value */}
      <div
        aria-label={t("Width of Home")}
        aria-orientation="vertical"
        aria-valuemax={max}
        aria-valuemin={HOME_PANEL_MIN}
        aria-valuenow={width}
        className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize touch-none outline-none transition-colors hover:bg-border focus-visible:bg-ring"
        data-home-edge
        onKeyDown={handleKeyDown}
        onLostPointerCapture={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        role="separator"
        tabIndex={0}
      />
    </aside>
  );
}

/**
 * The button in the top row that folds 홈 and brings it back. A house and no word; what it does
 * is its name, and whether 홈 is open is `aria-expanded`.
 *
 * WHERE THERE IS NO ROOM IT SAYS SO AND DOES NOTHING. With the Bot's screen open at its middle
 * size in the smallest window, 홈 has stepped aside (`home-panel.ts`); a press that changed a
 * setting and showed nothing would be a control that does nothing.
 */
export function HomeButton() {
  const { hasRoom, isOpen, width } = useHomePanelFit();
  const isDrawn = width > 0;
  const name = !hasRoom
    ? t("No room for Home beside what is open")
    : isDrawn
      ? t("Fold Home")
      : t("Open Home");
  return (
    <Button
      aria-controls={HOME_PANEL_ID}
      aria-expanded={isDrawn}
      aria-label={name}
      className="hidden shrink-0 lg:inline-flex"
      data-home-button
      disabled={!hasRoom}
      onClick={() => setHomeOpen(!isOpen)}
      size="icon"
      title={name}
      variant="ghost"
    >
      <IconHome />
    </Button>
  );
}

/** 오늘, for the one Bot — or, on an account from before the cap, each Bot's under its name. */
function HomeToday() {
  const mine = useMyBots();
  const bots = mine.bots ?? [];
  const isSeveral = bots.length > 1;
  const headingId = useId();

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto py-3">
      {mine.bots === undefined && !mine.isError ? (
        <Skeleton className="mx-3 h-24 rounded-xl" />
      ) : null}
      {bots.map((one) => (
        <section aria-labelledby={`${headingId}-${one.id}`} key={one.id}>
          <h2
            className="px-3 pb-1 font-semibold text-sm"
            id={`${headingId}-${one.id}`}
          >
            {isSeveral ? one.name : t("Today")}
          </h2>
          <BotDay
            botId={one.id}
            empty={
              <p className="px-3 py-2 text-muted-foreground text-sm">
                {t(
                  "Nothing yet today. What you hand over in the conversation shows up here.",
                )}
              </p>
            }
          />
        </section>
      ))}
      <HomeWidgets />
    </div>
  );
}
