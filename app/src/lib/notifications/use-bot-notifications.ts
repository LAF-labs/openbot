import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  CHANNEL_ACTIVITY,
  type ChannelActivity,
  channelActivity,
} from "@/lib/channels/use-channel-events";
import { openQuestions, watchQuestions } from "@/lib/approvals";
import {
  notificationSupport,
  shouldNotify,
  shouldNotifyApproval,
  showApprovalNotice,
  showBotNotice,
} from "@/lib/notifications/bot-notifications";

/**
 * The room on screen, from the path.
 *
 * The first segment only. A route under a channel — anything this app grows later — would
 * otherwise be read as a channel id nothing matches, and every reply in the room the person was
 * actually looking at would raise a notification for the room they were looking at.
 */
export function openChannelFrom(pathname: string): string | null {
  if (!pathname.startsWith("/channel/")) return null;
  const [id] = pathname.slice("/channel/".length).split("/");
  return id ? decodeURIComponent(id) : null;
}

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
      const open = openChannelFrom(pathRef.current);
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

  /*
   * AND THE LEADING CASE: a Bot that has stopped and is waiting on a person.
   *
   * "What is blocked on you leads" is the rule this fork wrote down for the approval buzz, and it
   * is the one thing here with a deadline — the server expires an unanswered question after ten
   * minutes and the Bot gives up. It does not ride the socket and should not: the question is
   * raised by a tool call in this very tab, which already holds the Bot, the id and the sentence.
   * A server round trip to be told what this browser said one line earlier would be a slower way
   * to learn nothing new.
   *
   * Each question is announced once. `watchQuestions` fires on every open AND every close, so
   * without the seen-set an answered question would re-announce every one still waiting behind it.
   */
  useEffect(() => {
    const announced = new Set<string>();
    return watchQuestions(() => {
      if (notificationSupport() !== "granted") return;
      const visible = document.visibilityState === "visible";
      for (const question of openQuestions()) {
        if (announced.has(question.approvalId)) continue;
        const bot = rosterRef.current?.find(
          (profile) => profile.id === question.botId,
        );
        if (!shouldNotifyApproval({ notify: bot?.notify, visible })) continue;
        announced.add(question.approvalId);
        showApprovalNotice(
          question.approvalId,
          bot?.name ?? question.botId,
          question.question,
        );
      }
    });
  }, []);
}
