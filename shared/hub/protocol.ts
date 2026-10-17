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
 * Beside `member.changed`, the kinds the 회사 screen redraws on (`app/src/lib/hub/company.ts`):
 * the rooms' (#250, `laf/hub-rooms`), the team files' (`laf/hub-files`) and the skills' and team
 * memory's (`laf/hub-skills-memory`), and the task board's (#253, `laf/hub-tasks`). Each of those
 * branches adds its own here; at rebase the list is their union.
 */
export const HUB_EVENT_TYPES = [
  "member.changed",
  "room.changed",
  "room.message",
  "room.mention",
  "file.changed",
  "skill.changed",
  "memory.changed",
  "memory.proposals",
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

/**
 * `GET /hub/v1/members`: the company's members as any member may see them — who is in it and in
 * what role, so a room can show a name where its messages say `m:<id>`. No address, no VM origin:
 * an email is the registry's (laf-control's) to hold, not every colleague's.
 */
export type HubMemberList = {
  ok: true;
  members: { id: string; name: string | null; role: HubRole }[];
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
