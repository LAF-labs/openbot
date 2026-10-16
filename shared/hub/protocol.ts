/**
 * The company hub's wire contract, written once for both ends: the hub (`hub/`) and the VM server
 * that will talk to it. Types and constants only, so either side imports it without pulling the
 * other's code.
 *
 * WHY A NUMBER AND NOT A NEGOTIATION. A hub and its members' VMs are upgraded separately, so for a
 * while they run different builds. `/me` says which protocol the hub speaks; a hub that is one
 * version ahead still answers what an older VM asks, and a VM meeting an event type it does not
 * know drops it. One version of difference is what is allowed, which is why a hub is upgraded
 * before the VMs that use it.
 *
 * EVERY ANSWER IS A FACT. `{ ok: true, … }` or `{ ok: false, code: "laf:…" }` and never a sentence:
 * the surface that shows a failure owns its words, as everywhere else in this repository.
 */

export const HUB_PROTOCOL = 1;

/** Every route the hub answers sits under this prefix. */
export const HUB_PREFIX = "/hub/v1";

/** The request headers a VM adds. Values are identifiers for the trail, never content. */
export const HUB_HEADERS = {
  /** Repeated writes with the same key get the first answer back instead of a second write. */
  idempotencyKey: "idempotency-key",
  /** The VM's own run id (a turn's or a routine's), so the hub's trail joins the VM's. */
  run: "x-laf-run",
  /** What started the call on the VM: `chat`, `room`, `job` or `person` (pressed by the person). */
  origin: "x-laf-origin",
  /** The VM's public origin. When sent, it has to match the one the member row holds. */
  vm: "x-laf-vm",
} as const;

/** The facts a VM can be told. Its surface owns the sentence for each. */
export const HUB_FACTS = {
  /** The hub did not answer (network, timeout, or a 5xx after the retries). */
  unreachable: "laf:hub_unreachable",
  /** The pass was refused: unknown, rotated away, or its member has left. Not retried. */
  passRefused: "laf:hub_pass_refused",
  /** The member is known but may not do this. */
  forbidden: "laf:hub_forbidden",
  /** Nothing the member may see answers to that id. */
  notFound: "laf:hub_not_found",
  /** A team-memory line that is not waiting for confirmation was asked to be confirmed. */
  memoryNotProposed: "laf:memory_not_proposed",
  /** The same words as a team-memory line an admin retired. Refused, not stored again. */
  memoryRestatedRetired: "laf:memory_restated_retired",
  /** The product's own refusals for a 수첩 line (`server/src/agents/routes.ts`), here for a team one. */
  memoryLooksLikeASecret: "laf:memory_looks_like_a_secret",
  memoryLooksLikeInstruction: "laf:memory_looks_like_instruction",
  /** A team skill's title or summary — which ride in every member's prompt — shaped as a secret. */
  skillLooksLikeASecret: "laf:skill_looks_like_a_secret",
  /** …or shaped as a prompt: a role marker, a rule override, a tool call. */
  skillLooksLikePrompt: "laf:skill_looks_like_prompt",
} as const;

export type HubRole = "owner" | "admin" | "member";
export const HUB_ROLES: readonly HubRole[] = ["owner", "admin", "member"];

export type HubMemberState = "active" | "left";

/**
 * The kinds of change an event names. A VM drops a type it does not know.
 *
 * `skill.changed` and `memory.changed` carry the collection's new `version`; `memory.proposals`
 * (a line proposed, or a proposal turned down) is seen only by the admins and the proposer, and
 * changes nothing any Bot reads.
 */
export const HUB_EVENT_TYPES = [
  "member.changed",
  "skill.changed",
  "memory.changed",
  "memory.proposals",
] as const;
export type HubEventType = (typeof HUB_EVENT_TYPES)[number];

/**
 * One change, by number. It names what changed and never carries it: the VM asks for the thing
 * itself over HTTP, where the hub decides again whether that member may see it.
 */
export type HubEvent = {
  seq: number;
  type: string;
  refId: string | null;
  /** The member whose action this was, or null for the hub's own (a registry change). */
  actor: string | null;
  /** ISO 8601. */
  at: string;
  /** The collection's version after the change, on the types that have one; absent otherwise. */
  version?: number;
};

export type HubFailure = { ok: false; code: string };

/** `GET /hub/v1/me`. */
export type HubMe = {
  ok: true;
  member: { id: string; role: HubRole; name: string | null };
  workspace: { id: string; name: string } | null;
  protocol: number;
  /** An address in the hub's private network a VM in the same one tries first, or null. */
  privateIp: string | null;
  /** The newest event number now; a VM with no cursor starts here. */
  seq: number;
  /** What a VM's caches of the team's skills and memory are compared against. */
  versions: HubVersions;
};

/** One number per cached collection, 0 before its first change. */
export type HubVersions = { skills: number; memory: number };

/** The most `GET /sync` returns at once. */
export const HUB_SYNC_LIMIT = 500;

