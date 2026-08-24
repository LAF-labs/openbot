import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export const Route = createFileRoute("/unreachable")({
  component: UnreachableScreen,
});

/**
 * The one failure an app whose UI lives on a server has to explain by itself.
 *
 * Deliberately outside every data route: it must render with the API completely down, so it asks
 * for nothing. Retrying is a full page load rather than a router navigation, because the reason
 * anybody is here is that the last load did not finish and the caches behind it are suspect.
 */
function UnreachableScreen() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-8 text-center">
      <p className="font-semibold text-lg">{t("Cannot reach the server.")}</p>
      <p className="max-w-sm text-pretty text-muted-foreground text-sm">
        {t(
          "This usually clears on its own. Nothing your Bots are doing has stopped.",
        )}
      </p>
      <Button
        className="mt-1"
        onClick={() => {
          window.location.replace("/");
        }}
        variant="outline"
      >
        {t("Try again")}
      </Button>
    </div>
  );
}
