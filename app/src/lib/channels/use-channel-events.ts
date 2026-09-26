import {
  HEARTBEAT_MS,
  HEARTBEAT_PARAM,
  heartbeatFrameKind,
  PING_FRAME,
  PONG_FRAME,
} from "@shared/channel-socket";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { dayKeys } from "@/lib/agents/day";
import { workingKeys } from "@/lib/agents/working";
import {
  isNotificationFrame,
  NOTIFICATION_FRAME,
  type NotificationFrame,
  notificationFrames,
} from "@/lib/notifications/outbox";
import { OUTAGE_CAP_MS } from "@/lib/polling";
import { type ChannelSummary, channelKeys } from "./queries";

/**
 * Keep the roster live.
 *
 * The query remains the source of truth; socket events only patch its cache. Reconnects refetch the
 * list to recover events missed while disconnected.
 */

type ChannelActivityEvent = {
  channelId: string;
  /** The channel's current name. Carried so a patched row cannot drop it. */
  name: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
};

/**
 * The same events, for whoever has the room open.
 *
 * The roster patches its cache below; the transcript of the open room needs the message itself,
 * which only a fetch of the thread returns. Rather than thread a callback from the sidebar (where
 * the socket lives) to the chat (where the room is), the event is re-broadcast here and the chat
 * listens. One socket, any number of listeners.
 */
export const channelActivity = new EventTarget();
export const CHANNEL_ACTIVITY = "channel-activity";

export type ChannelActivity = ChannelActivityEvent;

/**
 * The socket came back after having been away.
 *
 * Frames are not replayed, so anything that happened while it was gone is simply missing. Screens
 * that hold live state listen for this and resync. Not fired on the first connection: there is
 * nothing to have missed.
 */
export const socketState = new EventTarget();
export const SOCKET_RECONNECTED = "socket-reconnected";
/**
 * The socket had been open and is not any more.
 *
 * MEASURED 2026-09-10 (audit A4, finding 3): the API was stopped for fifteen seconds and the screen
 * showed nothing about it — sidebar and header as they were, eighteen console lines, and a question
 * sent meanwhile blamed the model. This `onclose` was the one place in the app that knew, and it
 * told nobody. Now it says so, once, and `isSocketLost()` holds the fact for whoever draws it or
 * decides by it. Cleared by the reconnect, which also fires `SOCKET_RECONNECTED`.
 */
export const SOCKET_LOST = "socket-lost";

let lost = false;

/** Whether the account's socket is currently down after having been up. */
export function isSocketLost(): boolean {
  return lost;
}

/**
 * WHETHER THE LOSS IS WORTH A PERSON'S ATTENTION YET — A DIFFERENT QUESTION FROM WHETHER IT HAPPENED.
 *
 * `isSocketLost()` turns true the instant the socket drops, because a turn that fails in that
 * instant must blame the connection and not the model (`channel-chat.tsx`, audit A4). The notice is
 * a different reader. Since the heartbeat, a socket found dead after a sleep is replaced within a
 * second, and a pill that flashed for that second would be the app announcing a problem it had
 * already solved. So the notice waits out `NOTICE_GRACE_MS` of continuous loss (`"lost"`), and
 * past `SLOW_RECONNECT_MS` says that it has been a while (`"slow"`). Changes fire `SOCKET_TROUBLE`.
 */
export type SocketTrouble = "none" | "lost" | "slow";

export const SOCKET_TROUBLE = "socket-trouble";

let trouble: SocketTrouble = "none";

export function socketTrouble(): SocketTrouble {
  return trouble;
}

function setTrouble(next: SocketTrouble) {
  if (trouble === next) return;
  trouble = next;
  socketState.dispatchEvent(new Event(SOCKET_TROUBLE));
}

/**
 * The conversation a task's picture was just kept in, from the server's `frame_kept` frame
 * (`server/src/channels/transcript-routes.ts`), or null for any other frame.
 *
 * The window that ran the task keeps the picture; every other window drew that card from the list of
 * kept pictures it read once, and showed the empty placeholder until a reload (0.5.4 final QA).
 */
export function frameKeptIn(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as { kind?: unknown; channelId?: unknown };
  return frame.kind === "frame_kept" && typeof frame.channelId === "string"
    ? frame.channelId
    : null;
}

const FIRST_RETRY_MS = 500;
/**
 * The longest wait between attempts: the minute every poll in the app backs off to during an outage
 * (`OUTAGE_CAP_MS`). A person coming back to the window does not wait it out — see `lookedAt`.
 */
const MAX_RETRY_MS = OUTAGE_CAP_MS;

