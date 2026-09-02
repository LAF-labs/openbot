import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  askSubjectOf,
  describeSubject,
  openQuestions,
  watchQuestions,
} from "@/lib/approvals";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  CHANNEL_ACTIVITY,
  type ChannelActivity,
  channelActivity,
  SOCKET_RECONNECTED,
  socketState,
} from "@/lib/channels/use-channel-events";
import {
  destinationOf,
  markNotificationSeen,
  NOTIFICATION_FRAME,
  type NotificationFrame,
  notificationFrames,
  readNotifications,
} from "@/lib/notifications/outbox";
import { appConfig } from "@/lib/generated/application-config";
import { t } from "@/lib/i18n";
import {
  canRaiseNotice,
  decideNotice,
  type NoticeDestination,
  type NoticeKind,
  type NoticeRequest,
  notificationSupport,
  setUnreadBadge,
  showNotice,
  throttleKey,
} from "@/lib/notifications/bot-notifications";
import { inShell } from "@/lib/notifications/shell";

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
 * Which of the two interruptions an outbox row is, or neither.
 *
 * The mapping is the field rule, one line per clause: blocked on you leads, finished follows, and
 * everything else stays out of the way. `approval.expired` is the deliberate "neither" — a question
 * that has run out cannot be answered, so a notice about it would be an interruption a person can
 * do nothing with. The row still exists and the list still shows it.
 *
 * An unknown kind is also "neither": a newer server may send a word this build has never heard, and
 * the honest thing to do with a notification you cannot phrase is to leave it in the list.
 */
export function noticeKindOf(event: string): NoticeKind | null {
  if (event === "approval.requested" || event === "run.needs_you") {
    return "needs-you";
  }
  if (event === "run.finished" || event === "run.failed") return "finished";
  return null;
}

/**
 * The line under the title, from the facts.
 *
 * Written here, the same way the card the person will land on is written, because a lock screen is
 * no place to discover that one surface says it differently. `described` is the subject already put
 * into words by `describeSubject`, when there was a subject at all.
 */
