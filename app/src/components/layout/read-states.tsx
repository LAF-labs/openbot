import { LiveRegion } from "@/components/layout/live-region";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import type { ReadLine } from "@/lib/read-line";
import { cn } from "@/lib/utils";

/**
 * THE ONE LINE A READ CAN END IN BESIDES ITS DATA, IN A PLACE ON THE SCREEN THAT IS ALWAYS THERE.
 *
 * `useReading` (`lib/reading.ts`) says which state a read is in and `readLineOf`
 * (`lib/read-line.ts`) puts it in the screen's words; `ReadNotice` says it. Each screen keeps its
 * own sentence — "루틴을 불러오지 못했습니다" is about routines — and its own skeleton and empty state,
 * because those are the shape of what is coming. What is shared is the grammar: a failure is a
 * sentence with 다시 시도 beside it, a refresh that failed over data still on screen is one quiet
 * line, and something this place cannot have is a sentence with nothing to press.
 *
 * MOUNTED BEFORE IT HAS ANYTHING TO SAY, like every status line in this app (`docs/laf/dialogs.md`,
 * `LiveRegion`). A screen reader announces a change to a region it already knows about; a line
 * mounted only once a read had failed would arrive with its region and, in most screen readers, not
 * be read out — somebody who cannot see the list would never be told it had not loaded. So a screen
 * draws its `ReadNotice` on every render, in the place its line belongs, and the notice is nothing —
 * `display: contents` around two empty, visually hidden regions — until there is something to say.
 * Keep it at the same place among its siblings in every state (`cond ? x : null` beside it, not an
 * early return), or React draws a new one and the region is new again.
 */
export function ReadNotice({
  className,
  hasButton = true,
  line,
  onRetry,
  size = "default",
}: {
  /**
   * The place the line takes once it says something — a margin, a padding. Not applied while it is
   * silent, so a silent notice leaves no gap in a column.
   */
  className?: string;
  /** False keeps the words and drops the press, for the 64px rail, which draws a press of its own. */
  hasButton?: boolean;
  line: ReadLine;
  onRetry?: () => void;
  /** `compact` for the narrow columns — the roster, a Bot's side pane — where a page line wraps. */
  size?: "default" | "compact";
}) {
  const isCompact = size === "compact";
  const isRetrying =
    line !== null && line.kind !== "unavailable" && line.isRetrying;
  return (
    <div
      className={
        line === null
          ? "contents"
          : cn(
              "flex flex-wrap items-center gap-y-1",
              /*
               * A failure or "not here" stands where the list would have been, and takes a list's
               * room; the quiet line sits among rows that are still there, and takes none.
               */
              line.kind === "stale"
                ? "gap-x-2"
                : cn("gap-x-3", isCompact ? "py-2" : "py-6"),
              className,
            )
      }
      data-read-state={line?.kind}
    >
      {/* A failure interrupts: told it a sentence late, somebody has moved on as if it had worked. */}
      <LiveRegion
        as="p"
        className={cn(
          "text-pretty text-destructive",
          isCompact ? "text-xs" : "text-sm",
        )}
        tone="alert"
      >
        {line?.kind === "failed" ? line.message : null}
      </LiveRegion>
      {/* The quiet ones wait their turn: the screen still works; it is only old, or not here. */}
      <LiveRegion
        as="p"
        className={cn(
          "text-pretty text-muted-foreground",
          line?.kind === "stale" || isCompact ? "text-xs" : "text-sm",
        )}
      >
        {line?.kind === "stale"
          ? t("Could not refresh this. What you see is from before.")
          : line?.kind === "unavailable"
            ? line.message
            : null}
      </LiveRegion>
      {/* 다시 시도 only where asking again can change the answer — never beside "not here". */}
      {hasButton && onRetry && line !== null && line.kind !== "unavailable" ? (
        <Button
          disabled={isRetrying}
          // The focus it was pressed with stays on it while the read goes out again.
          focusableWhenDisabled
          onClick={onRetry}
          size={line.kind === "stale" || isCompact ? "xs" : "sm"}
          type="button"
          variant={line.kind === "stale" ? "ghost" : "outline"}
        >
          {isRetrying ? t("Reloading…") : t("Try again")}
        </Button>
      ) : null}
    </div>
  );
}
