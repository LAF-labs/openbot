import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
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

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

function socketUrl() {
  const url = new URL("/api/channels/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function useChannelEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let retryDelay = FIRST_RETRY_MS;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(socketUrl());

      socket.onopen = () => {
        retryDelay = FIRST_RETRY_MS;
        // Recover events missed while the socket was disconnected.
        void queryClient.invalidateQueries({ queryKey: channelKeys.list() });
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
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
      };
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      // Cleared first: the close below must not schedule a reconnect for a screen that is gone.
      if (socket) socket.onclose = null;
      socket?.close();
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
