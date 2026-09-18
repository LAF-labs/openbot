import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ConnectionCheckPanel } from "@/components/help/connection-check-panel";
import { SectionBoundary } from "@/components/layout/section-boundary";
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
 *
 * 연결 점검 RUNS HERE, ON THIS SCREEN, because this is the one screen it most needs to reach and the
 * one the signed-in shell's check cannot: that shell is exactly what failed to load. It says whether
 * it is this device's network or the server, which "it usually clears on its own" cannot.
 */
function UnreachableScreen() {
  const [isChecking, setIsChecking] = useState(false);
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-8 text-center">
      <p className="font-semibold text-lg">{t("Cannot reach the server.")}</p>
      <p className="max-w-sm text-pretty text-muted-foreground text-sm">
        {t(
          "This usually clears on its own. Nothing your Bots are doing has stopped.",
        )}
      </p>
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        <Button
          onClick={() => {
            window.location.replace("/");
          }}
          variant="outline"
        >
          {t("Try again")}
        </Button>
        {isChecking ? null : (
          <Button onClick={() => setIsChecking(true)} variant="outline">
            {t("Connection check")}
          </Button>
        )}
      </div>
      {isChecking ? (
        <div className="mt-4 w-full max-w-md text-left">
          {/* A check that threw leaves 다시 시도 above it, the one way on from this screen. */}
          <SectionBoundary section="connection_check">
            <ConnectionCheckPanel />
          </SectionBoundary>
        </div>
      ) : null}
    </div>
  );
}