/**
 * `GET /hub/v1/sync?since=<seq>`.
 *
 * `seq` is where the next call starts. It can be past the last event listed: events this member
 * may not see still move the cursor, so they are not scanned again. `more` says the page was full
 * and the next call will have more.
 */
export type HubSync = {
  ok: true;
  events: HubEvent[];
  seq: number;
  more: boolean;
};

/**
 * `WS /hub/v1/events?since=<seq>` — frames from the hub. Missed events (after `since`) come first,
 * then each new one as it is committed. Pings and pongs are `shared/channel-socket.ts`'s frames:
 * the hub pings every ten seconds and closes a socket it has not heard from in thirty.
 */
export type HubSocketFrame = { kind: "event" } & HubEvent;

/** The internal registry route laf-control signs (`POST /hub/v1/fleet`). */
export const HUB_FLEET_PATH = `${HUB_PREFIX}/fleet`;

/** The HMAC header and the event header, the fleet webhook's two. */
export const HUB_FLEET_HEADERS = {
  signature: "x-laf-signature",
  event: "x-laf-event",
} as const;

/**
 * The label the hub's fleet key is derived under: `HMAC-SHA256(master, "<label> <hub origin>")`,
 * hex. laf-control derives it from its master and the hub's origin; the hub holds only the result
 * (`HUB_FLEET_SECRET`), so one hub's key signs nothing another hub accepts.
 */
export const HUB_FLEET_KEY_LABEL = "laf-hub-fleet/v1";

/**
 * A member as the registry pushes it. `vmKeyHash` is the SHA-256 (hex) of the pass the VM made for
 * itself; the pass never leaves that VM.
 */
export type HubFleetMember = {
  email: string;
  role: HubRole;
  name?: string | null;
  vmOrigin: string;
  vmKeyHash: string;
  state: HubMemberState;
};

/**
 * The signed envelope. `id` is the idempotency key (inside the signed bytes, so a replay cannot
 * change it); `at` must be within five minutes of the hub's clock; `hub` must be this hub's origin.
 */
export type HubFleetEnvelope =
  | {
      event: "member.put";
      id: string;
      at: string;
      hub: string;
      member: HubFleetMember;
    }
  | {
      event: "workspace.put";
      id: string;
      at: string;
      hub: string;
      workspace: { name: string; plan?: string | null };
    };

/**
 * A team skill as `GET /hub/v1/skills` lists it: everything but the instructions, which a Bot reads
 * one skill at a time (`GET /hub/v1/skills/:slug`).
 *
 * `version` is this skill's own count of saves. `edited` says the team changed an industry pack's
 * skill since it was shipped (always false on one the team wrote).
 */
export type HubSkillEntry = {
  slug: string;
  title: string;
  summary: string;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  /** ISO 8601, the last save. */
  at: string;
  profile: string | null;
  shippedVersion: string | null;
  edited: boolean;
};

export type HubSkillList = {
  ok: true;
  skills: HubSkillEntry[];
  /** The `skills` collection version. */
  version: number;
};

export type HubSkill = {
  ok: true;
  skill: HubSkillEntry & { instructions: string };
};

/** `PUT /hub/v1/skills/:slug`. Only an admin may send `pack`. */
export type HubSkillPut = {
  title: string;
  summary?: string;
  instructions: string;
  pack?: { profile: string; version: string };
};

export const HUB_SKILL_LIMITS = {
  title: 120,
  summary: 500,
  instructions: 20_000,
} as const;

/** One team-memory line, as long as a person's 수첩 line may be (`shared/notebook.ts`). */
export const HUB_MEMORY_LINE_MAX = 400;
/**
 * The whole team's confirmed lines, together. Past it the oldest confirmed lines are pushed out:
 * kept and marked, never deleted, and no longer read by any Bot.
 */
export const HUB_MEMORY_CAP = 1_500;
export const HUB_MEMORY_EXCERPT_MAX = 200;

/** Where the proposing Bot learned a line. `excerpt` is what the admin confirming it reads. */
export type HubMemoryEvidence = { kind: string; id: string; excerpt: string };

/** `POST /hub/v1/memory/proposals`. `runId` may come as the `x-laf-run` header instead. */
export type HubMemoryProposal = {
  content: string;
  evidence: HubMemoryEvidence;
  runId?: string;
};

/** `GET /hub/v1/memory`: the confirmed lines every Bot carries, oldest first. Nothing else. */
export type HubMemory = {
  ok: true;
  lines: { id: string; content: string; confirmedBy: string; at: string }[];
  version: number;
  /** Characters the lines take, of `cap`. */
  used: number;
  cap: number;
};

/** `GET /hub/v1/memory/proposals`: every waiting line for an admin, a member's own otherwise. */
export type HubMemoryProposals = {
  ok: true;
  proposals: {
    id: string;
    content: string;
    proposedBy: string;
    evidence: HubMemoryEvidence;
    at: string;
  }[];
};
