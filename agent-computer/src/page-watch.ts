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

/** A look, called on a clock; what is handed back stops the clock. */
type Clock = (look: () => Promise<void>) => () => void;

const eachSecond: Clock = (look) => {
  const clock = setInterval(() => void look(), DOWNLOAD_WATCH_MS);
  return () => clearInterval(clock);
};

/**
 * A DOWNLOAD IS WATCHED WHILE IT LANDS. How large it is cannot be asked until it has landed, and it
 * lands on the deployment's one disk: a link to a file larger than what is free would fill it under
 * the database before anything measured it. So the volume is asked on a clock, and a download that
 * has taken the room it must leave is cancelled — once. Waiting for it then fails, and `ranOut` is
 * how the caller tells that failure from any other and says too large, not failed.
 *
 * ONLY WHILE IT LANDS. Cancelling does nothing to a download that has finished, and from there its
 * size is known and the workspace decides before copying a byte (`saveDownload`); so the caller
 * stops this the moment the download has landed, and a look that was already on its way when it
 * was stopped cancels nothing.
 *
 * The clock is handed in so that a test can make each look happen and wait for it, rather than
 * sleep and hope the machine was not busy.
 */
export function watchRoom(
  hasRoom: () => Promise<boolean>,
  cancel: () => Promise<unknown>,
  clock: Clock = eachSecond,
): { ranOut: () => boolean; stop: () => void } {
  let ranOut = false;
  let stopped = false;
  const stopClock = clock(async () => {
    if (stopped || ranOut) return;
    // A volume that cannot be asked cancels nothing.
    const room = await hasRoom().catch(() => true);
    if (room || stopped || ranOut) return;
    ranOut = true;
    await cancel().catch(() => undefined);
  });
  return {
    ranOut: () => ranOut,
    stop: () => {
      stopped = true;
      stopClock();
    },
  };
}

/** As much of Playwright's `Download` as landing one takes: what a test stands in for. */
export type LandingDownload = {
  suggestedFilename(): string;
  /** Where the finished file is. Waits for it to finish, and throws for one that failed or was cancelled. */
  path(): Promise<string>;
  cancel(): Promise<void>;
  /** Removes the browser's own copy. */
  delete(): Promise<void>;
};

/**
 * A file a page handed the browser, from its first byte to the note that says what became of it.
 *
 * THE BROWSER'S OWN COPY IS DELETED WHATEVER HAPPENED. Chromium keeps a finished download in its
 * temporary directory until the browser closes, and a Bot's browser stays open for days. A kept
 * file was on the disk twice for all that time; a refused one — refused for being too large — was
 * still there whole, so refusing a few of them filled the disk the refusal was protecting (Codex's
 * read of this change).
 */
export async function landDownload(
  download: LandingDownload,
  workspace: Pick<Workspace, "saveDownload" | "hasRoom">,
  told: (entry: {
    code: "laf:downloaded" | "laf:download_too_large" | "laf:download_failed";
    path?: string;
    bytes?: number;
  }) => void,
  failed: (reason: unknown) => void,
  clock?: Clock,
): Promise<void> {
  const room = watchRoom(
    () => workspace.hasRoom(),
    () => download.cancel(),
    clock,
  );
  try {
    const landed = await download.path();
    room.stop();
    const saved = await workspace.saveDownload(
      download.suggestedFilename(),
      landed,
    );
    told({ code: "laf:downloaded", path: saved.path, bytes: saved.bytes });
  } catch (error) {
    told({
      // By the workspace's own code: a download that never arrived is not one that was too big.
      code:
        room.ranOut() ||
        (error instanceof WorkspaceFileError &&
          error.code === "laf:file_too_large")
          ? "laf:download_too_large"
          : "laf:download_failed",
    });
    failed(error);
  } finally {
    room.stop();
    await download.delete().catch(() => undefined);
  }
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
    /*
     * INTO THE FOLDER OF THE LAST RUN TO SAY WHOSE FILES IT WRITES, as that stands when the file
     * starts to arrive (`shared/file-scope.ts`, `sessions.ts`). Where none has: the file is not
     * kept, and that is said — put in the main folder on a guess, a project's download would
     * outlive the project.
     */
    const scope = session.fileScope;
    if (!scope) {
      note(session, { code: "laf:download_failed" });
      log.error("download_not_saved", { bot: botId, reason: "no file scope" });
      void Promise.resolve(download.delete()).catch(() => undefined);
      return;
    }
    void landDownload(
      download,
      workspace.within(scope),
      (entry) => note(session, entry),
      (reason) => log.error("download_not_saved", { bot: botId, reason }),
    );
  });
}
