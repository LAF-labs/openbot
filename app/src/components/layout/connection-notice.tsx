import { useSyncExternalStore } from "react";
import { openConnectionCheck } from "@/components/help/connection-check-dialog";
import {
  isSocketLost,
  SOCKET_LOST,
  SOCKET_RECONNECTED,
  socketState,
} from "@/lib/channels/use-channel-events";
import { t } from "@/lib/i18n";

function subscribe(onChange: () => void): () => void {
  socketState.addEventListener(SOCKET_LOST, onChange);
  socketState.addEventListener(SOCKET_RECONNECTED, onChange);
  return () => {
    socketState.removeEventListener(SOCKET_LOST, onChange);
    socketState.removeEventListener(SOCKET_RECONNECTED, onChange);
  };
}

/**
 * One line, while the server is gone.
 *
 * MEASURED 2026-09-10 (audit A4, finding 3): during a fifteen-second API stop nothing on the screen
 * changed. Every upgrade costs the front door thirteen seconds (upgrade rehearsal, progress log),
 * and in the installed app there is no reload and no address bar, so silence reads as the app
 * having broken. This says what is true and what is being done about it — the socket is already
 * reconnecting on its own backoff — and goes away the moment it succeeds.
 *
 * A pill rather than a bar, floated over the top edge: the shell's title row is a drag region and
 * a strip across it would move the window's handle.
 *
 * AND ONE THING TO PRESS: 연결 점검. Waiting is usually the answer, but not when it is this device's
 * network that went, and the pill cannot tell which — the check can. The pill itself still lets
 * every press through to the handle beneath it; only the button takes one.
 *
 * `w-max`, because a box placed at `left: 50%` is laid out in the half of the window to the right of
 * that line: measured at 390px, the pill was 195px wide and broke onto two lines with room to spare.
 */
export const ConnectionNotice = () => {
  const lost = useSyncExternalStore(subscribe, isSocketLost, () => false);
  if (!lost) return null;
  return (
    <div className="-translate-x-1/2 pointer-events-none fixed top-2 left-1/2 z-50 flex w-max max-w-[calc(100vw-1rem)] items-center gap-2 rounded-2xl bg-foreground px-3 py-1 text-background text-xs shadow-md">
      <span role="status">
        {t("The connection to the server was lost. Reconnecting…")}
      </span>
      <button
        className="pointer-events-auto shrink-0 font-medium underline underline-offset-2"
        onClick={openConnectionCheck}
        type="button"
      >
        {t("Connection check")}
      </button>
    </div>
  );
};