/*
 * THE HEARTBEAT (`shared/channel-socket.ts`). A socket that a sleep, a Wi-Fi change or a suspended
 * window left half-open fires no `close` — it sits "connected" and hears nothing, for as long as the
 * operating system cares to keep it, and the app looks fine and is deaf. So the page pings every
 * `HEARTBEAT_MS` and gives the socket up when nothing at all comes back within `ANSWER_WAIT_MS`; a
 * socket silently cut is noticed within fifteen seconds. When the window is looked at again it asks
 * at once and waits only `PROBE_WAIT_MS`: after a sleep, that is the moment the answer matters.
 */
export const ANSWER_WAIT_MS = 5_000;
export const PROBE_WAIT_MS = 3_000;
/**
 * How long a new socket may take to open. A network that swallows packets leaves one connecting for
 * as long as TCP keeps trying — over a minute — with nothing to say it will not.
 */
export const OPEN_WAIT_MS = 15_000;
/**
 * How long a socket must stay up before the backoff starts again from half a second. Reset on open,
 * a server that accepts and at once drops every socket would be asked twice a second forever.
 */
export const STABLE_MS = 60_000;
/** Continuous loss before the notice appears. See `SocketTrouble`. */
export const NOTICE_GRACE_MS = 2_000;
/** Continuous loss before the notice says it has been a while. */
export const SLOW_RECONNECT_MS = 30_000;

