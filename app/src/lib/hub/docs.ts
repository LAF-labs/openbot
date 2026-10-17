/**
 * 회사 → 문서: the team's documents, read and written through this VM's own server
 * (`server/src/hub/routes-ui-docs.ts`), which asks the company hub with the VM's pass. The browser
 * never learns the hub's address or the pass.
 *
 * A DOCUMENT IS A LIST OF BLOCKS (design §5): `{id, kind, text, attrs, version, hash}`, in order.
 * A person's save carries the block's `version`; the hub answers 409 when somebody saved it first,
 * and the editor reads the document again and reopens the block. A block somebody is writing in is
 * held ("쓰는 중") and read-only to everybody else.
 *
 * READ LENIENTLY. The hub's document routes are built beside this screen; what is read here is the
 * design's shape, and a field a newer hub adds is ignored. A body that is not the shape at all is
 * an error the screen says in one line, never half a document.
 */
import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { RequestRefusedError, requestOrRefusal } from "@/lib/refusals";
import { companyFactText } from "./company";
import { hubKeys } from "./status";

export const DOC_BLOCK_KINDS = [
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
export type DocBlockKind = (typeof DOC_BLOCK_KINDS)[number];

export type DocBlock = {
  id: string;
  kind: DocBlockKind;
  text: string;
  attrs: Record<string, unknown>;
  version: number;
  hash: string;
};

/** Who holds a block now, by member id. */
export type DocHold = { blockId: string; memberId: string };

export type DocSummary = {
  id: string;
  title: string;
  folder: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type OpenDoc = {
  doc: DocSummary;
  blocks: DocBlock[];
  holds: DocHold[];
};

/** A person's change to one block, as the hub's batch takes it. Never the whole document. */
export type DocOp =
  | {
      op: "replace";
      id: string;
      version: number;
      text?: string;
      kind?: DocBlockKind;
      attrs?: Record<string, unknown>;
    }
  | {
      op: "insert_after";
      /** The block it goes after; null for the top of the document. */
      id: string | null;
      kind: DocBlockKind;
      text: string;
      attrs?: Record<string, unknown>;
    }
  | { op: "delete"; id: string; version: number }
  | { op: "move"; id: string; version: number; after: string | null };

export const docKeys = {
  list: [...hubKeys.all, "docs"] as const,
  doc: (id: string) => [...hubKeys.all, "docs", id] as const,
};

/* ── reading what the hub answered ───────────────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

export function readBlock(value: unknown): DocBlock | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const kind = str(value.kind);
  if (!id || !kind || !(DOC_BLOCK_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  const version = typeof value.version === "number" ? value.version : 0;
  return {
    id,
    kind: kind as DocBlockKind,
    text: str(value.text) ?? "",
    attrs: isRecord(value.attrs) ? value.attrs : {},
    version,
    hash: str(value.hash) ?? "",
  };
}

function readSummary(value: unknown): DocSummary | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  if (!id) return null;
  return {
    id,
    title: str(value.title) ?? "",
    folder: str(value.folder) ?? "/",
    updatedAt: str(value.updatedAt) ?? str(value.at) ?? null,
    updatedBy: str(value.updatedBy) ?? str(value.by) ?? null,
  };
}

/** A hold as the hub names it: `{blockId, by}`, `by` a member id or `m:<id>`. */
function readHold(value: unknown): DocHold | null {
  if (!isRecord(value)) return null;
  const blockId = str(value.blockId) ?? str(value.block);
  const by = str(value.by) ?? str(value.memberId) ?? str(value.member);
  if (!blockId || !by) return null;
  return { blockId, memberId: by.startsWith("m:") ? by.slice(2) : by };
}

export function readOpenDoc(body: unknown): OpenDoc {
  if (!isRecord(body)) throw unreadable();
  const doc = readSummary(body.doc);
  if (!doc || !Array.isArray(body.blocks)) throw unreadable();
  const blocks = body.blocks.map(readBlock);
  if (blocks.some((block) => block === null)) throw unreadable();
  const holds = (Array.isArray(body.locks) ? body.locks : [])
    .map(readHold)
    .filter((hold): hold is DocHold => hold !== null);
  return { doc, blocks: blocks as DocBlock[], holds };
}

function unreadable() {
  return new RequestRefusedError(
    t("That did not go through. Try again."),
    502,
    "laf:hub_unreadable",
  );
}

/* ── the screen's reads ──────────────────────────────────────────────────────────────────────── */

const RETRIES = 1;

export const docListQueryOptions = () =>
  queryOptions({
    retry: RETRIES,
    queryKey: docKeys.list,
    queryFn: async (): Promise<DocSummary[]> => {
      const body = await requestOrRefusal("/api/hub/docs", undefined);
      const docs = isRecord(body) && Array.isArray(body.docs) ? body.docs : [];
      return docs
        .map(readSummary)
        .filter((doc): doc is DocSummary => doc !== null);
    },
  });

/** One document, asked now — the editor's own read after a frame or a refused save. */
export async function readDoc(id: string): Promise<OpenDoc> {
  return readOpenDoc(
    await requestOrRefusal(
      `/api/hub/docs/${encodeURIComponent(id)}`,
      undefined,
    ),
  );
}

export const openDocQueryOptions = (id: string) =>
  queryOptions({
    retry: RETRIES,
    queryKey: docKeys.doc(id),
    queryFn: () => readDoc(id),
  });

/* ── the screen's writes ─────────────────────────────────────────────────────────────────────── */

async function post(path: string, body: unknown, key?: string) {
  return requestOrRefusal(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function createDoc(title: string, key: string): Promise<string> {
  const body = await post("/api/hub/docs", { title }, key);
  const id = isRecord(body)
    ? (str(body.id) ?? (isRecord(body.doc) ? str(body.doc.id) : null))
    : null;
  if (!id) throw unreadable();
  return id;
}

/**
 * One batch of block changes, all or none. Answers the blocks the hub wrote, in the order of the
 * ops that made them — a new block's id comes back here.
 */
export async function saveBlocks(
  docId: string,
  ops: readonly DocOp[],
  key: string,
): Promise<DocBlock[]> {
  const body = await post(
    `/api/hub/docs/${encodeURIComponent(docId)}/blocks`,
    { ops },
    key,
  );
  const blocks =
    isRecord(body) && Array.isArray(body.blocks) ? body.blocks : [];
  return blocks
    .map(readBlock)
    .filter((block): block is DocBlock => block !== null);
}

/** The hold's two doors, as `block-lock.ts` takes them. */
export async function lockBlock(
  docId: string,
  blockId: string,
): Promise<"held" | "busy" | "gone" | "failed"> {
  try {
    await post(
      `/api/hub/docs/${encodeURIComponent(docId)}/blocks/${encodeURIComponent(blockId)}/lock`,
      undefined,
    );
    return "held";
  } catch (error) {
    if (!(error instanceof RequestRefusedError)) return "failed";
    if (error.code === "laf:doc_block_busy") return "busy";
    if (error.status === 404) return "gone";
    return "failed";
  }
}

export async function unlockBlock(
  docId: string,
  blockId: string,
): Promise<void> {
  // `keepalive`: let go even when the tab is closing, which is when this is most often sent.
  await fetch(
    `/api/hub/docs/${encodeURIComponent(docId)}/blocks/${encodeURIComponent(blockId)}/unlock`,
    { method: "POST", credentials: "include", keepalive: true },
  );
}

/* ── words ───────────────────────────────────────────────────────────────────────────────────── */

/** A save refused because somebody saved the block first: the hub's 409 that is not a hold. */
export function isStaleSave(error: unknown): boolean {
  return (
    error instanceof RequestRefusedError &&
    error.status === 409 &&
    error.code !== "laf:doc_block_busy"
  );
}

export function docFactText(code: string | null): string | null {
  switch (code) {
    case "laf:doc_block_busy":
      return t("Somebody is writing in this block.");
    case "laf:doc_block_stale":
    case "laf:doc_block_changed":
      return t("Somebody changed this block first. It now shows theirs.");
    case "laf:doc_not_found":
      return t("This document is gone.");
    default:
      return companyFactText(code);
  }
}

export function docFailureText(error: unknown): string {
  const code = error instanceof RequestRefusedError ? error.code : null;
  return docFactText(code) ?? t("That did not go through. Try again.");
}

export function kindLabel(kind: DocBlockKind): string {
  switch (kind) {
    case "paragraph":
      return t("Text");
    case "heading1":
      return t("Heading 1");
    case "heading2":
      return t("Heading 2");
    case "heading3":
      return t("Heading 3");
    case "list":
      return t("List");
    case "check":
      return t("To-do");
    case "quote":
      return t("Quote");
    case "code":
      return t("Code");
    case "divider":
      return t("Divider");
    case "table":
      return t("Table");
    case "file":
      return t("File");
    case "task-link":
      return t("Task");
  }
}
