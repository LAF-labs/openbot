import { useSyncExternalStore } from "react";
import { openConnectionCheck } from "@/components/help/connection-check-dialog";
import { LiveRegion } from "@/components/layout/live-region";
import {
  SOCKET_TROUBLE,
  socketState,
  socketTrouble,
} from "@/lib/channels/use-channel-events";
import { t } from "@/lib/i18n";

function subscribe(onChange: () => void): () => void {
  socketState.addEventListener(SOCKET_TROUBLE, onChange);
  return () => {
    socketState.removeEventListener(SOCKET_TROUBLE, onChange);
  };
}

function subscribeOnline(onChange: () => void): () => void {
  globalThis.addEventListener?.("online", onChange);
  globalThis.addEventListener?.("offline", onChange);
  return () => {
    globalThis.removeEventListener?.("online", onChange);
    globalThis.removeEventListener?.("offline", onChange);
  };
}

/**
 * Whether this device says it has a network at all.
 *
 * Only its "no" is worth anything: a browser reports online whenever there is an interface up,
 * including a café's Wi-Fi that reaches nothing. So "offline" is believed — the person's own
 * connection is the thing to check — and "online" only means the other sentence applies.
 */
export function useIsOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => globalThis.navigator?.onLine !== false,
    () => true,
  );
}

/**
 * One line, while the server is gone — or while this device has no network.
 *
 * MEASURED 2026-09-10 (audit A4, finding 3): during a fifteen-second API stop nothing on the screen
 * changed. Every upgrade costs the front door thirteen seconds (upgrade rehearsal, progress log),
 * and in the installed app there is no reload and no address bar, so silence reads as the app
 * having broken. This says what is true and what is being done about it — the socket is already
 * reconnecting on its own backoff — and goes away the moment it succeeds.
 *
 * TWO DIFFERENT THINGS TO DO, SO TWO SENTENCES (UI/UX audit 0.5.3, item 6). A shop whose Wi-Fi
 * dropped was told the SERVER was gone and to wait, when the one thing that would help is on their
 * side of the counter. When the device itself says it is offline, the line says to check the
 * internet connection; otherwise it is the server, reconnecting.
 *
 * A pill rather than a bar, floated over the top edge: the shell's title row is a drag region and
 * a strip across it would move the window's handle.
 *
 * AND ONE THING TO PRESS: 연결 점검. Waiting is usually the answer, but not when it is this device's
 * network that went, and the pill cannot always tell which — the check can. The pill itself still
 * lets every press through to the handle beneath it; only the button takes one.
 *
 * `w-max`, because a box placed at `left: 50%` is laid out in the half of the window to the right of
 * that line: measured at 390px, the pill was 195px wide and broke onto two lines with room to spare.
 *
 * ONLY WHEN IT IS REALLY A PROBLEM (P1, 2026-09-26). The socket now finds a dead connection itself —
 * after a sleep, a Wi-Fi change — and replaces it within a second; a pill for that second would be
 * the app reporting a problem it had already solved. So it appears after two seconds of loss, and
 * after thirty says that it has been a while (`SocketTrouble` in `use-channel-events.ts`).
 */
export const ConnectionNotice = () => {
  const trouble = useSyncExternalStore(
    subscribe,
    socketTrouble,
    () => "none" as const,
  );
  const isOnline = useIsOnline();
  const sentence = !isOnline
    ? t("The internet connection is down. Check your connection.")
    : trouble === "slow"
      ? t("The server has not answered for a while. Still reconnecting…")
      : trouble === "lost"
        ? t("The connection to the server was lost. Reconnecting…")
        : null;
  return (
    <>
      {/*
       * SAID, NOT ONLY SHOWN. The pill below is drawn only while the connection is gone, and a
       * status line that arrives with its words is not announced — so the loss was seen and never
       * heard. This region is mounted with the shell and speaks when the connection drops.
       */}
      <LiveRegion className="sr-only">{sentence}</LiveRegion>
      {sentence ? (
        <div className="-translate-x-1/2 pointer-events-none fixed top-2 left-1/2 z-50 flex w-max max-w-[calc(100vw-1rem)] items-center gap-2 rounded-2xl bg-foreground px-3 py-1 text-background text-xs shadow-md">
          <span>{sentence}</span>
          <button
            className="pointer-events-auto shrink-0 font-medium underline underline-offset-2"
            onClick={openConnectionCheck}
            type="button"
          >
            {t("Connection check")}
          </button>
        </div>
      ) : null}
    </>
  );
};
