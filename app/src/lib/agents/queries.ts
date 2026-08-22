import { queryOptions } from "@tanstack/react-query";

export type AgentVisibility = "public" | "private";

/**
 * A coworker as the browser sees it.
 *
 * `canManage` and `systemOwned` are server-decided authorization facts; components render from the
 * returned flags rather than recomputing ownership rules.
 */
export type AgentEffort = "quick" | "balanced" | "thorough";

export const AGENT_EFFORTS: readonly AgentEffort[] = [
  "quick",
  "balanced",
  "thorough",
];

export type AgentProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  /**
   * How hard it thinks before it answers.
   *
   * The only thing about the model anybody chooses; which model answers is the deployment's
   * decision. Present on every Bot even where the deployment's model takes no such setting — the
   * value is stored either way, and `deployment.effort` decides whether the control is drawn.
   */
  effort: AgentEffort;
  /**
   * What this Bot may be waved through for, in the owner's own words.
   *
   * Empty means ask about everything the boundary stops. Written by a person on this screen and
   * nowhere else — a Bot's own `update_state` cannot touch it, because a Bot that could write the
   * rule deciding whether it gets asked about has no boundary at all.
   */
  autoReview: string;
  visibility: AgentVisibility;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /** Whether a key is set for it. Never the key itself. */
  hasAuth: boolean;
  hidden: boolean;
  /**
   * When this person pinned the Bot, ISO-8601, or null.
   *
   * A time rather than a flag so pinned Bots keep a stable order among themselves — sorting them by
   * activity like everything else would re-shuffle the pinned group on every message, which is the
   * one thing a pin exists to prevent.
   */
  pinnedAt: string | null;
  /** Whether this person wants to hear from the Bot. Per-person, like `hidden`. */
  notify: boolean;
  systemOwned: boolean;
  canManage: boolean;
  /**
   * Whether the signed-in person created this coworker.
   *
   * Separate from `canManage`, which is also true for administrators on everybody's coworkers. Split
   * a roster on `canManage` and an administrator's "mine" fills up with other people's work.
   */
  mine: boolean;
};

export const agentKeys = {
  all: ["agents"] as const,
  list: (hidden = false) => ["agents", "list", { hidden }] as const,
  detail: (agentId: string) => ["agents", "detail", agentId] as const,
};

export function agentListQueryOptions(hidden = false) {
  return queryOptions({
    queryKey: agentKeys.list(hidden),
    queryFn: async (): Promise<AgentProfile[]> => {
      const response = await fetch(
        `/api/agents${hidden ? "?hidden=true" : ""}`,
        {
          credentials: "include",
        },
      );
      if (!response.ok) throw new Error("Could not load coworkers");
      return ((await response.json()) as { agents: AgentProfile[] }).agents;
    },
  });
}

export function agentQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.detail(agentId),
    queryFn: async (): Promise<AgentProfile> => {
      const response = await fetch(`/api/agents/${agentId}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load this coworker");
      return ((await response.json()) as { agent: AgentProfile }).agent;
    },
  });
}
