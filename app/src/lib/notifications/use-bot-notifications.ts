import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";
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
  routinesChangedBy,
} from "@/lib/notifications/outbox";
import { appConfig } from "@/lib/generated/application-config";
import { t } from "@/lib/i18n";
import { josa } from "@/lib/josa";
import { routineKeys } from "@/lib/routines/queries";
import { pausedCountOf, UNREAD_PAUSE_SENTENCES } from "@/lib/routines/unread";
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
import { questionThread } from "@/lib/turns/questions";

/**
 * The title of the notice that a Bot is stopped and waiting, with the particle that fits its name.
 *
 * MEASURED 2026-09-10 (audit A4, finding 7): the lock screen said "닻이(가) 기다립니다" — the
 * form-letter spelling, in the first sentence a person ever sees this product say outside the app.
 * `lib/josa.ts` existed for exactly this and the entries that carry a Bot's name had been left out.
 *
 * ONE FUNCTION FOR EVERY PLACE THE SENTENCE IS SAID — both notice paths and the `/approve` page they
 * land on. The dictionary entry now has a `{josa}` slot, and `t()` leaves a slot nobody filled as
 * the literal text `{josa}`: a third caller spelling the call out by hand is how "닻{josa}
 * 기다립니다" would reach a screen.
 */
export function needsYouTitle(name: string): string {
  return t("{name} needs you", { name, josa: josa(name, "이/가") });
}

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
 * Whether the screen in front of the person is one that draws this question.
 *
 * Two screens do: the conversation it was raised in, where the card sits on the line of the call
 * that raised it, and the page a notice opens for one question. Every other screen has the pill and
 * the sidebar's 기다리는 일 at most, and a pill changing colour at the edge of what somebody is reading
 * is not them being asked.
 *
 * THE CONVERSATION IT WAS RAISED IN, NOT ANY CONVERSATION WITH THE BOT. An account that kept what it
 * had before the limit can hold several with one Bot, and each draws only its own thread's cards:
 * being in one of them is not looking at a question raised in another (review of this change, first
 * round). `threadId` is the question's conversation when the server's record has said; without it,
 * a Bot with one conversation can only mean that one, and a Bot with several is not guessed at.
 *
 * While the list of conversations has not been read at all, an open conversation is taken as the
 * right one: staying quiet for that moment is the smaller mistake than interrupting somebody who is
 * looking at the card. A list that HAS been read and does not hold the open one is another matter —
 * the compose screen (`/channel/new`), a conversation that is gone — and no card is drawn there.
 */
export function isCardOnScreen(input: {
  pathname: string;
  botId: string;
  approvalId?: string | undefined;
  /** The conversation the question was raised in, when known. */
  threadId?: string | undefined;
  channels:
    | readonly { id: string; agentIds: readonly string[]; threadId: string }[]
    | undefined;
}): boolean {
  if (
    input.approvalId &&
    input.pathname === `/approve/${encodeURIComponent(input.approvalId)}`
  ) {
    return true;
  }
  const open = openChannelFrom(input.pathname);
  if (!open) return false;
  if (!input.channels) return true;
  const channel = input.channels.find((entry) => entry.id === open);
  if (!channel?.agentIds.includes(input.botId)) return false;
  if (input.threadId) return channel.threadId === input.threadId;
  return (
    input.channels.filter((entry) => entry.agentIds.includes(input.botId))
      .length === 1
  );
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
  /*
   * A pause the unread rule made (`routine.paused`) is quiet like a finish: nobody is blocked, and
   * something the person set going has stopped without their pressing anything — news, not a
   * question. The words are its own (`pausedBody`).
   */
  if (
    event === "run.finished" ||
    event === "run.failed" ||
    event === "routine.paused"
  ) {
    return "finished";
  }
  return null;
}

/**
 * The line under a `routine.paused` notice: how many of the Bot's routines stopped, and why.
 *
 * The count is the server's; a row whose facts cannot be read still says what happened, without a
 * number made up for it.
 */
