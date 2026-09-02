import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  describeSubject,
  openQuestions,
  watchQuestions,
} from "@/lib/approvals";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  CHANNEL_ACTIVITY,
  type ChannelActivity,
  channelActivity,
} from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { t } from "@/lib/i18n";
import {
  decideNotice,
  type NoticeRequest,
  notificationSupport,
  setUnreadBadge,
  showNotice,
  throttleKey,
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
 * Interrupt somebody when a Bot needs them, or has finished while they were elsewhere.
 *
 * Both kinds go through one decider (`decideNotice`), which is the shape the reference product uses
 * and the reason its rules cannot drift apart: the mute, the hidden check and the throttle are
 * written once and are therefore true of both. The throttle is not decoration — one turn in this
 * app is several runs on the wire whenever the Bot touches its computer, so the activity events
 * arrive in a burst, and without it a single errand would leave a row of notifications.
 *
 * It rides the socket the roster already keeps open (`useChannelEvents`), through the same
 * re-broadcast the open transcript listens on. One socket, three listeners: the roster patches its
 * cache, the room appends the message, and this decides whether to interrupt anybody.
 *
 * Mounted once, in `_authed`, so it covers every signed-in screen.
 */
export function useBotNotifications(): void {
  const agents = useQuery(agentListQueryOptions());
  const channels = useQuery(channelListQueryOptions());
  const navigate = useNavigate();
  const location = useLocation();

  /*
   * The roster, the path and the navigate in refs: the listeners are attached once and outlive the
   * render that attached them. Reading any of them from the closure would pin them to what they
   * were while the roster was still loading — "no Bots", "no room open" — so every event would look
   * notifiable and none would know the Bot's name.
   */
  const rosterRef = useRef(agents.data);
  rosterRef.current = agents.data;
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  /** Last delivery per `${agentId}:${kind}`. Lives as long as the app does, like the socket. */
  const lastNotified = useRef(new Map<string, number>());

  /** The one place a notice can be raised, so nothing can be raised around the rules. */
  const raise = useRef(
    (
      request: NoticeRequest,
      notice: { title: string; body: string; tag: string },
      onClick: () => void,
    ) => {
      if (notificationSupport() !== "granted") return;
      const key = throttleKey(request);
      if (decideNotice(request, lastNotified.current.get(key)) !== "deliver") {
        return;
      }
      lastNotified.current.set(key, request.now);
      showNotice(request.kind, notice, onClick);
    },
  );

  useEffect(() => {
    const onActivity = (event: Event) => {
      const activity = (event as CustomEvent<ChannelActivity>).detail;
      // A person's own message is never news: a room is not unread for what you said in it.
      const agentId = activity.lastMessageAgentId;
      if (!agentId) return;
      const bot = rosterRef.current?.find((profile) => profile.id === agentId);

      raise.current(
        {
          kind: "finished",
          agentId,
          notify: bot?.notify,
          hidden: bot?.hidden,
          visible: document.visibilityState === "visible",
          openChannelId: openChannelFrom(pathRef.current),
          channelId: activity.channelId,
          now: Date.now(),
        },
        {
          // The Bot's name, not the room's: a group room's title is a list of names, and the one
          // that matters is whoever just spoke.
          title: bot?.name ?? activity.name,
          body: activity.lastMessage ?? "",
          tag: `laf-channel:${activity.channelId}`,
        },
        () => {
          void navigateRef.current({
            params: { channelId: activity.channelId },
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
   * It does not ride the socket and should not — the question is raised by a tool call in this very
   * tab, which already holds the Bot, the id and the sentence. A server round trip to be told what
   * this browser said one line earlier would be a slower way to learn nothing new.
   *
   * Each question is announced at most once. `watchQuestions` fires on every open AND every close,
   * so without the seen-set an answered question would re-announce every one still waiting behind
   * it — and the throttle would not catch that, because those questions are seconds apart.
   */
  useEffect(() => {
    const announced = new Set<string>();
    return watchQuestions(() => {
      for (const question of openQuestions()) {
        if (announced.has(question.approvalId)) continue;
        const bot = rosterRef.current?.find(
          (profile) => profile.id === question.botId,
        );
        announced.add(question.approvalId);
        raise.current(
          {
            kind: "needs-you",
            agentId: question.botId,
            notify: bot?.notify,
            hidden: bot?.hidden,
            visible: document.visibilityState === "visible",
            now: Date.now(),
          },
          {
            title: t("{name} needs you", { name: bot?.name ?? question.botId }),
            // Written here, from the facts, like the card the person will land on — a lock screen is
            // no place to discover that one surface says it differently.
            body: question.subject
              ? describeSubject(question.subject)
              : t("It is waiting on your answer."),
            tag: `laf-approval:${question.approvalId}`,
          },
          () => {},
        );
      }
    });
  }, []);

  /*
   * The number on the app's own icon, which is the one notification that survives the tab being
   * closed and reopened. Counted from the roster the sidebar already holds, so it costs no request.
   * A muted Bot still counts — muting silences the popup, not the fact that something is waiting.
   */
  useEffect(() => {
    const hidden = new Set(
      (agents.data ?? [])
        .filter((profile) => profile.hidden)
        .map((profile) => profile.id),
    );
    const waiting = (channels.data ?? []).filter(
      (channel) =>
        channel.unread && !channel.agentIds.every((id) => hidden.has(id)),
    ).length;
    setUnreadBadge(waiting, appConfig.brand.productName);
  }, [agents.data, channels.data]);
}
