import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import type { TurnFailure } from "./turn-failure";

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
  failures: (channelId: string) => ["channels", "failures", channelId] as const,
};

export function channelListQueryOptions() {
  return queryOptions({
    queryKey: channelKeys.list(),
    queryFn: async (): Promise<ChannelSummary[]> => {
      const response = await fetch("/api/channels", {
        credentials: "include",
      });
      if (!response.ok)
        throw new Error(t("Could not load your conversations."));
      return ((await response.json()) as { channels: ChannelSummary[] })
        .channels;
    },
  });
}

/** What the server records about each message beside its text: when, and by whom. */
export type ThreadMarks = {
  /** Message id to ISO-8601. */
  times: Record<string, string>;
  /** Message id to the id of the Bot that said it. Only assistant messages carry one. */
  speakers: Record<string, string>;
};

const NO_MARKS: ThreadMarks = { times: {}, speakers: {} };

/**
 * When each message in a channel was first seen, and which Bot said it.
 *
 * A separate request from the transcript, because the transcript does not come from us — it comes
 * out of CopilotKit's agent, whose message shape is a fixed whitelist that drops any field we add.
 * Fetched once when a channel opens; messages that arrive after that are stamped on arrival by the
 * browser, which is the same clock to within a round trip, and attributed by the room's own record
 * of which Bot the turn was sent to.
 */
export function messageTimesQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.messageTimes(channelId),
    queryFn: async (): Promise<ThreadMarks> => {
      const response = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/message-times`,
        { credentials: "include" },
      );
      // A transcript with no times is a transcript with no separators, which is survivable; a
      // throw here would take the conversation down with it.
      if (!response.ok) return NO_MARKS;
      const body = (await response.json()) as Partial<ThreadMarks>;
      return { times: body.times ?? {}, speakers: body.speakers ?? {} };
    },
    // What the server records about a message never changes once written, so a refetch buys nothing.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

const NO_FAILURES: TurnFailure[] = [];

/**
 * The turns in this channel that ended without an answer.
 *
 * NOT STALE-FOREVER, unlike the times beside it: a turn can fail while this page is open, and the
 * transcript has to be able to pick that up after the run ends. The live path draws its own line
 * immediately; this is what makes the line survive a reload, and it is invalidated when a turn
 * finishes badly rather than polled.
 *
 * A failed read is not an error worth taking the conversation down for — it means no failure marks,
 * which is exactly the transcript that was drawn before any of this existed.
 */
export function channelFailuresQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.failures(channelId),
    queryFn: async (): Promise<TurnFailure[]> => {
      const response = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/failures`,
        { credentials: "include" },
      );
      if (!response.ok) return NO_FAILURES;
      const body = (await response.json()) as { failures?: TurnFailure[] };
      return body.failures ?? NO_FAILURES;
    },
  });
}

export function channelQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.detail(channelId),
    queryFn: async (): Promise<AgentChannel> => {
      const response = await fetch(`/api/channels/${channelId}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error(t("Could not load this conversation."));
      return ((await response.json()) as { channel: AgentChannel }).channel;
    },
  });
}
