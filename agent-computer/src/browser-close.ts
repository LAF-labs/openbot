/**
 * How the deployment's browser is ended, and how long each step of ending it is given.
 */
import type { BrowserContext } from "playwright";
import { log } from "./log";

/**
 * How long to let a closing browser finish writing before moving on.
 *
 * The profile's Cookies file may be rewritten shortly after `close()` is called. This delay stays
 * clear of that window while remaining inside the container's
 * 30s stop grace period, so a shutdown never becomes the reason a computer does not come back.
 */
const CLOSE_SETTLE_MS = 2_000;

/** A moment after the browser process is gone, for whatever it was still flushing. */
const FLUSH_SETTLE_MS = 250;

/**
 * How long a graceful close is given before the process is killed instead.
 *
 * Measured 2026-09-06 against 기업마당: a navigation that hit its 30s deadline left that Bot's
 * Chromium answering nothing at all — the next `goto` sat out its own deadline, `context.close()`
 * never returned, and because the launch path waits for a close in flight, every later call on that
 * Bot waited on it too. Stop, reset and ten idle minutes all queued behind the same promise. A close
 * that cannot finish in this long is not going to, and the kill below is what ends it.
 */
export const CLOSE_GRACE_MS = 3_000;

/** After a kill, how long the `disconnected` event is waited for before the profile is presumed free. */
const KILL_SETTLE_MS = 1_000;

/** How long a page-level recovery step (close the tab, open another) is given before the browser goes. */
export const RECYCLE_STEP_MS = 2_000;

export const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The slice of a context a close needs, so the bounded close can be tested without a browser. */
export type ClosableContext = Pick<BrowserContext, "close"> & {
  browser(): {
    isConnected(): boolean;
    once(event: "disconnected", handler: () => void): unknown;
  } | null;
};

/**
 * Close a context and wait for Chromium to actually be gone — or make it go.
 *
 * Chromium batches cookie writes and commits them as it exits, while `close()` only asks it to exit.
 * Bounded, because a shutdown that hangs must never be the reason a computer does not come back. We
 * would rather lose the last few seconds of cookies than never restart.
 *
 * THE EXIT IS WAITED FOR, NOT ASSUMED. This used to sleep two seconds flat, on the stated grounds
 * that a persistent context exposes no exit signal — but `context.browser()` is not null in this
 * Playwright version (measured), so `disconnected` is exactly that signal. It matters more now that
 * a browser also closes on its own once every Bot has gone idle: returning from a close before the
 * process has released the profile directory is how two Chromiums end up on one user-data-dir, and
 * the second one comes up in a state where every call hangs until its timeout.
 *
 * AND THE CLOSE ITSELF IS BOUNDED, which it was not. `context.close()` was awaited without a limit
 * on the assumption that a browser asked to exit exits; a Chromium wedged mid-navigation does not,
 * and everything for that Bot then waited for ever (see CLOSE_GRACE_MS). So: ask nicely, wait the
 * grace, and if the browser is still connected, kill the process by the id recorded at launch. The
 * profile directory is on disk either way; what a kill costs is the last few seconds of cookies.
 */
export async function closeAndWait(
  context: ClosableContext,
  process: { pid: number | null; kill?: (pid: number) => void } = {
    pid: null,
  },
): Promise<void> {
  const browser = context.browser();
  const gone = browser
    ? new Promise<void>((resolve) => {
        browser.once("disconnected", () => resolve());
      })
    : null;
  const asked = context.close().catch(() => undefined);
  await Promise.race([asked, wait(CLOSE_GRACE_MS)]);
  if (browser?.isConnected()) {
    log.warn("computer_close_hung", {
      pid: process.pid,
      graceMs: CLOSE_GRACE_MS,
    });
    if (process.pid !== null) {
      try {
        (process.kill ?? killProcess)(process.pid);
      } catch {
        // Already gone between the check and the kill; nothing to end.
      }
    }
    // With no pid there is nothing more to do than not wait: the caller gets its answer and the
    // launch path's lock sweep takes its chances, which is what it did before this existed.
    if (gone) await Promise.race([gone, wait(KILL_SETTLE_MS)]);
    await wait(FLUSH_SETTLE_MS);
    return;
  }
  if (gone) {
    await Promise.race([gone, wait(CLOSE_SETTLE_MS)]);
    await wait(FLUSH_SETTLE_MS);
    return;
  }
  await wait(CLOSE_SETTLE_MS);
}

/** SIGKILL, not SIGTERM: a Chromium that ignored a graceful close is not going to honour a signal it may handle. */
function killProcess(pid: number): void {
  globalThis.process.kill(pid, "SIGKILL");
}

/**
 * The operating-system id of the browser behind a context, read the moment it starts.
 *
 * Playwright exposes no process for a persistent context, but the browser will say its own pid over
 * CDP. Asked once, at launch, while the browser is certainly answering: by the time a kill is needed
 * it no longer is, which is the whole point of asking early. Null when it cannot be read — then a
 * hung close still returns after the grace, it just cannot end the process.
 */
export async function browserPidOf(
  context: BrowserContext,
): Promise<number | null> {
  try {
    const browser = context.browser();
    if (!browser) return null;
    const session = await browser.newBrowserCDPSession();
    const info = (await Promise.race([
      session.send("SystemInfo.getProcessInfo"),
      wait(RECYCLE_STEP_MS).then(() => null),
    ])) as { processInfo?: { type: string; id: number }[] } | null;
    await session.detach().catch(() => undefined);
    const main = info?.processInfo?.find((entry) => entry.type === "browser");
    return typeof main?.id === "number" ? main.id : null;
  } catch {
    return null;
  }
}
