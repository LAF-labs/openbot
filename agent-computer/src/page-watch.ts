/**
 * Everything a page can tell us that no tool call would ever return.
 *
 * Attached the moment a page exists, including a page a site opened by itself, because both of the
 * things below happen without anybody asking: a dialog blocks the page until it is answered, and a
 * download starts and finishes while the Bot is still waiting for a click to return.
 */
import type { Page } from "playwright";
import { createDownloadLimit, type DownloadVerdict } from "./download-limit";
import { log } from "./log";
import { followArrivals } from "./page-arrival";
import { type BotSession, note } from "./sessions";
import { type Workspace, WorkspaceFileError } from "./workspace";

export function watchPage(
  session: BotSession,
  botId: string,
  page: Page,
  workspace: Workspace,
  /** Whether this is the tab the Bot's next action lands on. Absent: every tab counts. */
  isActive: () => boolean = () => true,
): void {
  /*
   * A different document means every ref from the last snapshot names something nobody is looking
   * at. The generation is bumped for a new tab for the same reason `/navigate` bumps it.
   */
  session.snapshotId += 1;

  /*
   * AND FOR A NEW DOCUMENT IN THE TAB THE BOT IS ON, WHOEVER SENT IT THERE.
   *
   * The generation moved for a `/navigate`, a tab, a snapshot — and not when the page's own script
   * sent the tab somewhere, nor when a person did during a takeover. A key pressed with no ref is
   * held to the generation the server judged it against (`actions.ts`), so a document nobody asked
   * for has to move it too, or the key lands on a page the server never saw. Only the tab the Bot
   * is on: a background tab that reloads itself changes nothing the Bot's next action lands on, and
   * moving the generation for it would retire refs that are still good.
   */
  const onDocument = () => {
    if (isActive()) session.snapshotId += 1;
  };

  // Each download this tab starts, held to what the workspace takes while it arrives (download-limit.ts).
  const downloads = createDownloadLimit({
    limitBytes: workspace.limits.writeBytes,
  });

  // Whether its next document is on its way, which is the one thing a look at it cannot ask it.
  followArrivals(page, { onDocument, onDownload: downloads.progress });

  page.on("dialog", (dialog) => {
    const kind = dialog.type();
    /*
     * ALERT IS ACCEPTED, CONFIRM AND PROMPT ARE DISMISSED.
     *
     * An alert has one button and answering it is not a decision. A confirm is a decision — 정말
     * 삭제하시겠습니까? — and this process is not where a Bot gets to make one: the boundary in front
     * of it never saw the question, so there is nothing for it to have decided. Dismissed, reported,
     * and the person handles it by taking the wheel. `beforeunload` is accepted because the Bot
     * asked to leave the page and that is the answer to its own question.
     */
    const accepting = kind === "alert" || kind === "beforeunload";
    void (accepting ? dialog.accept() : dialog.dismiss()).catch(
      () => undefined,
    );
    note(session, {
      code: "laf:dialog",
      kind,
      // The page's own words. Not a value anybody typed, and it is usually the whole reason the last
      // action did nothing.
      message: dialog.message(),
      accepted: accepting,
    });
  });

  page.on("download", (download) => {
    void (async () => {
      /*
       * Stopped while it arrives, not measured once it has: `saveAs` waits for the whole file, and
       * the whole file was on the disk before the limit below it was ever asked. Cancelling makes
       * `saveAs` fail, and `stoppedFor` says why before it does.
       */
      const held = downloads.watch(download);
      let stoppedFor: DownloadVerdict | undefined;
      void held.verdict.then((verdict) => {
        stoppedFor = verdict;
        void download.cancel().catch(() => undefined);
      });
      try {
        const saved = await workspace.saveDownload(
          download.suggestedFilename(),
          (to) => download.saveAs(to),
        );
        note(session, {
          code: "laf:downloaded",
          path: saved.path,
          bytes: saved.bytes,
        });
      } catch (error) {
        await download.cancel().catch(() => undefined);
        note(session, {
          // By the workspace's own code: a download that never arrived is not one that was too big.
          code:
            stoppedFor === "too_large" ||
            (error instanceof WorkspaceFileError &&
              error.code === "laf:file_too_large")
              ? "laf:download_too_large"
              : "laf:download_failed",
        });
        log.error("download_not_saved", {
          bot: botId,
          ...(stoppedFor ? { stoppedFor } : {}),
          reason: error,
        });
      } finally {
        held.done();
      }
    })();
  });
}
