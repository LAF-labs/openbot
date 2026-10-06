import { useEffect } from "react";
import { usePresence } from "@/components/channels/use-presence";
import { DownloadNotice } from "@/components/layout/download-notice";
import { useMyBots } from "@/lib/agents/my-bots";
import {
  holdShellAwake,
  setShellStatus,
  shellStatusOf,
} from "@/lib/notifications/shell";

/** How long the Bot's status has to hold before the tray is told. */
const STATUS_SETTLE_MS = 1_500;

/**
 * What the installed app's page keeps in step with its shell, on every signed-in screen.
 *
 * Mounted only inside the shell (`_authed.tsx`), so a browser tab pays for none of it:
 *
 *  - THE TRAY'S STATUS — the same answer as the pill under the Bot's face (`usePresence`), sent as
 *    one of three codes. Here rather than beside the pill, because the pill is drawn only on the
 *    screens with a sidebar, and a tray still saying 일하는 중 while somebody reads Settings after
 *    the Bot finished would be the one lie the tray line exists to prevent.
 *  - STAYING AWAKE on Windows, where WebView2 has no background-throttling switch
 *    (`holdShellAwake`).
 *  - THE DOWNLOAD NOTICE: a webview saves a file and draws nothing, so the shell says when one has
 *    ended and this says it on screen (`DownloadNotice`).
 *
 * THE UPDATE NOTICE WAS HERE until 2026-10-06, a card in the corner below. A newer shell is said by
 * the one control that says a newer page (`update-notice.tsx`), at the foot of the Bot's column,
 * and it reads for itself whether the Bot is busy.
 *
 * The first of the person's Bots: there is one (docs/laf/deployment-model.md). An account from
 * before 2026-09-24 with several shows the first one's status, as its sidebar leads with it.
 */
export function ShellSync() {
  const { bots } = useMyBots();
  const presence = usePresence(bots?.[0]?.id);
  const status = shellStatusOf(presence.kind);

  /*
   * SETTLED BEFORE IT IS SENT. Opening the conversation says "working" for a moment while it joins
   * the thread (measured: 일하는 중 then 쉬는 중 within the same second on every load), and a
   * menu-bar dot that blinks green each time the window is opened is a dot nobody trusts. A tray is
   * read at a glance, not a frame, so the status waits this long to be sure.
   */
  useEffect(() => {
    const settled = setTimeout(() => {
      void setShellStatus(status);
    }, STATUS_SETTLE_MS);
    return () => clearTimeout(settled);
  }, [status]);

  useEffect(() => {
    holdShellAwake();
    // Signed out, or the screen went: nothing here can still say the Bot is busy.
    return () => {
      void setShellStatus("idle");
    };
  }, []);

  /*
   * ONE CORNER, ONE STACK. Each card used to fix itself to the corner, which is right for one card
   * and draws the second over the first. The corner is held here and the cards stack inside it;
   * it takes no clicks of its own, so an empty corner is not a patch of the screen that is dead.
   * (One card stacks in it since 2026-10-06; the corner is kept for the next thing a shell says.)
   */
  return (
    <div className="pointer-events-none fixed top-16 right-4 z-40 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      <DownloadNotice />
    </div>
  );
}
