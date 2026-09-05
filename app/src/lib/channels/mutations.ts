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

/**
 * What the participant routes can refuse, in this surface's own words.
 *
 * The server sends `laf:…` codes and no prose (see `server/src/channels/routes.ts`), so the
 * sentences live here. Three of them rather than one, because they are three different situations
 * and only one of them is the person's mistake.
 *
 * `t()` on a variable, so `participants.test.ts` walks this table — `i18n-coverage.test.ts` only
 * sees a literal `t()` call.
 */
export const PARTICIPANT_REFUSALS: Record<string, string> = {
  "laf:already_in_room": "That Bot is already in this conversation.",
  "laf:not_in_room": "That Bot is not in this conversation.",
  // Why it refuses rather than emptying the room: see `removeParticipant` on the server.
  "laf:room_too_small":
    "A room needs at least two Bots. To talk to one on its own, open its own conversation.",
};

async function participantRequest(
  path: string,
  init: { method: string; body?: { agentId: string } },
): Promise<AgentChannel> {
  const response = await fetch(path, {
    method: init.method,
    credentials: "include",
    ...(init.body ? { headers: { "content-type": "application/json" } } : {}),
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      code?: string;
    } | null;
    const known = body?.code ? PARTICIPANT_REFUSALS[body.code] : undefined;
    throw new Error(known ? t(known) : t("That change could not be made."));
  }
  return ((await response.json()) as { channel: AgentChannel }).channel;
}

/** Put another Bot into a conversation that is already going on. */
export function addParticipantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { channelId: string; agentId: string }) =>
      participantRequest(
        `/api/channels/${encodeURIComponent(variables.channelId)}/participants`,
        { method: "POST", body: { agentId: variables.agentId } },
      ),
    onSuccess: (channel) => {
      // The detail is what the header and the transcript read; the list is what the sidebar reads.
      queryClient.setQueryData(channelKeys.detail(channel.id), channel);
      void queryClient.invalidateQueries({ queryKey: channelKeys.all });
    },
  });
}

/** Take a Bot out. What was said stays: this is a membership change, not a deletion. */
export function removeParticipantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { channelId: string; agentId: string }) =>
      participantRequest(
        `/api/channels/${encodeURIComponent(variables.channelId)}/participants/${encodeURIComponent(variables.agentId)}`,
        { method: "DELETE" },
      ),
    onSuccess: (channel) => {
      queryClient.setQueryData(channelKeys.detail(channel.id), channel);
      void queryClient.invalidateQueries({ queryKey: channelKeys.all });
    },
  });
}
