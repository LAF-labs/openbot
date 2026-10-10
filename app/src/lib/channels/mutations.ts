import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { own } from "@/lib/own";
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
  "laf:project_name_invalid": "That could not be read. Try again.",
  "laf:project_limit": "There are as many projects as there can be.",
  // Deleting one (piece 4-5). The main conversation is the Bot's and is not deleted from a list.
  "laf:project_only": "Only a project can be deleted here.",
  // Marked, and its turn has not ended yet: the server finishes it when it has.
  "laf:project_deleting": "That project is being deleted.",
};

function channelRefusal(code: string | undefined): string {
  const known = own(CHANNEL_REFUSALS, code);
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
 * Make a project: another conversation with this Bot, beside its main one, by the name given
 * (`lib/channels/projects.ts`). Every call makes one — the server's project door never answers
 * one that exists.
 */
export function createProjectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      agentId: string;
      name: string;
    }): Promise<AgentChannel> => {
      const response = await fetch("/api/channels/projects", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        const code = await response
          .json()
          .then((body: { code?: string }) => body.code)
          .catch(() => undefined);
        const known = own(CHANNEL_REFUSALS, code);
        throw new Error(
          known ? t(known) : t("Could not make the project. Try again."),
        );
      }
      return ((await response.json()) as { channel: AgentChannel }).channel;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  });
}

/**
 * Delete a project: its conversation and everything that named it (`server/src/channels/
 * deleting.ts`). The server marks it, waits for what was writing into it, stops its turn and then
 * removes it, so this answers only once it is gone — and "it is not there" is the same success,
 * since another window may have got there first.
 */
export async function deleteProject(
  queryClient: QueryClient,
  channelId: string,
): Promise<void> {
  const response = await fetch(
    `/api/channels/projects/${encodeURIComponent(channelId)}`,
    { credentials: "include", method: "DELETE" },
  );
  if (!response.ok && response.status !== 404) {
    const code = await response
      .json()
      .then((body: { code?: string }) => body.code)
      .catch(() => undefined);
    /*
     * BEING DELETED IS NOT "NOT DELETED". The server has marked it and is waiting for its turn to
     * end; it finishes on its own. The list no longer holds it, so the list is read again — the
     * sentence says why it went, and nothing is left on screen to press a second time.
     */
    if (code === "laf:project_deleting") {
      await queryClient.invalidateQueries({ queryKey: channelKeys.all });
    }
    const known = own(CHANNEL_REFUSALS, code);
    throw new Error(
      known ? t(known) : t("Could not delete the project. Try again."),
    );
  }
  // Out of what is on screen at once, and out of what a conversation opened by its id would read.
  queryClient.removeQueries({ queryKey: channelKeys.detail(channelId) });
  await queryClient.invalidateQueries({ queryKey: channelKeys.all });
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