export function pausedBody(pause: unknown): string {
  const count = pausedCountOf(pause);
  return count === null
    ? t("Some routines were paused — their results went unread for a while.")
    : t(UNREAD_PAUSE_SENTENCES.notice, { count });
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
  if (event === "routine.paused") return pausedBody(null);
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
  const queryClient = useQueryClient();
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
  const channelsRef = useRef(channels.data);
  const pathRef = useRef(location.pathname);
  const navigateRef = useRef(navigate);
  const queryClientRef = useRef(queryClient);
  /*
   * Kept current after each commit, not assigned while rendering: a write during render is what
   * the React Compiler refuses, and a render React throws away must not tell a listener it is on a
   * page it never reached. Layout, so they are in place before any listener can run after it.
   */
  useLayoutEffect(() => {
    rosterRef.current = agents.data;
    channelsRef.current = channels.data;
    pathRef.current = location.pathname;
    navigateRef.current = navigate;
    queryClientRef.current = queryClient;
  }, [agents.data, channels.data, location.pathname, navigate, queryClient]);
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
  /**
   * Whether the list of what was already waiting when this page opened has been read.
   *
   * A question that was open before the page was is not news to raise the moment the page learns of
   * it: the person has just arrived, and the pill and the sidebar say it. The outbox's first read
   * marks those as said (below); until it has answered, the questions effect holds its tongue, and
   * says whatever is still unsaid once it has.
   */
  const seeded = useRef(false);
  const announceOpen = useRef<() => void>(() => {});

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
   * It reads the store of open questions, which is filled by whoever is watching the server's
   * record — the conversation on screen, or the shell's own watch on every other screen
   * (`lib/turns/questions.ts`). So it holds the Bot, the id and the sentence the card will show.
   *
   * Each question is announced at most once. `watchQuestions` fires on every open AND every close,
   * so without the seen-set an answered question would re-announce every one still waiting behind
   * it — and the throttle would not catch that, because those questions are seconds apart.
   */
  useEffect(() => {
    const announce = () => {
      if (!seeded.current) return;
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
            cardOnScreen: isCardOnScreen({
              pathname: pathRef.current,
              botId: question.botId,
              approvalId: question.approvalId,
              threadId:
                questionThread(question.botId, question.approvalId) ??
                question.threadId,
              channels: channelsRef.current,
            }),
            now: Date.now(),
          },
          {
            title: needsYouTitle(bot?.name ?? question.botId),
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
    };
    announceOpen.current = announce;
    return watchQuestions(announce);
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
      // A pause the unread rule made changed rows the routines page is drawing. See the predicate.
      if (options.raises && routinesChangedBy(rows)) {
        void queryClientRef.current.invalidateQueries({
          queryKey: routineKeys.all,
        });
      }
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
          ...(kind === "needs-you"
            ? {
                cardOnScreen: isCardOnScreen({
                  pathname: pathRef.current,
                  botId: frame.botId,
                  approvalId: frame.approvalId,
                  // The frame names no conversation; the record does, once somebody has read it.
                  threadId: frame.approvalId
                    ? questionThread(frame.botId, frame.approvalId)
                    : undefined,
                  channels: channelsRef.current,
                }),
              }
            : {}),
          now: Date.now(),
        },
        {
          title:
            kind === "needs-you"
              ? needsYouTitle(bot?.name ?? frame.botId)
              : (bot?.name ?? frame.botId),
          body: bodyFor(
            frame.event,
            frame.event === "routine.paused"
              ? pausedBody(frame.pause)
              : subject
                ? describeSubject(subject)
                : null,
          ),
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

    // Whether or not the server answered: a list that could not be read marks nothing as said.
    const afterSeed = () => {
      if (stopped) return;
      seeded.current = true;
      announceOpen.current();
    };
    void catchUp({ raises: false }).then(afterSeed, afterSeed);
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