function socketUrl() {
  const url = new URL("/api/channels/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // This page pings and answers pings, and is to be judged by them (`shared/channel-socket.ts`).
  url.searchParams.set(HEARTBEAT_PARAM, "1");
  return url.toString();
}

/** A frame down a socket that may be closing — where `send` throws, and the heartbeat will judge. */
function trySend(socket: WebSocket, frame: string) {
  try {
    socket.send(frame);
  } catch {
    // Still connecting, or already closing: neither is this frame's to report.
  }
}

type Connection = {
  /** The cache this socket patches. A different one is a different app; reopen against it. */
  client: QueryClient;
  close: () => void;
};

/*
 * THE SOCKET BELONGS TO THE MODULE, NOT TO THE EFFECT — AND IT IS COUNTED.
 *
 * This used to be a plain `useEffect` that constructed a `WebSocket` and closed it in its cleanup.
 * StrictMode mounts an effect, tears it down and mounts it again inside a single commit, so every
 * page load opened TWO sockets and aborted the first. Measured, not deduced: the browser console
 * carried one "WebSocket is closed before the connection is established" per load against
 * ws://…/api/channels/events, and the server saw a connect and an immediate disconnect in front of
 * the real one — an account-wide socket that is really two on every reload.
 *
 * So the effect no longer owns the socket. It takes a reference and gives it back, and the release
 * is deferred by a turn, because StrictMode's remount lands before that timer: the remount reclaims
 * the live socket, while a screen that is really gone still closes it on the next tick. Nothing
 * leaks, and in production — where the effect runs once — the only change is the deferral.
 */
let connection: Connection | undefined;
let holders = 0;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

type Timer = ReturnType<typeof setTimeout>;

function openConnection(queryClient: QueryClient): Connection {
  let socket: WebSocket | undefined;
  /** Whether `socket` has opened. Kept here rather than read off `readyState`, which fakes lack. */
  let isOpen = false;
  let retryTimer: Timer | undefined;
  let retryDelay = FIRST_RETRY_MS;
  let stopped = false;
  let opened = false;
  let openTimer: Timer | undefined;
  let stableTimer: Timer | undefined;
  let beatTimer: ReturnType<typeof setInterval> | undefined;
  /** Set while a ping is out; cleared by anything at all coming back. */
  let answerTimer: Timer | undefined;
  let graceTimer: Timer | undefined;
  let slowTimer: Timer | undefined;

  const clear = (timer: Timer | undefined) => {
    if (timer !== undefined) clearTimeout(timer);
  };

  const stopHeartbeat = () => {
    if (beatTimer !== undefined) clearInterval(beatTimer);
    beatTimer = undefined;
    clear(answerTimer);
    answerTimer = undefined;
  };

  const settleTrouble = () => {
    clear(graceTimer);
    clear(slowTimer);
    graceTimer = undefined;
    slowTimer = undefined;
    setTrouble("none");
  };

  /**
   * The socket is gone — closed by the other end, or given up on here. Everything that was timing
   * it stops, the loss is said once, and the next attempt waits its turn.
   */
  const closed = () => {
    stopHeartbeat();
    clear(openTimer);
    clear(stableTimer);
    openTimer = undefined;
    stableTimer = undefined;
    socket = undefined;
    isOpen = false;
    if (stopped) return;
    // Only a socket that had been up: a first connection failing is the /unreachable screen's.
    if (opened && !lost) {
      lost = true;
      socketState.dispatchEvent(new Event(SOCKET_LOST));
      graceTimer = setTimeout(() => setTrouble("lost"), NOTICE_GRACE_MS);
      slowTimer = setTimeout(() => setTrouble("slow"), SLOW_RECONNECT_MS);
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  };

  /*
   * GIVEN UP ON HERE, NOT WAITED FOR. `close()` on a socket whose other end has gone starts a
   * handshake nobody will answer, and its `close` event can take as long as the connection took to
   * die. So its handlers are taken off first, and it is treated as closed now.
   */
  const giveUp = (which: WebSocket) => {
    if (socket !== which) return;
    which.onopen = null;
    which.onmessage = null;
    which.onclose = null;
    try {
      which.close();
    } catch {
      // Already closing.
    }
    closed();
  };

  /** Ping, unless one is already out; give the socket up if nothing comes back within `wait`. */
  const ping = (wait: number) => {
    const current = socket;
    if (!current || !isOpen || answerTimer !== undefined) return;
    trySend(current, PING_FRAME);
    answerTimer = setTimeout(() => {
      answerTimer = undefined;
      giveUp(current);
    }, wait);
  };

  const connect = () => {
    if (stopped) return;
    const next = new WebSocket(socketUrl());
    socket = next;
    isOpen = false;
    openTimer = setTimeout(() => giveUp(next), OPEN_WAIT_MS);

    next.onopen = () => {
      clear(openTimer);
      openTimer = undefined;
      isOpen = true;
      beatTimer = setInterval(() => ping(ANSWER_WAIT_MS), HEARTBEAT_MS);
      stableTimer = setTimeout(() => {
        retryDelay = FIRST_RETRY_MS;
      }, STABLE_MS);
      lost = false;
      settleTrouble();
      // Recover events missed while the socket was disconnected.
      void queryClient.invalidateQueries({ queryKey: channelKeys.list() });
      if (opened) {
        // And what the polls would have learned meanwhile, once rather than on their next tick.
        void queryClient.invalidateQueries({ queryKey: workingKeys.all });
        void queryClient.invalidateQueries({ queryKey: dayKeys.all });
        socketState.dispatchEvent(new Event(SOCKET_RECONNECTED));
      }
      opened = true;
    };

    next.onmessage = (message) => {
      // Anything at all from the server is the server being there.
      clear(answerTimer);
      answerTimer = undefined;
      const beat = heartbeatFrameKind(message.data);
      if (beat === "ping") trySend(next, PONG_FRAME);
      if (beat !== null) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data as string);
      } catch {
        return;
      }
      /*
       * Switched on `kind` BEFORE the roster patch: the notification outbox saying something is
       * waiting for this person. Spread onto a roster row, it would put `approvalId` on an object
       * the sidebar draws. A frame with no `kind` is the activity event this handler has always
       * taken.
       */
      if (isNotificationFrame(parsed)) {
        /*
         * A Bot finishing, failing or stopping to ask is exactly what the "working" poll exists
         * to notice, so the frame refreshes it now and the poll can run at a walking pace
         * (`lib/agents/working.ts`).
         */
        void queryClient.invalidateQueries({ queryKey: workingKeys.all });
        // And the Bot's day: a finished run, a failure, a question is a row in 오늘 (`lib/agents/day.ts`).
        void queryClient.invalidateQueries({ queryKey: dayKeys.all });
        notificationFrames.dispatchEvent(
          new CustomEvent<NotificationFrame>(NOTIFICATION_FRAME, {
            detail: parsed,
          }),
        );
        return;
      }
      // A task's picture was kept: the cards and 오늘 that drew it without one ask again.
      const framedIn = frameKeptIn(parsed);
      if (framedIn) {
        void queryClient.invalidateQueries({
          queryKey: channelKeys.framedCalls(framedIn),
        });
        void queryClient.invalidateQueries({ queryKey: dayKeys.all });
        return;
      }
      /*
       * ANY OTHER `kind` IS DROPPED, NOT PATCHED IN. A room's turn used to arrive as frames of its
       * own; rooms were removed on 2026-09-24, and a server from before that still running behind
       * a tab from after it must not have a room frame spread onto a roster row.
       */
      if (typeof parsed === "object" && parsed !== null && "kind" in parsed) {
        return;
      }
      const activity = parsed as ChannelActivityEvent;

      // The list cache is patched below, but the open channel's header reads the detail query;
      // a retitle has to reach it too, and invalidation is cheaper than mirroring the patch.
      const before = queryClient
        .getQueryData<ChannelSummary[]>(channelKeys.list())
        ?.find((channel) => channel.id === activity.channelId);
      if (before && activity.name && before.name !== activity.name) {
        void queryClient.invalidateQueries({
          queryKey: channelKeys.detail(activity.channelId),
        });
      }

      queryClient.setQueryData(
        channelKeys.list(),
        (channels: ChannelSummary[] | undefined) => {
          if (!channels) return channels;
          // Unknown channel ids mean the roster is stale; refetch the list instead of patching.
          if (!channels.some((c) => c.id === activity.channelId)) {
            void queryClient.invalidateQueries({
              queryKey: channelKeys.list(),
            });
            return channels;
          }
          // Preserve object identity for unchanged rows so memoized rows do not re-render.
          const index = channels.findIndex(
            (channel) => channel.id === activity.channelId,
          );
          const previous = channels[index];
          if (!previous) return channels;

          const patched = { ...previous, ...activity };
          const next = channels.slice();
          next[index] = patched;
          next.sort(byRecency);

          // An event that changes nothing visible, a duplicate, or a report the server ignored
          // as stale, returns the original array, so React re-renders nothing at all.
          return next.every((channel, at) => channel === channels[at])
            ? channels
            : next;
        },
      );

      /*
       * The event carries what was said, not whether THIS person has read it — the read mark is
       * per member and only the server holds it. Patching the row above keeps the preview and
       * the order live; this refetch is what lets a Bot's reply in another room turn its row
       * bold. A person's own message never needs it: a room is not unread for what you said.
       */
      if (activity.lastMessageAgentId) {
        void queryClient.invalidateQueries({ queryKey: channelKeys.list() });
        // A Bot that just spoke has, as a rule, just stopped working — and done something today.
        void queryClient.invalidateQueries({ queryKey: workingKeys.all });
        void queryClient.invalidateQueries({ queryKey: dayKeys.all });
      }

      channelActivity.dispatchEvent(
        new CustomEvent<ChannelActivity>(CHANNEL_ACTIVITY, {
          detail: activity,
        }),
      );
    };

    // WebSocket needs explicit reconnect handling.
    next.onclose = () => {
      if (socket !== next) return;
      closed();
    };
  };

  /*
   * A PERSON LOOKING AT THE WINDOW AGAIN IS WORTH AN ATTEMPT NOW. The wait between attempts grows to a
   * minute over a long outage, which is right for a window nobody is watching and wrong for the one
   * somebody has just brought forward to see whether it works yet. And an open socket is asked
   * whether it still reaches anything: coming back from a sleep is exactly when one does not, and
   * nothing else would find out for another ten seconds. A socket still connecting is left alone.
   */
  const lookedAt = () => {
    if (stopped || document.visibilityState === "hidden") return;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      connect();
      return;
    }
    ping(PROBE_WAIT_MS);
  };
  document.addEventListener("visibilitychange", lookedAt);
  window.addEventListener("focus", lookedAt);
  // The device's network came back: the same question, for the same reason.
  window.addEventListener("online", lookedAt);

  connect();

  return {
    client: queryClient,
    close: () => {
      stopped = true;
      document.removeEventListener("visibilitychange", lookedAt);
      window.removeEventListener("focus", lookedAt);
      window.removeEventListener("online", lookedAt);
      clear(retryTimer);
      // A screen that is gone has no connection to have lost; the next one starts from nothing.
      lost = false;
      settleTrouble();
      const current = socket;
      // Cleared first: the close below must not schedule a reconnect for a screen that is gone.
      if (current) current.onclose = null;
      closed();
      current?.close();
    },
  };
}

export function useChannelEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    holders += 1;
    if (releaseTimer !== undefined) {
      clearTimeout(releaseTimer);
      releaseTimer = undefined;
    }
    if (connection && connection.client !== queryClient) {
      connection.close();
      connection = undefined;
    }
    // Spelled out rather than `??=`, which React Compiler 1.0 cannot compile: `connection` is never
    // null, so this is the same test.
    if (connection === undefined) connection = openConnection(queryClient);

    return () => {
      holders -= 1;
      if (holders > 0) return;
      releaseTimer = setTimeout(() => {
        releaseTimer = undefined;
        if (holders > 0) return;
        connection?.close();
        connection = undefined;
      }, 0);
    };
  }, [queryClient]);
}

/**
 * Most recent first, where starting a conversation counts as activity.
 *
 * Deliberately the same rule the roster query uses, `coalesce(last_message_at, created_at) desc` in
 * channels/routes.ts. If these two disagree the list reorders itself the moment an event arrives,
 * which looks like rows jumping for no reason.
 */
function byRecency(left: ChannelSummary, right: ChannelSummary) {
  const at = (channel: ChannelSummary) =>
    channel.lastMessageAt ?? channel.createdAt;
  return at(right).localeCompare(at(left));
}
