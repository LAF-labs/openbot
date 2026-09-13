import { useSyncExternalStore } from "react";
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
 */
export const ConnectionNotice = () => {
  const lost = useSyncExternalStore(subscribe, isSocketLost, () => false);
  if (!lost) return null;
  return (
    <div
      className="-translate-x-1/2 pointer-events-none fixed top-2 left-1/2 z-50 rounded-full bg-foreground px-3 py-1 text-background text-xs shadow-md"
      role="status"
    >
      {t("The connection to the server was lost. Reconnecting…")}
    </div>
  );
};
