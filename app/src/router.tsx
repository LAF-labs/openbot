import { createRouter, Link } from "@tanstack/react-router";
import { Button } from "./components/ui/button";
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
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
