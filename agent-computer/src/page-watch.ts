/**
 * Everything a page can tell us that no tool call would ever return.
 *
 * Attached the moment a page exists, including a page a site opened by itself, because both of the
 * things below happen without anybody asking: a dialog blocks the page until it is answered, and a
 * download starts and finishes while the Bot is still waiting for a click to return.
 */
import type { Page } from "playwright";
import { log } from "./log";
import { followArrivals } from "./page-arrival";
import { type BotSession, note } from "./sessions";
import { type Workspace, WorkspaceFileError } from "./workspace";

/** How often the volume is asked for its room while a download lands. */
const DOWNLOAD_WATCH_MS = 1_000;

/**
 * A DOWNLOAD IS WATCHED WHILE IT LANDS. How large it is cannot be asked until it has landed, and it
 * lands on the deployment's one disk: a link to a file larger than what is free would fill it under
 * the database before anything measured it. So the volume is asked on a clock, and a download that
 * has taken the room it must leave is cancelled — once; `saveAs` then fails, and `ranOut` is how
 * the caller tells that failure from any other and says too large, not failed.
 */
export function watchRoom(
  hasRoom: () => Promise<boolean>,
  cancel: () => Promise<unknown>,
  everyMs: number = DOWNLOAD_WATCH_MS,
): { ranOut: () => boolean; stop: () => void } {
  let ranOut = false;
  const clock = setInterval(() => {
    void hasRoom().then(
      (room) => {
        if (room || ranOut) return;
        ranOut = true;
        void cancel().catch(() => undefined);
      },
      () => undefined,
    );
  }, everyMs);
  return { ranOut: () => ranOut, stop: () => clearInterval(clock) };
}

export function watchPage(
  session: BotSession,
  botId: string,
  page: Page,
  workspace: Workspace,
): void {
  /*
   * A different document means every ref from the last snapshot names something nobody is looking
   * at. The generation is bumped for a new tab for the same reason `/navigate` bumps it.
   */
  session.snapshotId += 1;

  // Whether its next document is on its way, which is the one thing a look at it cannot ask it.
  followArrivals(page);

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
      const room = watchRoom(
        () => workspace.hasRoom(),
        () => download.cancel(),
      );
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
            room.ranOut() ||
            (error instanceof WorkspaceFileError &&
              error.code === "laf:file_too_large")
              ? "laf:download_too_large"
              : "laf:download_failed",
        });
        log.error("download_not_saved", { bot: botId, reason: error });
      } finally {
        room.stop();
      }
    })();
  });
}
