import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { type AgentChannel, channelKeys } from "./queries";

/**
 * Start a new channel with one or more coworkers.
 *
 * Deliberately not idempotent: every call creates a channel with its own thread.
 */
export function createChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentIds: string[]): Promise<AgentChannel> => {
      const response = await fetch("/api/channels", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentIds }),
      });
      if (!response.ok) {
        const message = await response
          .json()
          .then((body: { error?: string }) => body.error)
          .catch(() => undefined);
        throw new Error(
          message ?? t("Could not start a conversation. Try again."),
        );
      }
      return ((await response.json()) as { channel: AgentChannel }).channel;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  });
}

/**
 * Report the last thing said in a channel.
 *
 * The client that ran the agent already has the message before platform replay can return it; the
 * runtime exposes no run-completion hook and its run endpoint returns before the reply exists.
 *
 * Fire-and-forget on purpose: a failed preview update is a stale roster line, not a lost message.
 */
export function recordChannelActivityMutationOptions() {
  return mutationOptions({
    mutationFn: async (variables: {
      channelId: string;
      text: string;
      agentId: string | null;
      at: string;
    }) => {
      await fetch(`/api/channels/${variables.channelId}/activity`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: variables.agentId,
          at: variables.at,
          text: variables.text,
        }),
      });
    },
  });
}

/**
 * Move this person's read mark for a channel.
 *
 * Returns the mark it REPLACED, which is what the transcript draws its "unread from here" line
 * from: opening a room marks it read, and that write destroys the very fact the line needs. One
 * call that reports what it overwrote cannot race a second call that reads it.
 */
export function setChannelReadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      channelId: string;
      read: boolean;
    }): Promise<{ previousReadAt: string | null; readAt: string | null }> => {
      const response = await fetch(
        `/api/channels/${encodeURIComponent(variables.channelId)}/read`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ read: variables.read }),
        },
      );
      if (!response.ok)
        throw new Error(t("Could not mark that as read. Try again."));
      return (await response.json()) as {
        previousReadAt: string | null;
        readAt: string | null;
      };
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.list() }),
  });
}
