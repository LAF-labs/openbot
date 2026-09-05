import { createRouter, Link } from "@tanstack/react-router";
import { Button } from "./components/ui/button";
import { PageSkeleton } from "./components/ui/skeleton";
import { t } from "./lib/i18n";
import type { RouterContext } from "./router-context";
import { routeTree } from "./routeTree.gen";

/**
 * WHAT A PERSON SEES WHEN THE APP CANNOT GO ON.
 *
 * Without these three the router falls back to its own developer-facing pages: a stack trace on a
 * white background for a thrown loader, a bare "Not Found" string for a mistyped URL. A 500 from
 * /api/me was enough to replace the entire product with a framework error page — which is not just
 * ugly, it is a screen a person cannot act on and cannot get out of.
 */
function AppErrorScreen({ reset }: { reset: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-8 text-center">
      <p className="font-semibold text-lg">{t("Something went wrong.")}</p>
      <p className="max-w-sm text-pretty text-muted-foreground text-sm">
        {t("Nothing was lost. Trying again is usually enough.")}
      </p>
      <Button className="mt-1" onClick={reset} variant="outline">
        {t("Try again")}
      </Button>
    </div>
  );
}

function NotFoundScreen() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-8 text-center">
      <p className="font-semibold text-lg">{t("There is nothing here.")}</p>
      <p className="max-w-sm text-pretty text-muted-foreground text-sm">
        {t("The page you asked for does not exist, or no longer does.")}
      </p>
      <Button
        className="mt-1"
        nativeButton={false}
        render={(props) => <Link to="/" {...props} />}
        variant="outline"
      >
        {t("Back to app")}
      </Button>
    </div>
  );
}

export const router = createRouter({
  routeTree,
  context: {} as RouterContext,
  defaultErrorComponent: ({ reset }) => <AppErrorScreen reset={reset} />,
  defaultNotFoundComponent: NotFoundScreen,
  /*
   * THE FOURTH SCREEN, AND UNTIL NOW IT WAS A WHITE PAGE.
   *
   * There was no pending component at all, so a route waiting on its loader rendered NOTHING. With
   * the API answering in four seconds — a slow connection, not an outage — six screens were blank
   * white for the whole four: `/`, `/agents`, `/routines`, `/skills`,
   * `/settings/connected-accounts`, `/admin/audit`. And it was the whole application that went
   * blank rather than one pane, because the route that waits is almost always `_authed`, whose
   * `beforeLoad` holds on `/api/me` above the sidebar and everything else.
   *
   * 300ms before it shows, 300ms minimum once it has. Both numbers exist to stop the cure being
   * worse: below the first, a fast local response would flash a skeleton for two frames on every
   * navigation; without the second, a response landing at 310ms would flash it for ten
   * milliseconds. The defaults are 1000/500, and a full second of blank white is the bug.
   */
  defaultPendingComponent: PageSkeleton,
  defaultPendingMs: 300,
  defaultPendingMinMs: 300,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
