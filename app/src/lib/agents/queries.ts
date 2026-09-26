import type { MemoryEvidence, NotebookSlot } from "@shared/notebook";
import { queryOptions } from "@tanstack/react-query";
import type { AskSubject } from "@/lib/approvals";
import { t } from "@/lib/i18n";
import { refusedRequest } from "@/lib/refusals";

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
   * nowhere else — a Bot's own `update_profile` cannot touch it, because a Bot that could write the
   * rule deciding whether it gets asked about has no boundary at all.
   */
  autoReview: string;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /** Whether a key is set for it. Never the key itself. */
  hasAuth: boolean;
  hidden: boolean;
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
  memories: (agentId: string) => ["agents", "memories", agentId] as const,
  allowances: (agentId: string) => ["agents", "allowances", agentId] as const,
};

/**
 * A question the owner answered with "always" or "for this conversation", as the profile lists it.
 *
 * The server's `StandingApproval` minus the withdrawn and run-out ones, which the route never sends.
 */
export type AgentAllowance = {
  id: string;
  scopeKind: "host" | "file" | "tool";
  scopeValue: string;
  subject?: AskSubject;
  grantedAt: string;
  tier: "always" | "thread" | "task" | "day";
  expiresAt?: string;
};

/**
 * What the owner has told this Bot it need not ask about — read from the store the boundary itself
 * consults — and whether that list is in force at all (`settleWithoutAsking`).
 */
export function agentAllowancesQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.allowances(agentId),
    queryFn: async (): Promise<{
      allowances: AgentAllowance[];
      inForce: boolean;
    }> => {
      const response = await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/allowances`,
        { credentials: "include" },
      );
      if (!response.ok)
        throw await refusedRequest(
          response,
          t("What you allowed could not be loaded."),
        );
      return (await response.json()) as {
        allowances: AgentAllowance[];
        inForce: boolean;
      };
    },
  });
}

/** One line of 수첩: something the Bot knows about the shop or the person reading it. */
export type AgentMemory = {
  id: string;
  content: string;
  createdAt: string;
  /** `bot`: written by the Bot in a conversation. `owner`: written or corrected on 수첩. */
  source: "bot" | "owner";
  /** The owner's own line, or a Bot's line the owner said is right. */
  confirmed: boolean;
  /** One of the shop's named lines (`shared/notebook.ts`), or null. */
  slot: NotebookSlot | null;
  /** Whether the line reaches the Bot. False only past the character cap. */
  carried: boolean;
  /**
   * Who stands behind it and where it was learned: 수첩's "어디서 알게 됐나". Absent from a server
   * before 2026-09-26.
   */
  evidence?: MemoryEvidence;
};

/** One line of how the owner likes to work, as the nightly dream read it or the owner wrote it. */
export type GuidanceLine = {
  id: string;
  content: string;
  source: "dream" | "owner";
  day: string | null;
  createdAt: string;
};

/** Every line, and how full the memory is, in characters. */
export type Notebook = {
  memories: AgentMemory[];
  used: number;
  cap: number;
  /** Absent from a server before 2026-09-26. */
  guidance?: GuidanceLine[];
};

/**
 * What this Bot remembers, as a list somebody can actually act on.
 *
 * A list rather than a paragraph because the point of the screen is the button beside each line:
 * the competing product stores the same thing and its own documentation says you cannot inspect,
 * correct, export, or delete individual memories. A Bot that learned something wrong about
 * somebody's business is the ordinary case, and it has to be fixable in the time it takes to read.
 */
export function agentMemoriesQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.memories(agentId),
    queryFn: async (): Promise<Notebook> => {
      const response = await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/memories`,
        { credentials: "include" },
      );
      /*
       * A 404 IS NOT AN EMPTY LIST, and it was read as one. A deployment with nowhere to record
       * memories answers `laf:not_found` precisely so that a screen does NOT draw "nothing learned
       * yet" for a Bot that cannot learn at all (`server/src/agents/routes.ts`); turned into `[]`
       * here, the card said exactly that. The refusal goes up with its code, and the card says which
       * of the two it is (`MemoriesCard`).
       */
      if (!response.ok)
        throw await refusedRequest(
          response,
          t("Could not load what this Bot knows. Refresh to try again."),
        );
      return (await response.json()) as Notebook;
    },
  });
}

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
      if (!response.ok)
        throw await refusedRequest(
          response,
          t("Could not load your Bots. Refresh to try again."),
        );
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
      if (!response.ok)
        throw await refusedRequest(
          response,
          t("Could not load this Bot. Refresh to try again."),
        );
      return ((await response.json()) as { agent: AgentProfile }).agent;
    },
  });
}
