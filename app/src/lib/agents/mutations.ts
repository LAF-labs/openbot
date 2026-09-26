import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { channelKeys } from "../channels/queries";
import { t } from "../i18n";
import { routineKeys } from "../routines/queries";
import { type AgentEffort, type AgentProfile, agentKeys } from "./queries";

/**
 * What the agents API can refuse, in this surface's own words.
 *
 * The server sends a fact code and never a sentence; this table owns the sentence, which puts
 * `t()` on a variable and so out of `i18n-coverage.test.ts`'s sight. The table is checked in and
 * finite, so `agent-refusals.test.ts` walks it — the same pair `ROUTINE_REFUSALS` and
 * `routines-copy.test.ts` make.
 */
export const AGENT_REFUSALS: Record<string, string> = {
  /*
   * ONE BOT A PERSON (2026-09-24). It was `laf:seats_full`, with the count, for "all five seats are
   * taken"; one has nothing to count. Reached only by a request nothing on this surface makes any
   * more — there is no button for a second Bot — but a second tab left open on the first run can.
   */
  "laf:account_has_bot":
    "You already have your Bot. Change its name or face on its profile instead.",
  /*
   * The rest are the codes `/profile` and `/memories` answer with. A Bot's own tool is their usual
   * caller, but this app posts to `/profile` too — the effort buttons do — so a person can reach
   * them, and a person reaching one must not be handed the server's English.
   */
  "laf:profile_invalid": "That change could not be read. Try again.",
  "laf:profile_looks_like_prompt":
    "That reads like an instruction to the Bot rather than a description, so it was not saved.",
  "laf:profile_no_fields": "Nothing was changed.",
  "laf:profile_not_found": "That Bot is no longer there.",
  "laf:memory_looks_like_a_secret":
    "That looks like a password, so it was not saved.",
  "laf:memory_too_long": "That is too long to remember.",
  "laf:memory_empty": "There was nothing to remember.",
  "laf:memory_looks_like_instruction":
    "That reads like an instruction rather than a fact, so it was not saved.",
  "laf:memory_full":
    "This Bot's memory is full. Forget or shorten something in the Notebook to make room.",
  // A line the owner had forgotten, which the Bot tried to write back from the day's conversation.
  "laf:memory_forgotten":
    "You had this forgotten, so it was not written down again.",
  // 수첩's own two (`/notebook`): the owner's pen refuses less than the Bot's, and says so here.
  "laf:notebook_not_a_fact":
    "That reads like an order to the Bot. Write what is true here, and ask the Bot for things in a conversation.",
  "laf:notebook_slot_unknown": "That could not be saved. Try again.",
  /*
   * What the Bot form itself can be refused for, one code per field.
   *
   * These reached the screen as the parser's own English — "Name must be text between 1 and 80
   * characters." — under a Korean label, on the one form every person meets on their first day.
   * The server names which field now and this table says it in Korean; the sentences name the
   * bound, because a refusal that does not say what would be accepted makes somebody guess.
   */
  "laf:agent_input_not_object": "That change could not be read. Try again.",
  "laf:agent_name_invalid": "A Bot needs a name, of 80 characters or fewer.",
  "laf:agent_role_too_long": "A description can be up to 1,000 characters.",
  "laf:agent_endpoint_refused": "That address cannot be used.",
  "laf:agent_avatar_invalid": "That face cannot be used.",
  "laf:agent_effort_invalid": "Choose how hard this Bot thinks.",
  "laf:agent_auto_review_too_long":
    "That instruction can be up to 1,000 characters.",
  "laf:agent_auth_header_invalid": "That header name cannot be used.",
  /*
   * The refusals the store and the memory and coworker routes throw, which used to reach the roster
   * and the ask box as the server's own English — "Agent not found.", "You do not have permission
   * to manage this agent." The words are the surface's now (audit A1-3).
   */
  "laf:agent_not_found": "That Bot is no longer there.",
  "laf:agent_not_manageable": "You cannot change this Bot.",
  "laf:agent_protected": "This Bot came with the app and cannot be changed.",
  "laf:memory_not_found": "That memory is no longer there.",
  "laf:preference_invalid": "That setting could not be changed. Try again.",
};

export type AgentInput = {
  name: string;
  roleDescription: string;
  /** Where this coworker runs. Empty means the Bot in the box. */
  endpoint?: string;
  /** Write-only auth value; omitted when the user leaves the key field empty. */
  auth?: { header: string; value: string };
  /** The face somebody picked. Omitted leaves whatever the Bot already wears. */
  avatarSeed?: string;
  /**
   * The standing instruction for waving actions through, when a person is changing it.
   *
   * On the replacing input rather than the merging patch, deliberately: the merging one is what a
   * Bot's own tool posts to, and this is the one field a Bot must never be able to write.
   */
  autoReview?: string;
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
  roleDescription?: string;
  avatarSeed?: string;
  effort?: AgentEffort;
};

/** Which of this person's preferences for a Bot to change. Absent means "leave it alone". */
export type AgentPreferencePatch = {
  hidden?: boolean;
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
    const body = (await response.json().catch(() => null)) as {
      code?: string;
    } | null;
    const known = body?.code ? AGENT_REFUSALS[body.code] : undefined;
    /*
     * The code, and never the server's `error`. That field carried an English sentence until
     * 2026-09-11 and carries the code now, so reading it as a fallback would print `laf:…` on the
     * screen; a code this table has no words for gets the general sentence instead.
     */
    throw new Error(
      known ? t(known) : t("That did not go through. Try again."),
    );
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
    /*
     * Its conversation and its routines went with it on the server, so the roster and the Routines
     * screen are refetched too. Only the Bots were, while a deleted Bot's conversation stayed behind
     * as history; now a cached row would be a conversation that answers 404 when pressed.
     */
    onSuccess: () =>
      Promise.all([
        invalidateAgents(queryClient),
        queryClient.invalidateQueries({ queryKey: channelKeys.all }),
        queryClient.invalidateQueries({ queryKey: routineKeys.all }),
      ]),
  });
}
