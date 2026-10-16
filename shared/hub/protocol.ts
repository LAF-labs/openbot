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
  /** The hub's file space is full (its disk, or the company's share of it). Reads still work. */
  full: "laf:hub_full",
  /** One file is larger than `HUB_FILE_MAX_BYTES`. */
  fileTooLarge: "laf:hub_file_too_large",
  /** The hub is reading as many uploads as it takes at once. Retried, after `Retry-After`. */
  busy: "laf:hub_busy",
  /** The hub holds no file space (`HUB_FILES_DIR` unset): files and search are not offered. */
  filesUnset: "laf:hub_files_unset",
  /**
   * The file is known but its bytes are not on the hub's disk yet — a hub rebuilt from its database
   * dump before its blobs came back from the bucket. Retried, after `Retry-After`.
   */
  blobRestoring: "laf:hub_blob_restoring",
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
 * - `member.changed`: a member joined, changed or left. `refId` is the member id.
 * - `room.changed`: a room was made, or somebody was added to or taken out of it. `refId` is the
 *   room id. Seen by the room's members after the change and by whoever was taken out, so a VM
 *   learns of a room it was added to and drops one it left.
 * - `room.message`: a message was posted. `refId` is `<room id>:<seq>` (`roomMessageRef`). Seen by
 *   the room's members.
 * - `room.mention`: a message mentions somebody. Same `refId`. A member mention is seen by that
 *   member; a `lafi` mention is seen by the message's author ONLY, because the 라피 that answers is
 *   the one on the caller's own VM — the others are never asked.
 * - `file.changed`: a team file was uploaded, changed, moved or deleted. `refId` is the file id.
 *   Seen by whoever the file's visibility admits.
 * - `skill.changed` and `memory.changed` carry the collection's new `version`; `memory.proposals`
 *   (a line proposed, or a proposal turned down) is seen only by the admins and the proposer, and
 *   changes nothing any Bot reads.
 * - `task.changed`: a task was made, edited, noted, taken, let go or freed by the sweep. `refId` is
 *   the task id. Seen by whoever can see the task — and, when its visibility or members narrow, by
 *   those who could see it a moment ago, so a board drops what it may no longer show.
 * - `task.assigned`: a task was given to somebody. `refId` is the task id. Seen by the assigned
 *   member alone (`m:` or `bot:`), whose VM is the one that acts on it; for a `job:` assignee, by
 *   whoever can see the task, since the job's own VM is not a member the hub knows yet.
 * - `vault.changed`: a company login was stored or changed, who may use it changed, or a VM
 *   verified itself on it. `refId` is the login id. Never a value: the VM asks `GET /vault`.
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
  "vault.changed",
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

/** What a message mentions to ask the author's own 라피, beside member ids. */
export const HUB_LAFI_MENTION = "lafi";

/** Bounds on what a room and a message may hold. A message is chat, not a document. */
export const HUB_ROOM_LIMITS = {
  /** Characters in a room's name. */
  name: 100,
  /** Characters in a message. Longer goes in a file. */
  text: 4_000,
  /** Distinct mentions in one message, `lafi` included. */
  mentions: 20,
  /** File ids attached to one message. */
  files: 10,
  /** Members named when a room is made, or added in one call. */
  members: 50,
  /** Messages in one page of `GET /rooms/:id/messages`, and the page with no `limit`. */
  page: 200,
  pageDefault: 50,
} as const;

/** `room.message` and `room.mention` name one message: its room and its number there. */
export const roomMessageRef = (roomId: string, seq: number): string =>
  `${roomId}:${seq}`;

export type HubRoom = {
  id: string;
  name: string;
  /** Member ids, the caller among them. */
  members: string[];
  /** The newest message's number in this room, 0 when it has none. */
  lastSeq: number;
  createdBy: string | null;
  /** ISO 8601. */
  createdAt: string;
};

/** `GET /hub/v1/rooms`: the rooms the caller is in, and only those. */
export type HubRooms = { ok: true; rooms: HubRoom[] };

export type HubRoomMessage = {
  seq: number;
  /** `m:<member id>` for a person, `bot:<member id>` for that person's 라피. */
  by: string;
  text: string;
  /** Member ids and `lafi`. */
  mentions: string[];
  runId: string | null;
  files: string[];
  /** ISO 8601. */
  at: string;
};

