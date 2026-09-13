import { useEffect, useState } from "react";
import {
  SOCKET_RECONNECTED,
  socketState,
} from "@/lib/channels/use-channel-events";
import {
  NOTIFICATION_FRAME,
  type NotificationFrame,
  notificationFrames,
} from "@/lib/notifications/outbox";
import { pokeControl, watchControl } from "./control-poll";

/**
 * Whether a Bot is stopped and waiting on a person — the wheel requested, or a secret asked for —
 * so a closed screen pane can say so.
 *
 * NO LOOP OF ITS OWN ANY MORE. This was a bare `setInterval` at three seconds, the one poll in the
 * app that ignored a hidden tab: measured 2026-09-10 (audit A4, finding 4) at twenty requests a
 * minute on an idle conversation, and eighteen in fifty-four seconds with the tab hidden. The
 * answer it wanted travels two other ways already, both of which it now listens to:
 *
 *  - the shared control loop (`control-poll.ts`), which the computer cards use, settles once the
 *    state stops changing and is woken by anything in this tab that touches the wheel; and
 *  - the outbox, whose `notification` frames the socket carries for a Bot stopped by a routine or
 *    a room turn on the server — the cases no poll in this tab could have caused.
 *
 * So the loop is read while it runs, and poked when a frame for this Bot arrives, when the socket
 * comes back, and when the tab is looked at again. An idle conversation costs nothing.
 */
export function useNeedsYou(botId: string | undefined, when: boolean): boolean {
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    if (!botId || !when) {
      setNeeded(false);
      return;
    }

    const stop = watchControl(botId, {
      isLive: () => false,
      onState: (state) =>
        setNeeded(Boolean(state.requested || state.secretWanted !== undefined)),
    });
    const wake = () => pokeControl(botId);
    const onFrame = (event: Event) => {
      if ((event as CustomEvent<NotificationFrame>).detail.botId === botId)
        wake();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") wake();
    };
    notificationFrames.addEventListener(NOTIFICATION_FRAME, onFrame);
    socketState.addEventListener(SOCKET_RECONNECTED, wake);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      notificationFrames.removeEventListener(NOTIFICATION_FRAME, onFrame);
      socketState.removeEventListener(SOCKET_RECONNECTED, wake);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [botId, when]);

  return needed;
}
