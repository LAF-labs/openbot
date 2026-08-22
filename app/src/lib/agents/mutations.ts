import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  type AgentEffort,
  type AgentProfile,
  type AgentVisibility,
  agentKeys,
} from "./queries";

export type AgentInput = {
  name: string;
  title: string;
  roleDescription: string;
  visibility: AgentVisibility;
  /** Where this coworker runs. Empty means the Bot in the box. */
  endpoint?: string;
  /** Write-only auth value; omitted when the user leaves the key field empty. */
  auth?: { header: string; value: string };
  /** The face somebody picked. Omitted leaves whatever the Bot already wears. */
  avatarSeed?: string;
};

/**
 * A change to one part of a Bot's profile, merged into what is stored.
 *
 * `AgentInput` above replaces: every required field has to be sent or the parser refuses it. This
 * one is what `/profile` takes, and it is how a single control changes a single thing without
 * carrying the rest of the form along with it.
 */
export type AgentProfilePatch = {
  name?: string;
  title?: string;
  roleDescription?: string;
  avatarSeed?: string;
  effort?: AgentEffort;
};

/** Which of this person's preferences for a Bot to change. Absent means "leave it alone". */
export type AgentPreferencePatch = {
  hidden?: boolean;
  pinned?: boolean;
  notify?: boolean;
};

async function agentRequest(
  path: string,
  init: {
    method: string;
    body?: AgentInput | AgentPreferencePatch | AgentProfilePatch;
  },
): Promise<Response> {
  const response = await fetch(path, {
    method: init.method,
    credentials: "include",
    headers: init.body ? { "content-type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    // The server's message is the useful one: it names the field or the permission that failed.
    const message = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => undefined);
    throw new Error(message ?? "Coworker operation failed");
  }
  return response;
}

async function agentFrom(response: Response): Promise<AgentProfile> {
  return ((await response.json()) as { agent: AgentProfile }).agent;
}

/** Server-derived fields are invalidated instead of patched by hand. */
function invalidateAgents(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: agentKeys.all });
}

export function createAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: AgentInput) =>
      agentFrom(
        await agentRequest("/api/agents", { method: "POST", body: input }),
      ),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function updateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; input: AgentInput }) =>
      agentFrom(
        await agentRequest(`/api/agents/${variables.agentId}`, {
          method: "PATCH",
          body: variables.input,
        }),
      ),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/**
 * One setting, changed on its own.
 *
 * The PATCH above replaces the fields it carries and therefore needs every required one sent back,
 * which is right for a form and wrong for a switch: a control that had to resend the name and the
 * role to change how hard a Bot thinks would overwrite whatever somebody typed into the form beside
 * it and had not saved yet. `/profile` merges into what is stored, so this carries only what
 * changed — the same endpoint a Bot uses to write its own profile.
 */
export function setAgentEffortMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; effort: AgentEffort }) =>
      agentFrom(
        await agentRequest(`/api/agents/${variables.agentId}/profile`, {
          method: "POST",
          body: { effort: variables.effort },
        }),
      ),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function duplicateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) =>
      agentFrom(
        await agentRequest(`/api/agents/${agentId}/duplicate`, {
          method: "POST",
        }),
      ),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function setAgentHiddenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; hidden: boolean }) => {
      await agentRequest(
        `/api/agents/${variables.agentId}/${variables.hidden ? "hide" : "unhide"}`,
        { method: "POST" },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/**
 * Pin, mute, hide — one call, and it is NOT gated on being able to manage the Bot.
 *
 * These are facts about the reader, not about the coworker: somebody who can only see a shared Bot
 * still gets to decide whether it sits at the top of their roster and whether it interrupts them,
 * and neither choice is visible to anybody else.
 */
export function setAgentPreferencesMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      agentId: string;
      patch: AgentPreferencePatch;
    }) => {
      await agentRequest(`/api/agents/${variables.agentId}/preferences`, {
        method: "POST",
        body: variables.patch,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function deleteAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await agentRequest(`/api/agents/${agentId}`, { method: "DELETE" });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}
