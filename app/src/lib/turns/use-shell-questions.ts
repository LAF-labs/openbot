import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  SOCKET_RECONNECTED,
  socketState,
} from "@/lib/channels/use-channel-events";
import {
  NOTIFICATION_FRAME,
  type NotificationFrame,
  notificationFrames,
} from "@/lib/notifications/outbox";
import { watchShellQuestions } from "./questions";

/**
 * The questions the person's Bot is waiting on, known on every signed-in screen.
 *
 * Mounted once, in `_authed`, beside the notices. One watch per Bot the person owns and has not put
 * away — one, for everybody since 2026-09-24, and several only for an account that kept them. What
 * asks it to look is in `watchShellQuestions`; this is where those moments come from.
 */
export function useShellQuestions(): void {
  const agents = useQuery(agentListQueryOptions());
  // As one string, so the effect below restarts when the set of Bots changes and not on every read.
  const botIds = (agents.data ?? [])
    .filter((bot) => bot.mine && !bot.hidden)
    .map((bot) => bot.id)
    .join(",");

  useEffect(() => {
    const ids = botIds.split(",").filter(Boolean);
    if (ids.length === 0) return;
    const watches = new Map(
      ids.map((botId) => [botId, watchShellQuestions({ botId })] as const),
    );
    const lookAll = () => {
      for (const watch of watches.values()) watch.look();
    };
    // The outbox says something happened to a Bot — it asked, a question ran out, a run ended.
    const onFrame = (event: Event) => {
      const frame = (event as CustomEvent<NotificationFrame>).detail;
      watches.get(frame.botId)?.look();
    };
    // A window nobody was looking at ran its timers about once a minute, if at all.
    const onVisible = () => {
      if (document.visibilityState === "visible") lookAll();
    };
    notificationFrames.addEventListener(NOTIFICATION_FRAME, onFrame);
    socketState.addEventListener(SOCKET_RECONNECTED, lookAll);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      notificationFrames.removeEventListener(NOTIFICATION_FRAME, onFrame);
      socketState.removeEventListener(SOCKET_RECONNECTED, lookAll);
      document.removeEventListener("visibilitychange", onVisible);
      for (const watch of watches.values()) watch.dispose();
    };
  }, [botIds]);
}
