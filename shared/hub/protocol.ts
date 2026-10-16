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
 */
export const HUB_EVENT_TYPES = [
  "member.changed",
  "room.changed",
  "room.message",
  "room.mention",
  "file.changed",
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
 * The hub decides it in the query itself (`hub_visible_to` in `hub/drizzle/0001_hub_files.sql`),
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