/**
 * `GET /hub/v1/rooms/:id/messages`, oldest first.
 *
 * `?since=<seq>` is the messages after it, and `seq` is where the next call starts; `more` says
 * the page was full. `?before=<seq>` is the page just before it, for reading back. Neither is the
 * newest page, which is what a 라피 reads before it answers in a room.
 */
export type HubRoomMessages = {
  ok: true;
  messages: HubRoomMessage[];
  seq: number;
  more: boolean;
};

/**
 * `POST /hub/v1/rooms/:id/messages`, with an `Idempotency-Key`. `as: "bot"` is the author's 라피
 * posting (stored as `bot:<member>`); a 라피 cannot mention `lafi`, or two VMs' answers could call
 * each other forever.
 */
export type HubRoomPost = {
  text: string;
  mentions?: string[];
  as?: "member" | "bot";
  runId?: string | null;
  files?: string[];
};

/**
 * THE COMPANY LOGIN VAULT (`hub/src/vault.ts`). An admin stores a login once and grants it to
 * members; a member's VM leases it, opens it once per lease, and says when it verified a new
 * device. Only `POST /vault/:id/open` ever answers with a value.
 */
export const HUB_VAULT_FACTS = {
  /** `HUB_KEY_ENCRYPTION_KEY` is not set on this hub: the vault answers nothing else. */
  unset: "laf:hub_vault_unset",
  /** Another member's VM holds this login's lease; `busy` says whose and until when. */
  busy: "laf:vault_busy",
  /** The lease is unknown, another member's, expired, released or already opened. */
  leaseInvalid: "laf:vault_lease_invalid",
  /** The page the VM would fill is not one of the login's origins. */
  originMismatch: "laf:login_origin_mismatch",
  /** The sealed row did not open under this hub's key. */
  sealUnreadable: "laf:login_seal_unreadable",
} as const;

/** How long a lease holds a login before it lapses on its own; renewed by leasing again with it. */
export const HUB_VAULT_LEASE_MS = 10 * 60 * 1000;

/** Bounds on what one login may hold. */
export const HUB_VAULT_LIMITS = {
  label: 100,
  site: 200,
  origins: 10,
  username: 512,
  password: 1024,
  members: 200,
} as const;

/** One row of `GET /hub/v1/vault`. Nothing in it is a value. */
export type HubVaultLogin = {
  id: string;
  label: string;
  site: string | null;
  /** Where its values may be filled, as `https://host[:port]`. */
  origins: string[];
  /** Whether the caller holds a grant for it. */
  canUse: boolean;
  /** Any number of VMs may hold it at once: leasing never answers busy. */
  concurrent: boolean;
  /** Of the VMs that may use it, how many have verified themselves as a device on the site. */
  verifiedVms: number;
  totalVms: number;
  /** Another member's VM holds it now. Absent when nobody else does. */
  busy?: { member: string; until: string };
};

export type HubVault = { ok: true; logins: HubVaultLogin[] };

/** `PUT /hub/v1/vault/:id` (admin). The two values may be left out on a change to keep them. */
export type HubVaultPut = {
  label: string;
  site?: string | null;
  origins: string[];
  username?: string;
  password?: string;
  concurrent?: boolean;
};

/** `POST /hub/v1/vault/:id/lease`. `lease` renews the caller's own lease instead of taking one. */
export type HubVaultLeaseAsk = {
  origin: string;
  runId?: string | null;
  lease?: string;
};

export type HubVaultLease = {
  ok: true;
  lease: string;
  /** ISO 8601. */
  until: string;
  concurrent: boolean;
};

/** `POST /hub/v1/vault/:id/open`: the values, once per lease. */
export type HubVaultOpened = { ok: true; username: string; password: string };

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
 * Who may see a file, its chunks and the events about it — the same three values everywhere the
 * hub keeps something a member may not see:
 *
 * - `company`: every member.
 * - `me:<member id>`: that member alone.
 * - `task:<task id>`: the members of that task (`hub_task_members`).
 *
 * The hub decides it in the query itself (`hub_visible_to` in `hub/drizzle/0002_hub_files.sql`),
 * never by filtering a page afterwards.
 */
