import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
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
        let activity: ChannelActivityEvent;
        try {
          activity = JSON.parse(message.data as string);
        } catch {
          return;
        }

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