export function bodyFor(event: string, described: string | null): string {
  if (described) return described;
  if (event === "run.finished") return t("It finished while you were away.");
  if (event === "run.failed") return t("It stopped before it finished.");
  // A password, a code from a text message, a login it cannot finish. The row deliberately carries
  // no detail — what the Bot called the field is text off somebody's page — so the line says only
  // what is true of all of them, which is that nobody else can do this part.
  if (event === "run.needs_you") {
    return t("It needs something only you can give.");
  }
  return t("It is waiting on your answer.");
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
  /**
   * What has already been said out loud, so the two paths below cannot say it twice.
   *
   * A question raised by a tool call in THIS tab is announced from the tab (the effect at the
   * bottom, which has the Bot, the id and the facts one line after they exist) and then arrives
   * again as an outbox frame moments later. Keyed on the approval where there is one, so the two
   * paths recognise each other's work; on the row's own id otherwise. The five-second throttle
   * would not catch this — it is per Bot and per kind, and two questions seconds apart are two
   * different things worth saying.
   */
  const announced = useRef(new Set<string>());

  /** The one place a notice can be raised, so nothing can be raised around the rules. */
  const raise = useRef(
    (
      request: NoticeRequest,
      notice: {
        title: string;
        body: string;
        tag: string;
        /** Absent for the one interruption that has no page of its own. See `showNotice`. */
        destination?: NoticeDestination;
      },
      onClick: () => void,
    ) => {
      // Read each time rather than once on mount: permission can be granted while the app is open.
      // `canRaiseNotice` is where the webview stops being asked about the shell.
      if (
        !canRaiseNotice({
          inShell: inShell(),
          browser: notificationSupport(),
        })
      ) {
        return;
      }
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
          destination: { kind: "channel", id: activity.channelId },
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
    return watchQuestions(() => {
      for (const question of openQuestions()) {
        if (announced.current.has(question.approvalId)) continue;
        const bot = rosterRef.current?.find(
          (profile) => profile.id === question.botId,
        );
        announced.current.add(question.approvalId);
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
            destination: { kind: "approve", id: question.approvalId },
          },
          /*
           * The full-page view of this one question, which exists so that a notice has somewhere to
           * land. It used to be an empty function: a notification about the one thing in this
           * product that is blocked on a person did nothing whatsoever when they clicked it, and
           * the card it was about was a row somewhere in a transcript they then had to find.
           */
          () => {
            void navigateRef.current({
              params: { approvalId: question.approvalId },
              to: "/approve/$approvalId",
            });
          },
        );
      }
    });
  }, []);

  /*
   * AND EVERYTHING THAT HAPPENED WHERE THIS TAB COULD NOT SEE IT.
   *
   * The effect above is the fast path and only that: it hears a question raised by a tool call in
   * this very tab. A question raised by a routine at seven in the morning, by a room turn running on
   * the server, or in the other window, was heard by nothing — the page had no channel to the fact
   * that a Bot somewhere was waiting. The server's outbox is that channel.
   *
   * THE FRAME IS THE NUDGE AND THE ENDPOINT IS THE TRUTH, which is the rule the roster follows and
   * the reason the socket is allowed to miss things. So a frame does not carry the work: it causes a
   * read of `GET /api/me/notifications`, and so does a reconnect, and so does mounting. The mount
   * read raises nothing — the person has just arrived and is looking at the screen; it is there to
   * seed the watermark so a backlog does not shout on every page load.
   */
  useEffect(() => {
    /** The newest row this page has taken account of, so a read asks only for what is after it. */
    let watermark: string | undefined;
    let stopped = false;

    const catchUp = async (options: { raises: boolean }) => {
      const rows = await readNotifications(watermark);
      // Null is "the server could not be asked", which is not "nothing is waiting". Leaving the
      // watermark alone means the next read covers the same ground rather than skipping it.
      if (!rows || stopped) return;
      // Oldest first, so that when several arrive at once the notice left on screen is the newest.
      for (const row of [...rows].reverse()) {
        if (!watermark || row.at > watermark) watermark = row.at;
        const key = row.approvalId ?? row.id;
        if (!options.raises) {
          announced.current.add(key);
          continue;
        }
        raiseFromOutbox(row);
      }
    };

    const raiseFromOutbox = (frame: NotificationFrame) => {
      const key = frame.approvalId ?? frame.id;
      if (announced.current.has(key)) return;
      const kind = noticeKindOf(frame.event);
      // An expired question is deliberately silent. Nobody can answer a question that has run out,
      // and the two things worth interrupting somebody for are being blocked and having finished.
      // It is still a row, and the list still shows it.
      if (!kind) return;
      // May be nothing: a Bot asking for a password is blocked on the person and has no page of its
      // own to send them to. See `showNotice`, which takes the destination as optional for this.
      const destination = destinationOf(frame);
      announced.current.add(key);

      const bot = rosterRef.current?.find(
        (profile) => profile.id === frame.botId,
      );
      const subject = askSubjectOf(frame.subject);
      raise.current(
        {
          kind,
          agentId: frame.botId,
          notify: bot?.notify,
          hidden: bot?.hidden,
          visible: document.visibilityState === "visible",
          openChannelId: openChannelFrom(pathRef.current),
          ...(frame.channelId ? { channelId: frame.channelId } : {}),
          now: Date.now(),
        },
        {
          title:
            kind === "needs-you"
              ? t("{name} needs you", { name: bot?.name ?? frame.botId })
              : (bot?.name ?? frame.botId),
          body: bodyFor(frame.event, subject ? describeSubject(subject) : null),
          tag: `laf-notification:${key}`,
          ...(destination ? { destination } : {}),
        },
        () => {
          // Acting on it is the moment it has actually been seen — not the moment it was shown.
          void markNotificationSeen(frame.id);
          // Nowhere to go: bringing the window forward is the whole of what a click can do, and it
          // is what somebody whose Bot is waiting for a password actually needed.
          if (!destination) return;
          if (destination.kind === "approve") {
            void navigateRef.current({
              params: { approvalId: destination.id },
              to: "/approve/$approvalId",
            });
            return;
          }
          void navigateRef.current({
            params: { channelId: destination.id },
            to: "/channel/$channelId",
          });
        },
      );
    };

    void catchUp({ raises: false });
    const onFrame = () => {
      void catchUp({ raises: true });
    };
    notificationFrames.addEventListener(NOTIFICATION_FRAME, onFrame);
    // A reconnect is the one moment this page knows it may have missed frames. See `events.ts`.
    socketState.addEventListener(SOCKET_RECONNECTED, onFrame);
    return () => {
      stopped = true;
      notificationFrames.removeEventListener(NOTIFICATION_FRAME, onFrame);
      socketState.removeEventListener(SOCKET_RECONNECTED, onFrame);
    };
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
