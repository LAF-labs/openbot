import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

/**
 * WHAT A PAGE LOOKS LIKE WHILE ITS LOADER IS STILL OUT.
 *
 * With the API answering in 4 seconds — a slow phone on a train, not a broken server — `/`,
 * `/agents`, `/routines`, `/skills`, `/settings/connected-accounts` and `/admin/audit` were a BLANK
 * WHITE PAGE for the whole four seconds. The router had no `defaultPendingComponent`, so a pending
 * route rendered nothing at all, and because the pending route is usually `_authed` (whose
 * `beforeLoad` waits on `/api/me`) the nothing was the entire application, sidebar included.
 *
 * The shape deliberately mirrors `PageShell`: the same `max-w-2xl` measure, the same `px-4 py-12`,
 * a title bar and a description line where the title and description will be. A placeholder whose
 * proportions are wrong is worse than none — the page visibly jumps when the real content lands,
 * which reads as a second load.
 *
 * `aria-hidden` on the bars and `aria-busy` on the frame: the bars are decoration and a screen
 * reader has nothing to gain from six named boxes. The pulse is covered by the reduced-motion block
 * in `styles.css`, which stills it and holds it at 0.65 opacity rather than hiding it.
 */
function PageSkeleton() {
  return (
    <div
      aria-busy="true"
      className="flex w-full flex-1 justify-center overflow-hidden bg-background"
      data-slot="page-skeleton"
    >
      <div
        aria-hidden="true"
        className="mx-auto flex w-full max-w-2xl flex-col px-4 py-12"
      >
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-3 h-4 w-full max-w-sm" />
        <div className="mt-12 flex flex-col gap-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}

export { Skeleton, PageSkeleton };
