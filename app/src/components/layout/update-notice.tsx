import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import {
  onShellUpdateReady,
  restartToUpdate,
  shellUpdateReady,
} from "@/lib/notifications/shell";

/**
 * 새 버전이 준비됐어요 — the one thing the installed app says about an update.
 *
 * The shell fetches a newer version at launch and holds it (desktop/src-tauri/src/lib.rs,
 * `install_updates`). Until 2026-09-26 the page could not see that at all: an update arrived in
 * silence and a person never learned anything had improved (teardown G11). Now the shell says so
 * and this card appears, once per version, in the corner — no sound, no dialog, nothing that
 * takes the screen.
 *
 * NEVER A RESTART IN THE MIDDLE OF SOMETHING. The window drives the Bot's turn, so restarting it
 * ends whatever the Bot was doing. 지금 다시 시작 is withheld while the Bot is working or waiting
 * on the person, and the card says why; 나중에 puts the card away until the next launch. The
 * shell itself refuses a restart it has no update for.
 *
 * The version is a fact the shell reports; every word around it is the page's.
 */
export function UpdateNotice({ isBotBusy }: { isBotBusy: boolean }) {
  const [version, setVersion] = useState<string | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const read = () => {
      void shellUpdateReady().then((ready) => {
        if (isMounted) setVersion(ready);
      });
    };
    read();
    const stop = onShellUpdateReady(read);
    return () => {
      isMounted = false;
      stop();
    };
  }, []);

  if (!version || dismissedVersion === version) return null;

  const handleRestart = async () => {
    setIsRestarting(true);
    setHasFailed(false);
    // Nothing after a success runs: the page goes with the process.
    const isRestarted = await restartToUpdate();
    if (!isRestarted) {
      setIsRestarting(false);
      setHasFailed(true);
    }
  };

  return (
    <div
      className="fixed top-16 right-4 z-40 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-2xl border border-border bg-background p-4 text-sm shadow-md"
      role="status"
    >
      <p className="font-medium">{t("A new version is ready")}</p>
      <p className="text-muted-foreground">
        {hasFailed
          ? t("Could not restart. Quit the app and open it again.")
          : isBotBusy
            ? t("Your Bot is working. Restart once it is done.")
            : t("Restart to start using version {version}.", { version })}
      </p>
      <div className="flex justify-end gap-2">
        <Button
          onClick={() => setDismissedVersion(version)}
          size="sm"
          variant="ghost"
        >
          {t("Later")}
        </Button>
        <Button
          disabled={isBotBusy || isRestarting}
          onClick={handleRestart}
          size="sm"
        >
          {isRestarting ? t("Restarting…") : t("Restart now")}
        </Button>
      </div>
    </div>
  );
}
