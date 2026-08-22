import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  CHANNEL_ACTIVITY,
  type ChannelActivity,
  channelActivity,
} from "@/lib/channels/use-channel-events";
import {
  notificationSupport,
  shouldNotify,
  showBotNotice,
} from "@/lib/notifications/bot-notifications";

/**
 * Raise a browser notification when a Bot speaks in a room nobody is reading.
 *
 * It rides the socket the roster already keeps open (`useChannelEvents`), through the same
 * re-broadcast the open transcript listens on. One socket, three listeners: the roster patches its
 * cache, the room appends the message, and this decides whether to interrupt anybody. A second
 * connection for notifications would have been a second thing to reconnect and a second thing to
 * get out of step with the first.
 *
 * Mounted once, beside `useChannelEvents`.
 */
export function useBotNotifications(): void {
  const agents = useQuery(agentListQueryOptions());
  const navigate = useNavigate();
  const location = useLocation();

  /*
   * Both in refs: the listener is attached once and outlives the render that attached it. Reading
   * the roster or the current path from the closure would pin them to whatever they were when the
   * roster was still loading — which is "no Bots" and "no room open", so every event would look
   * notifiable and none would know the Bot's name.
   */
  const rosterRef = useRef(agents.data);
  rosterRef.current = agents.data;
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const onActivity = (event: Event) => {
      const activity = (event as CustomEvent<ChannelActivity>).detail;
      if (notificationSupport() !== "granted") return;

      const bot = rosterRef.current?.find(
        (profile) => profile.id === activity.lastMessageAgentId,
      );
      const open = pathRef.current.startsWith("/channel/")
        ? decodeURIComponent(pathRef.current.slice("/channel/".length))
        : null;
      if (
        !shouldNotify({
          agentId: activity.lastMessageAgentId,
          notify: bot?.notify,
          openChannelId: open,
          channelId: activity.channelId,
          visible: document.visibilityState === "visible",
        })
      ) {
        return;
      }

      showBotNotice(
        {
          // The Bot's name, not the room's: a group room's title is a list of names, and the one
          // that matters is whoever just spoke.
          title: bot?.name ?? activity.name,
          body: activity.lastMessage ?? "",
          channelId: activity.channelId,
        },
        (channelId) => {
          void navigateRef.current({
            params: { channelId },
            to: "/channel/$channelId",
          });
        },
      );
    };

    channelActivity.addEventListener(CHANNEL_ACTIVITY, onActivity);
    return () =>
      channelActivity.removeEventListener(CHANNEL_ACTIVITY, onActivity);
  }, []);
}
