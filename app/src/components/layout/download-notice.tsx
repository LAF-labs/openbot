import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { onShellDownload, type ShellDownload } from "@/lib/notifications/shell";

/** How long a saved file is said. A glance, not a thing to dismiss. */
export const SAVED_NOTICE_MS = 6000;

/**
 * 다운로드 폴더에 저장했어요 — what the installed app says when a download ends.
 *
 * A browser draws a download and a webview does not. Measured in the shell on macOS 26.6,
 * 2026-10-02: three presses of 내려받기 on a file card saved `news.csv`, `news (1).csv` and
 * `news (2).csv`, each within the second, and nothing on screen changed after any of them —
 * which is what makes a person press again to find out. This is the line a browser would have
 * drawn: the name the file was saved under, and where.
 *
 * SAVED GOES AWAY ON ITS OWN; NOT SAVED STAYS. The first is a confirmation and the second is the
 * one a person has to read: on a Mac the usual reason is that the system's own question about the
 * Downloads folder was answered no, and pressing again asks nothing and fails the same way. So it
 * says what to look at, and stays until it is closed or a later download replaces it.
 *
 * The shell reports a name and a yes or no; every word here is the page's.
 */
export function DownloadNotice({
  /** Only ever passed by the test that measures the hold. */
  holdMs = SAVED_NOTICE_MS,
}: {
  holdMs?: number;
}) {
  // `turn` so that a second download of the same file is a new notice with a new hold.
  const [ended, setEnded] = useState<{
    download: ShellDownload;
    turn: number;
  } | null>(null);

  useEffect(
    () =>
      onShellDownload((download) => {
        setEnded((current) => ({ download, turn: (current?.turn ?? 0) + 1 }));
      }),
    [],
  );

  useEffect(() => {
    if (!ended?.download.isSaved) return;
    const shown = ended.turn;
    const timer = setTimeout(() => {
      setEnded((current) => (current?.turn === shown ? null : current));
    }, holdMs);
    return () => clearTimeout(timer);
  }, [ended, holdMs]);

  if (!ended) return null;
  const { name, isSaved } = ended.download;

  return (
    <div
      className="pointer-events-auto flex flex-col gap-1 rounded-2xl border border-border bg-background p-4 text-sm shadow-md"
      data-download-notice={isSaved ? "saved" : "failed"}
      role="status"
    >
      <p className="font-medium">
        {isSaved
          ? t("Saved to your Downloads folder")
          : t("Could not save the file")}
      </p>
      {name ? (
        <p className="truncate text-muted-foreground" title={name}>
          {name}
        </p>
      ) : null}
      {isSaved ? null : (
        <>
          <p className="text-muted-foreground">
            {t(
              "Check that this app may use your Downloads folder, then press it again.",
            )}
          </p>
          <div className="flex justify-end">
            <Button onClick={() => setEnded(null)} size="sm" variant="ghost">
              {t("Close")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
