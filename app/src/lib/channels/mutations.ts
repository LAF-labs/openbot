import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { type AgentChannel, channelKeys } from "./queries";

/**
 * What starting a conversation can be refused for, in this surface's own words.
 *
 * The server sends `laf:…` codes and no prose (`server/src/channels/routes.ts`); these are the
 * sentences. `t()` on a variable, so `channel-refusals.test.ts` walks the table the way
 * `agent-refusals.test.ts` walks its own — the coverage walk only sees a literal argument.
 */
export const CHANNEL_REFUSALS: Record<string, string> = {
  "laf:channel_input_invalid": "That could not be read. Try again.",
  "laf:channel_agents_required": "Choose at least one Bot.",
  "laf:channel_agents_invalid": "That is not a valid Bot.",
  "laf:channel_agents_duplicate": "That Bot is already in the list.",
  // Rooms were removed on 2026-09-24: a conversation is with one Bot.
  "laf:channel_one_bot": "A conversation is with one Bot.",
  "laf:channel_not_found": "That conversation is no longer there.",
  "laf:agent_not_found": "That Bot is no longer there.",
};

function channelRefusal(code: string | undefined): string {
  const known = code ? CHANNEL_REFUSALS[code] : undefined;
  return known ? t(known) : t("Could not start a conversation. Try again.");
}

/**
 * Start the Bot's conversation. The server answers with the one it already has, if it has one.
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
        const code = await response
          .json()
          .then((body: { code?: string }) => body.code)
          .catch(() => undefined);
        throw new Error(channelRefusal(code));
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