export type HubVisibility = "company" | `me:${string}` | `task:${string}`;

/** One file, at its newest version, as a list or `GET /files/:id` gives it. */
export type HubFile = {
  id: string;
  name: string;
  /** `/` or `/a/b`: where it sits in the company's folders. */
  folder: string;
  /** Bytes of the newest version. */
  size: number;
  version: number;
  sha256: string;
  mime: string | null;
  /** The member who wrote the newest version. */
  by: string | null;
  /** ISO 8601: when the newest version was written. */
  at: string;
  visibility: HubVisibility;
  /** Whether the uploading VM sent the words read out of it, so `/text` and search have them. */
  hasText: boolean;
};

/** `GET /hub/v1/files?folder=&cursor=`. `next` goes back as `cursor`; null on the last page. */
export type HubFileList = { ok: true; files: HubFile[]; next: string | null };

/** The most one `GET /files` page lists. */
export const HUB_FILES_PAGE = 100;

/** The largest file the hub takes: the same gigabyte a Bot's own download may be. */
export const HUB_FILE_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * The most text one file carries, in characters. The uploading VM's converter reads a document
 * into words; a file whose words run past this is refused rather than cut silently, since a
 * search that misses the second half of a file it claims to have read is worse than a refusal.
 */
export const HUB_TEXT_MAX_CHARS = 2_000_000;

/** The most one `GET /files/:id/text` hands back. */
export const HUB_TEXT_READ_MAX = 20_000;

/** `GET /hub/v1/files/:id/text?from=&limit=`: characters `from` up to `from + limit`. */
export type HubFileText = {
  ok: true;
  text: string;
  from: number;
  /** All the characters the file's text holds. */
  total: number;
  /** More follows: ask again with `from` set to `from + text.length`. */
  truncated: boolean;
};

/**
 * `PUT /hub/v1/files`, multipart, with an `Idempotency-Key`:
 *
 * - `meta` (JSON): `{ name, folder?, visibility? }` for a new file, or `{ id }` for a new version
 *   of one — a version keeps the file's name, folder and visibility.
 * - `text` (optional): the words the VM's converter read out of the file.
 * - `blob`: the file's bytes.
 */
export type HubFilePutMeta =
  | { id: string }
  | { name: string; folder?: string; visibility?: HubVisibility };

export type HubFilePut = {
  ok: true;
  id: string;
  version: number;
  sha256: string;
};

/** How a file's text is cut for search: 1,200 characters, each overlapping the last by 200. */
export const HUB_CHUNK_CHARS = 1_200;
export const HUB_CHUNK_OVERLAP = 200;

/** `POST /hub/v1/search` — a POST because what a person looks for is content, kept out of logs. */
export type HubSearchRequest = {
  q: string;
  /** Hits wanted, at most `HUB_SEARCH_MAX_HITS`; `HUB_SEARCH_HITS` when absent. */
  limit?: number;
  /** A task the asking run works on: its files rank higher. */
  task?: string;
};

export const HUB_SEARCH_HITS = 10;
export const HUB_SEARCH_MAX_HITS = 30;
/** How much of a chunk a hit carries. */
export const HUB_SNIPPET_CHARS = 300;

export type HubSearchHit = {
  kind: "file";
  /** The file's id: `GET /files/:id/text?from=` reads on from `where.from`. */
  id: string;
  title: string;
  where: { folder: string; from: number };
  snippet: string;
  score: number;
  at: string;
  by: string | null;
};

export type HubSearchResult = { ok: true; hits: HubSearchHit[] };

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

/**
 * The registry's answer to a `member.put` with `state: "left"`. `vault.origins` are the origins of
 * every company login the member was granted or opened — never a value — so whoever disconnects
 * that VM (laf-control) can have it clear those sites' cookies, and only those. Read in the same
 * transaction that drops the member's grants, because after it commits the VM's pass opens
 * nothing and it could not ask.
 */
export type HubFleetLeft = {
  ok: true;
  member: { id: string; state: "left" };
  seq?: number;
  vault: { origins: string[] };
};
