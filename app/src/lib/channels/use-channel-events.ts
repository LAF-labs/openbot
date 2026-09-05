import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  isNotificationFrame,
  NOTIFICATION_FRAME,
  type NotificationFrame,
  notificationFrames,
} from "@/lib/notifications/outbox";
import { type ChannelSummary, channelKeys } from "./queries";
import { isRoomFrame, type RoomFrame } from "./room-frames";

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
 * The second thing the same socket carries: a room turn, as it runs on the server.
 *
 * Its own target, beside the activity one, because the two have different listeners with different
 * rules: the roster and the solo room read activity, the group room reads frames, and a listener
 * that had to tell the two apart by shape would be the place the next deploy breaks.
 */
export const roomFrames = new EventTarget();
export const ROOM_FRAME = "room-frame";

/**
 * The socket came back after having been away.
 *
 * Frames are not replayed, so anything that happened while it was gone is simply missing — and the
 * one that matters is `room.done`, because a room whose turn never ended keeps its composer
 * disabled and there is nothing the person can do about it. Screens that hold live state listen for
 * this and resync. Not fired on the first connection: there is nothing to have missed.
 */
export const socketState = new EventTarget();
export const SOCKET_RECONNECTED = "socket-reconnected";

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

function socketUrl() {
  const url = new URL("/api/channels/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
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

function openConnection(queryClient: QueryClient): Connection {
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = FIRST_RETRY_MS;
  let stopped = false;
  let opened = false;

  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(socketUrl());

    socket.onopen = () => {
      retryDelay = FIRST_RETRY_MS;
      // Recover events missed while the socket was disconnected.
      void queryClient.invalidateQueries({ queryKey: channelKeys.list() });
      if (opened) socketState.dispatchEvent(new Event(SOCKET_RECONNECTED));
      opened = true;
    };

    socket.onmessage = (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data as string);
      } catch {
        return;
      }
      /*
       * Switched on `kind` BEFORE the roster patch. A room frame is not an activity event, and
       * spreading it onto a roster row would put `text` and `turnId` on an object the sidebar
       * renders. A frame with no `kind` is the activity event this handler has always taken, so
       * the two halves can deploy independently.
       */
      if (isRoomFrame(parsed)) {
        roomFrames.dispatchEvent(
          new CustomEvent<RoomFrame>(ROOM_FRAME, { detail: parsed }),
        );
        return;
      }
      /*
       * The third kind: the notification outbox saying something is waiting for this person.
       * Checked here for the same reason a room frame is — anything not recognised falls through
       * to the roster patch below, which would spread `approvalId` onto a row the sidebar draws.
       */
      if (isNotificationFrame(parsed)) {
        notificationFrames.dispatchEvent(
          new CustomEvent<NotificationFrame>(NOTIFICATION_FRAME, {
            detail: parsed,
          }),
        );
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
      }

      channelActivity.dispatchEvent(
        new CustomEvent<ChannelActivity>(CHANNEL_ACTIVITY, {
          detail: activity,
        }),
      );
    };

    // WebSocket needs explicit reconnect handling.
    socket.onclose = () => {
      if (stopped) return;
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    };
  };

  connect();

  return {
    client: queryClient,
    close: () => {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      // Cleared first: the close below must not schedule a reconnect for a screen that is gone.
      if (socket) socket.onclose = null;
      socket?.close();
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
    connection ??= openConnection(queryClient);

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
