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
} as const;

export type HubRole = "owner" | "admin" | "member";
export const HUB_ROLES: readonly HubRole[] = ["owner", "admin", "member"];

export type HubMemberState = "active" | "left";

/**
 * The kinds of change an event names. A VM drops a type it does not know.
 *
 * - `member.changed`: a member joined, changed or left. `refId` is the member id.
 * - `task.changed`: a task was made, edited, noted, taken, let go or freed by the sweep. `refId` is
 *   the task id. Seen by whoever can see the task — and, when its visibility or members narrow, by
 *   those who could see it a moment ago, so a board drops what it may no longer show.
 * - `task.assigned`: a task was given to somebody. `refId` is the task id. Seen by the assigned
 *   member alone (`m:` or `bot:`), whose VM is the one that acts on it; for a `job:` assignee, by
 *   whoever can see the task, since the job's own VM is not a member the hub knows yet.
 */
export const HUB_EVENT_TYPES = [
  "member.changed",
  "task.changed",
  "task.assigned",
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
};

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
 * THE TASK BOARD (`/hub/v1/tasks`).
 *
 * A task moves `todo` → `doing` (a run took it) → `review` or `blocked` (the run finished, or met
 * something a person has to allow) → `done`, which only a person sets: whether a piece of work is
 * finished is a person's judgement, never a Bot's.
 */
export const HUB_TASK_STAGES = [
  "todo",
  "doing",
  "review",
  "blocked",
  "done",
] as const;
export type HubTaskStage = (typeof HUB_TASK_STAGES)[number];

/** The stages a 라피 may move a task it holds to. Never `done`. */
export const HUB_TASK_BOT_STAGES: readonly HubTaskStage[] = [
  "review",
  "blocked",
];

/**
 * How long a run's claim on a task lasts without a heartbeat. Shorter than a routine's ten-minute
 * ceiling, so a task whose VM died is free again before a run that size would have ended.
 */
export const HUB_TASK_LOCK_MS = 5 * 60 * 1000;

/**
 * How often a run holding a task says it is still working on it. Two beats fit in one lock.
 *
 * @public The VM's run beats on this; that side arrives with the VM taking up `task.assigned`.
 */
export const HUB_TASK_HEARTBEAT_MS = 2 * 60 * 1000;

/** How often the hub frees the claims whose time ran out. */
export const HUB_TASK_SWEEP_MS = 60 * 1000;

/** The facts the task routes answer with, beside `HUB_FACTS`. */
export const HUB_TASK_FACTS = {
  /** Another run holds the task, or it is not waiting to be taken. Not retried: the run stops. */
  taken: "laf:task_taken",
  /** The edit was made against an older version. The surface reads the task again. */
  stale: "laf:task_stale",
  /** The run does not hold the task (it was freed, or another run took it). The run stops. */
  notHeld: "laf:task_not_held",
  /** A 라피 tried to set `done`, which only a person does. */
  doneByPerson: "laf:task_done_by_person",
} as const;

export const HUB_TASK_LIMITS = {
  title: 200,
  description: 10_000,
  /** A person's note. */
  note: 4_000,
  /** A 라피's note: one line of fact or link, never a report. */
  botNote: 500,
  members: 50,
  /** Tasks in one page of `GET /tasks`, and the page with no `limit`. */
  page: 200,
  pageDefault: 100,
} as const;

/**
 * Who may see a task, as it is asked for. The hub stores the row's visibility the way it stores a
 * file's — `company`, `me:<member>`, `task:<task id>` — and answers with the stored form.
 *
 * - `company`: every member.
 * - `me`: the member who made it, alone.
 * - `members`: the task's members (`hub_task_members`); its maker is always one of them.
 */
export type HubTaskVisibilityChoice = "company" | "me" | "members";

/**
 * `m:<member>` is a person, `bot:<member>` that person's 라피, `job:<id>` a scheduled job (a sub-Bot)
 * on its owner's VM.
 */
export type HubTaskAssignee = `m:${string}` | `bot:${string}` | `job:${string}`;

export type HubTask = {
  id: string;
  title: string;
  description: string | null;
  stage: HubTaskStage;
  /** `company`, `me:<member>` or `task:<this id>`. */
  visibility: string;
  members: string[];
  assignee: string | null;
  assignedBy: string | null;
  createdBy: string | null;
  /** The run holding the task and until when, or null when nobody does. */
  checkout: { runId: string; by: string; until: string } | null;
  /** Sent back on a person's edit; a different number is `laf:task_stale`. */
  version: number;
  /** Order inside a stage's column, smallest first. */
  rank: number;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
};

export type HubTaskNote = {
  id: number;
  /** `m:<member>` or `bot:<member>`. */
  by: string;
  text: string;
  runId: string | null;
  at: string;
};

/** `GET /hub/v1/tasks?stage=&cursor=&limit=`, newest first. `next` goes back as `cursor`. */
export type HubTaskList = { ok: true; tasks: HubTask[]; next: string | null };

/** `GET /hub/v1/tasks/:id`. */
export type HubTaskDetail = { ok: true; task: HubTask; notes: HubTaskNote[] };
