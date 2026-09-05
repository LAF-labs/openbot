import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/lib/i18n";

/**
 * WHAT AN ADMIN LIST LOOKS LIKE BEFORE IT HAS AN ANSWER, AND WHEN IT NEVER GETS ONE.
 *
 * Six screens each drew the word "Loading…" centred in an empty section, and four of them had
 * nothing at all for a read that failed — a heading over a blank div, which is also what a
 * deployment with none of that thing looks like. So "the server did not answer" and "you have not
 * set any up" were the same screen, and the difference lived in a query flag nobody read.
 *
 * Both live here rather than in six copies because the failure was six copies: each page had drifted
 * to its own wording, its own margin, and its own answer to whether a retry button existed at all.
 *
 * `PageSkeleton` is the router's whole-page version for a route that has not resolved. This is the
 * one for a SECTION whose own query is still out, which is a different moment — the page is already
 * on screen and only this part of it is missing.
 */
export const RowsSkeleton = ({
  rows = 3,
  height = "h-12",
}: {
  /** How many placeholder rows. A number no larger than the list usually is. */
  rows?: number;
  /** The height class of one row, matching what is coming. */
  height?: string;
}) => (
  <div aria-busy="true" className="mt-4 flex flex-col gap-2">
    {Array.from({ length: rows }, (_, index) => (
      <Skeleton
        aria-hidden="true"
        className={`${height} w-full rounded-lg`}
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder bars have no identity of their own
        key={index}
      />
    ))}
  </div>
);

/**
 * A read that failed, and the one thing worth offering: doing it again.
 *
 * `role="alert"` so it is announced. The retry is a real control rather than "refresh the page",
 * which is the advice a screen gives when nobody wrote the button.
 */
export const LoadFailed = ({
  message,
  onRetry,
}: {
  /** Already through `t()`. What could not be loaded, in this page's own words. */
  message: string;
  onRetry: () => void;
}) => (
  <div className="mt-4 flex flex-col items-start gap-2">
    <p className="text-destructive text-sm" role="alert">
      {message}
    </p>
    <Button onClick={onRetry} size="sm" type="button" variant="outline">
      {t("Try again")}
    </Button>
  </div>
);
