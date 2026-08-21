import { queryOptions } from "@tanstack/react-query";

/**
 * A channel as the browser sees it.
 *
 * `threadId` is what makes two channels with the same coworker independent conversations, and
 * `active` is false once a linked coworker has been deleted: the transcript stays readable, but
 * nothing more can be said in it.
 */
export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
};

/** A channel plus the last thing said in it, which is what the roster renders. */
export type ChannelSummary = AgentChannel & {
  lastMessage: string | null;
  /** ISO-8601, or null for a channel nobody has used yet. */
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /** A Bot has spoken here since this person last looked. */
  unread: boolean;
  /** ISO-8601. Ordering falls back to this, so a channel just created sorts to the top. */
  createdAt: string;
};

export const channelKeys = {
  all: ["channels"] as const,
  list: () => ["channels", "list"] as const,
  detail: (channelId: string) => ["channels", "detail", channelId] as const,
  messageTimes: (channelId: string) =>
    ["channels", "message-times", channelId] as const,
};

export function channelListQueryOptions() {
  return queryOptions({
    queryKey: channelKeys.list(),
    queryFn: async (): Promise<ChannelSummary[]> => {
      const response = await fetch("/api/channels", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load channels");
      return ((await response.json()) as { channels: ChannelSummary[] })
        .channels;
    },
  });
}

/**
 * When each message in a channel was first seen: message id to ISO-8601.
 *
 * A separate request from the transcript, because the transcript does not come from us — it comes
 * out of CopilotKit's agent, whose message shape is a fixed whitelist that drops any field we add.
 * Fetched once when a channel opens; messages that arrive after that are stamped on arrival by the
 * browser, which is the same clock to within a round trip.
 */
export function messageTimesQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.messageTimes(channelId),
    queryFn: async (): Promise<Record<string, string>> => {
      const response = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/message-times`,
        { credentials: "include" },
      );
      // A transcript with no times is a transcript with no separators, which is survivable; a
      // throw here would take the conversation down with it.
      if (!response.ok) return {};
      return ((await response.json()) as { times: Record<string, string> })
        .times;
    },
    // The stamps for a message never change once written, so a refetch on focus buys nothing.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function channelQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.detail(channelId),
    queryFn: async (): Promise<AgentChannel> => {
      const response = await fetch(`/api/channels/${channelId}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load this channel");
      return ((await response.json()) as { channel: AgentChannel }).channel;
    },
  });
}
