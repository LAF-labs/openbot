import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import type { Unavailability } from "@/lib/reading";
import { cn } from "@/lib/utils";

/**
 * THE THREE LINES A READ CAN END IN BESIDES ITS DATA, DRAWN ONE WAY ON EVERY SCREEN.
 *
 * `useReading` (`lib/reading.ts`) says which state a read is in; these say it. Each screen keeps its
 * own sentence — "루틴을 불러오지 못했습니다" is about routines — and its own skeleton and empty
 * state, because those are the shape of what is coming. What is shared is the grammar: a failure is
 * a sentence with 다시 시도 beside it, a refresh that failed over data still on screen is one quiet
 * line under it, and something this place cannot have is a sentence with nothing to press.
 *
 * `compact` is for the narrow columns — the roster and a Bot's side pane — where the page-sized
 * line would wrap into three.
 */

type Size = "default" | "compact";

/** Nothing could be read, and nothing from before stands in for it. */
export function ReadFailed({
  className,
  isRetrying = false,
  message,
  onRetry,
  size = "default",
}: {
  className?: string;
  /**
   * Asked again and not answered yet. Most reads go back to their skeleton when asked again, so
   * this is for the one that cannot — a fact missing from an answer that is otherwise in hand.
   */
  isRetrying?: boolean;
  /** Already through `t()`: what could not be loaded, in the screen's own words. */
  message: string;
  onRetry: () => void;
  size?: Size;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2",
        size === "compact" ? "py-2" : "py-6",
        className,
      )}
      data-read-state="failed"
    >
      <p
        className={cn(
          "text-pretty text-destructive",
          size === "compact" ? "text-xs" : "text-sm",
        )}
        role="alert"
      >
        {message}
      </p>
      <Button
        disabled={isRetrying}
        onClick={onRetry}
        size={size === "compact" ? "xs" : "sm"}
        type="button"
        variant="outline"
      >
        {isRetrying ? t("Reloading…") : t("Try again")}
      </Button>
    </div>
  );
}

/**
 * Reading it again failed, and what was read before is still on screen.
 *
 * QUIET ON PURPOSE. The screen above this line still works — its rows can be opened and pressed —
 * so it is not an alert and not red; it only stops somebody taking an old list for a fresh one.
 */
export function ReadStale({
  className,
  isRetrying,
  onRetry,
}: {
  className?: string;
  isRetrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs",
        className,
      )}
      data-read-state="stale"
    >
      <p className="text-pretty" role="status">
        {t("Could not refresh this. What you see is from before.")}
      </p>
      <Button
        disabled={isRetrying}
        onClick={onRetry}
        size="xs"
        type="button"
        variant="ghost"
      >
        {isRetrying ? t("Reloading…") : t("Try again")}
      </Button>
    </div>
  );
}

/**
 * The sentence for a read this place or this account cannot have.
 *
 * An account refused is the same fact on every screen, so it is one sentence; a place without the
 * thing is about the thing, so the screen says which (`notHere`).
 */
export function unavailableText(why: Unavailability, notHere: string): string {
  return why === "not_allowed"
    ? t("This account cannot see this here.")
    : notHere;
}

/**
 * This place, or this account, cannot have it — so there is nothing to press. A retry in front of
 * an answer that will not change is how a working screen comes to look broken.
 */
export function ReadUnavailable({
  className,
  message,
  size = "default",
}: {
  className?: string;
  /** Already through `t()`. */
  message: string;
  size?: Size;
}) {
  return (
    <p
      className={cn(
        "text-pretty text-muted-foreground",
        size === "compact" ? "py-2 text-xs" : "py-6 text-sm",
        className,
      )}
      data-read-state="unavailable"
      role="status"
    >
      {message}
    </p>
  );
}
