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
   * A document block is not as the writer last read it: its `version` (a person's save) or its
   * `expectHash` (라피's change) no longer matches, or it is gone. The answer carries the block as
   * it is now (`block`, null when deleted); the writer reads again and reapplies.
   */
  docBlockChanged: "laf:doc_block_changed",
  /** Somebody is writing in that block now ("쓰는 중"). The answer names who (`holder`). */
  docBlockBusy: "laf:doc_block_busy",
} as const;

export type HubRole = "owner" | "admin" | "member";
export const HUB_ROLES: readonly HubRole[] = ["owner", "admin", "member"];

export type HubMemberState = "active" | "left";

/** The kinds of change an event names. A VM drops a type it does not know. */
export const HUB_EVENT_TYPES = [
  "member.changed",
  "file.changed",
  /** A document's title, place or existence changed, or its blocks were renumbered: read it whole. */
  "doc.changed",
  /** One block changed; `refId` is `<doc id>/<block id>`: read that block again (404: it is gone). */
  "doc.block_changed",
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
export type HubSocketFrame = ({ kind: "event" } & HubEvent) | HubDocLockFrame;

/**
 * A light frame, not an event: who is writing in which block, sent to the sockets of the members who
 * may see the document each time a hold is taken, renewed or let go. Not numbered and not kept — a
 * hold lives seconds, and `GET /docs/:id` lists the holds standing when a document is opened. A VM
 * that does not know the kind drops it. `until` null: let go.
 */
export type HubDocLockFrame = {
  kind: "doc.lock";
  doc: string;
  block: string;
  member: string;
  name: string | null;
  /** ISO 8601, or null when the hold was let go. */
  until: string | null;
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
  /**
   * What to look in. Absent: everything this hub can search. A kind this hub does not search yet is
   * ignored rather than refused, since a VM a version ahead may name one.
   */
  kinds?: string[];
  /** Hits wanted, at most `HUB_SEARCH_MAX_HITS`; `HUB_SEARCH_HITS` when absent. */
  limit?: number;
  /** A task the asking run works on: its files rank higher. */
  task?: string;
};

export const HUB_SEARCH_HITS = 10;
export const HUB_SEARCH_MAX_HITS = 30;
/** How much of a chunk a hit carries. */
export const HUB_SNIPPET_CHARS = 300;

/** The kinds `POST /search` looks in now. */
export const HUB_SEARCH_KINDS = ["file", "doc"] as const;
export type HubSearchKind = (typeof HUB_SEARCH_KINDS)[number];

type HubSearchHitCommon = {
  title: string;
  snippet: string;
  score: number;
  at: string;
  by: string | null;
};

export type HubSearchHit =
  | (HubSearchHitCommon & {
      kind: "file";
      /** The file's id: `GET /files/:id/text?from=` reads on from `where.from`. */
      id: string;
      where: { folder: string; from: number };
    })
  | (HubSearchHitCommon & {
      kind: "doc";
      /** The document's id; `where.block` is the block the words were found in (null: the title). */
      id: string;
      where: { folder: string; block: string | null };
    });

export type HubSearchResult = { ok: true; hits: HubSearchHit[] };

/* ── Team documents (`/hub/v1/docs`) ─────────────────────────────────────────────────────────── */

/**
 * A team document is an ordered list of blocks, each one plain text of a fixed kind. People edit a
 * block at a time; 라피 changes single blocks after reading them. There is no operation that
 * replaces a whole document.
 */
export const HUB_DOC_BLOCK_KINDS = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "list",
  "check",
  "quote",
  "code",
  "divider",
  "table",
  "file",
  "task-link",
] as const;
export type HubDocBlockKind = (typeof HUB_DOC_BLOCK_KINDS)[number];

/**
 * What a block carries beside its text, by kind; a key another kind does not take is refused.
 *
 * - `list`: `ordered` (numbered), `indent` 0–3. `check`: `checked`, `indent` 0–3.
 * - `code`: `lang` (a short name such as `ts`).
 * - `table`: `rows`, the cells row by row, the first row the header; its `text` is empty.
 * - `file`: `fileId` (a team file); `task-link`: `taskId`. Their `text` is the label shown.
 */
export type HubDocBlockAttrs = {
  ordered?: boolean;
  checked?: boolean;
  indent?: number;
  lang?: string;
  rows?: string[][];
  fileId?: string;
  taskId?: string;
};

export type HubDocBlock = {
  id: string;
  kind: HubDocBlockKind;
  text: string;
  attrs: HubDocBlockAttrs;
  /** Counts content changes (kind, text, attrs). A person's save sends the one it read. */
  version: number;
  /** A short digest of kind, text and attrs. 라피 sends the one it read as `expectHash`. */
  hash: string;
  /** Where the block sits: blocks are in ascending order of `rank`, compared character by character. */
  rank: string;
  by: string | null;
  /** ISO 8601. */
  at: string;
};

export type HubDoc = {
  id: string;
  title: string;
  folder: string;
  visibility: HubVisibility;
  /** Counts every accepted change to the document (one per batch, rename or snapshot). */
  rev: number;
  createdBy: string | null;
  updatedBy: string | null;
  /** ISO 8601. */
  updatedAt: string;
};

/** A standing hold: `member` is writing in `block` until `until` unless they renew it. */
export type HubDocLock = {
  block: string;
  member: string;
  name: string | null;
  until: string;
};

/** `GET /hub/v1/docs?folder=&cursor=`: newest change first. */
export type HubDocList = { ok: true; docs: HubDoc[]; next: string | null };

/** `GET /hub/v1/docs/:id`. */
export type HubDocRead = {
  ok: true;
  doc: HubDoc;
  blocks: HubDocBlock[];
  locks: HubDocLock[];
};

/**
 * `POST /hub/v1/docs` with an `Idempotency-Key`: a new document, its first blocks given as blocks or
 * as markdown (one empty paragraph when neither).
 */
export type HubDocCreate = {
  title: string;
  folder?: string;
  visibility?: HubVisibility;
  blocks?: { kind: HubDocBlockKind; text?: string; attrs?: HubDocBlockAttrs }[];
  markdown?: string;
};

/**
 * One change in `POST /hub/v1/docs/:id/blocks`. Every op that touches a block names what its writer
 * read of it: `version` for a person's save, `expectHash` for 라피's. A request that says it is not
 * a person's (`x-laf-origin` other than `person`) must use `expectHash`.
 *
 * - `replace`: the block `id` takes the given `kind`, `text` and `attrs` (an absent one is kept).
 * - `insert_after`: a new block after `id` (null: at the top). The check names `id`, the anchor, and
 *   is required of 라피; `newId` lets the writer name the new block (`b_` and 10–40 of a–z, 0–9).
 * - `delete`: the block `id` goes.
 * - `move`: the block `id` goes after `after` (null: to the top).
 *
 * Ops apply in order and the checks read the document as the earlier ops left it. All or none: the
 * first op refused refuses the batch, and the answer says which (`op`).
 */
export type HubDocOp =
  | {
      op: "replace";
      id: string;
      version?: number;
      expectHash?: string;
      kind?: HubDocBlockKind;
      text?: string;
      attrs?: HubDocBlockAttrs;
    }
  | {
      op: "insert_after";
      id: string | null;
      version?: number;
      expectHash?: string;
      newId?: string;
      kind?: HubDocBlockKind;
      text?: string;
      attrs?: HubDocBlockAttrs;
    }
  | { op: "delete"; id: string; version?: number; expectHash?: string }
  | {
      op: "move";
      id: string;
      after: string | null;
      version?: number;
      expectHash?: string;
    };

/** The answer to an accepted batch: every block it wrote, and the ids it deleted. */
export type HubDocOpsResult = {
  ok: true;
  rev: number;
  blocks: HubDocBlock[];
  deleted: string[];
};

/** The refusal of a batch: which op, and the block as it is now (null when gone). */
export type HubDocOpsRefusal = {
  ok: false;
  code: string;
  op: number;
  block?: HubDocBlock | null;
  holder?: { member: string; name: string | null; until: string };
};

/** `POST /docs/:id/blocks/:bid/lock`: held until `until`; renew before it, every 5 s. */
export type HubDocLockResult = {
  ok: true;
  until: string;
  ttlMs: number;
  /** How often to renew it while the block stays open. */
  renewMs: number;
};

/** `GET /docs/:id/markdown`: the blocks drawn as markdown, each after a `<!-- <id> <hash> -->` line. */
export type HubDocMarkdown = { ok: true; rev: number; markdown: string };

export type HubDocVersionHead = {
  version: number;
  title: string;
  by: string | null;
  at: string;
  blocks: number;
};

/** `GET /docs/:id/versions/:v`: the block list as it was when the snapshot was taken. */
export type HubDocVersion = {
  ok: true;
  version: number;
  title: string;
  by: string | null;
  at: string;
  blocks: Omit<HubDocBlock, "rank" | "by" | "at">[];
};

/** How long a hold lasts unless renewed; the editor renews every `HUB_DOC_LOCK_RENEW_MS`. */
export const HUB_DOC_LOCK_TTL_MS = 15_000;
export const HUB_DOC_LOCK_RENEW_MS = 5_000;
/** The most text one block holds, in characters. */
export const HUB_DOC_BLOCK_MAX_CHARS = 20_000;
/** The most blocks one document holds. */
export const HUB_DOC_MAX_BLOCKS = 5_000;
/** The most ops one batch carries. */
export const HUB_DOC_MAX_OPS = 200;
export const HUB_DOCS_PAGE = 100;
