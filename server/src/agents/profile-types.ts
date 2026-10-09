/*
 * There is no `AgentVisibility`. A Bot belongs to the account that made it and to nobody else;
 * `ownerUserId` below is the whole of that, and `agents/profile-policy.ts` is where it is read.
 */

/**
 * How hard a Bot thinks before it answers.
 *
 * The only thing about the model a person chooses; which model answers is the deployment's decision.
 * See `agentEffort` in `db/schema/coworker.ts` for the argument, and `RuntimeModel.supportsEffort`
 * for why a deployment can be running a model that takes no such setting.
 */
export type AgentEffort = "quick" | "balanced" | "thorough";

export const AGENT_EFFORTS: readonly AgentEffort[] = [
  "quick",
  "balanced",
  "thorough",
];

export type AgentActor = {
  id: string;
  role: "admin" | "user";
};

export type AgentProfile = {
  id: string;
  name: string;
  roleDescription: string;
  avatarSeed: string;
  effort: AgentEffort;
  /**
   * What this Bot may be waved through for, in the owner's own words. Empty means ask about
   * everything the policy stops. See `agentProfiles.autoReview`.
   */
  autoReview: string;
  /** Whose Bot this is, and therefore who may see it. Null is the deployment's own. */
  ownerUserId: string | null;
  systemOwned: boolean;
  hidden: boolean;
  /** Whether this person wants to hear from the Bot. Per-person, like `hidden`. */
  notify: boolean;
  deletedAt: Date | null;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /** Whether a key is set for it. Never the key. */
  hasAuth: boolean;
};

/** Which of a person's preferences for a Bot to change. Absent means "leave it alone". */
export type AgentPreferencePatch = {
  hidden?: boolean;
  notify?: boolean;
};

export type CreateAgentInput = Pick<
  AgentProfile,
  "name" | "roleDescription"
> & {
  /**
   * The AG-UI endpoint this Bot runs on, or undefined for the one in the box.
   *
   * This field is the AG-UI endpoint for a customer-provided agent. Without it the Bot runs on the
   * built-in endpoint.
   */
  endpoint?: string;
  /*
   * No `avatarSeed`. The face is given when the Bot is made and nothing changes it afterwards
   * (2026-10-08, docs/laf/redesign-2026-10.md §8); `AgentProfile.avatarSeed` is read, never written.
   */
  /**
   * How hard it thinks.
   *
   * Absent means "leave it alone": a form that saves a name must not reset a setting it did not
   * show, and a Bot made before anybody could choose keeps the column's default.
   */
  effort?: AgentEffort;
  /**
   * The standing instruction for waving actions through, when a person is changing it.
   *
   * Absent leaves it alone. An empty string is a real value and clears it, which is how somebody
   * takes the instruction back.
   */
  autoReview?: string;
  /**
   * A key this agent sits behind, if any.
   *
   * Write-only. It goes to the vault and is never read back to a person: the edit form shows that a
   * key is set, not what it is. Absent on an update means "leave whatever is there alone", which is
   * why it is optional rather than defaulting to empty; a blank field must not drop a key.
   */
  auth?: { header: string; value: string };
};
