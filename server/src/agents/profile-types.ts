export type AgentVisibility = "public" | "private";

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
  title: string;
  roleDescription: string;
  avatarSeed: string;
  effort: AgentEffort;
  visibility: AgentVisibility;
  ownerUserId: string | null;
  systemOwned: boolean;
  hidden: boolean;
  /**
   * When this person pinned the Bot, or null. A time rather than a flag so pinned Bots hold a
   * stable order among themselves instead of re-shuffling whenever one of them speaks.
   */
  pinnedAt: Date | null;
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
  pinned?: boolean;
  notify?: boolean;
};

export type CreateAgentInput = Pick<
  AgentProfile,
  "name" | "title" | "roleDescription" | "visibility"
> & {
  /**
   * The AG-UI endpoint this Bot runs on, or undefined for the one in the box.
   *
   * This field is the AG-UI endpoint for a customer-provided agent. Without it the Bot runs on the
   * built-in endpoint.
   */
  endpoint?: string;
  /**
   * Which face this Bot wears, when somebody picked one.
   *
   * Absent means "leave it alone", the same as `auth`: an edit form that saves a name must not also
   * silently reset a face, and a Bot created before anybody could choose keeps the seed it was made
   * with. The client sends the id of a tile; anything else is hashed into one at render, so an
   * unknown value degrades to a face rather than to nothing.
   */
  avatarSeed?: string;
  /**
   * How hard it thinks.
   *
   * Absent means "leave it alone", like the face: a form that saves a name must not reset a setting
   * it did not show, and a Bot made before anybody could choose keeps the column's default.
   */
  effort?: AgentEffort;
  /**
   * A key this agent sits behind, if any.
   *
   * Write-only. It goes to the vault and is never read back to a person: the edit form shows that a
   * key is set, not what it is. Absent on an update means "leave whatever is there alone", which is
   * why it is optional rather than defaulting to empty; a blank field must not drop a key.
   */
  auth?: { header: string; value: string };
};
