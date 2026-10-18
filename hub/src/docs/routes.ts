import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  markdownToBlocks,
  docToMarkdown,
} from "../../../shared/hub/doc-markdown";
import {
  HUB_DOC_LOCK_RENEW_MS,
  HUB_DOC_LOCK_TTL_MS,
  HUB_DOC_MAX_BLOCKS,
  HUB_DOC_MAX_OPS,
  HUB_DOCS_PAGE,
  HUB_FACTS,
  HUB_HEADERS,
  type HubDoc,
  type HubDocBlock,
  type HubDocBlockAttrs,
  type HubDocBlockKind,
  type HubDocCreate,
  type HubDocLockFrame,
  type HubDocLockResult,
  type HubDocOp,
  type HubDocOpsRefusal,
  type HubDocVersionHead,
  type HubVisibility,
} from "../../../shared/hub/protocol";
import { charLength } from "../../../shared/hub/search-words";
import { recordAudit, trailOf } from "../audit";
import type { MemberVariables } from "../auth";
import type { HubDatabase, HubTransaction } from "../db/client";
import { hubChunks, hubDocBlocks, hubDocs, hubDocVersions } from "../db/schema";
import { emitEvent, type Listeners } from "../events";
import { chunkText } from "../files/chunks";
import { cleanFolder } from "../files/routes";
import { type Answer, IDEMPOTENCY_KEY_SHAPE, onceFor } from "../idempotency";
import { audienceOf, chooseVisibility, visibleTo } from "../visibility";
import {
  BLOCK_ID,
  type BlockContent,
  blockHash,
  cleanContent,
  newBlockId,
  searchableText,
} from "./blocks";
import type { DocLocks } from "./locks";
import { evenRanks, RANK_MAX_CHARS, rankBetween } from "./rank";

export type DocRoutesOptions = {
  database: HubDatabase;
  listeners: Listeners;
  member: MiddlewareHandler<{ Variables: MemberVariables }>;
  locks: DocLocks;
};

/**
 * The largest body a document route reads. A whole new document arrives in one (`POST /docs` with
 * its markdown), and the hub's request bound is 10 MB (design §4.1); a batch of 200 block changes
 * fits many times over.
 */
const DOC_BODY_MAX = 10 * 1024 * 1024;
/** Past this many blocks in one batch, the VMs are told to read the document whole, not per block. */
const BLOCK_EVENTS_MAX = 50;
/** Chunks inserted per statement. */
const CHUNK_BATCH = 500;
const DOC_ID = /^d_[0-9a-f-]{36}$/;
const HASH = /^[0-9a-f]{16}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Every key of every member of a union (`keyof` of a union keeps only the shared ones). */
type KeysOf<T> = T extends unknown ? keyof T : never;

type Invalid = { field: string };
const isInvalid = (value: unknown): value is Invalid =>
  typeof value === "object" && value !== null && "field" in value;

/** A document's title: one line, 1–200 characters. */
function cleanTitle(raw: unknown): string | Invalid {
  if (typeof raw !== "string") return { field: "title" };
  const title = raw.normalize("NFC").trim();
  if (title.length === 0 || charLength(title) > 200 || CONTROL.test(title)) {
    return { field: "title" };
  }
  return title;
}

const docColumns = {
  id: hubDocs.id,
  title: hubDocs.title,
  folder: hubDocs.folder,
  visibility: hubDocs.visibility,
  taskId: hubDocs.taskId,
  rev: hubDocs.rev,
  createdBy: hubDocs.createdBy,
  updatedBy: hubDocs.updatedBy,
  updatedAt: hubDocs.updatedAt,
};
type DocRow = {
  id: string;
  title: string;
  folder: string;
  visibility: string;
  taskId: string | null;
  rev: number;
  createdBy: string | null;
  updatedBy: string | null;
  updatedAt: Date;
};

const toDoc = (row: DocRow): HubDoc => ({
  id: row.id,
  title: row.title,
  folder: row.folder,
  visibility: row.visibility as HubVisibility,
  rev: row.rev,
  createdBy: row.createdBy,
  updatedBy: row.updatedBy,
  updatedAt: row.updatedAt.toISOString(),
});

const blockColumns = {
  id: hubDocBlocks.id,
  rank: hubDocBlocks.rank,
  kind: hubDocBlocks.kind,
  text: hubDocBlocks.text,
  attrs: hubDocBlocks.attrs,
  version: hubDocBlocks.version,
  hash: hubDocBlocks.hash,
  by: hubDocBlocks.updatedBy,
  at: hubDocBlocks.updatedAt,
};
type BlockRow = {
  id: string;
  rank: string;
  kind: string;
  text: string;
  attrs: unknown;
  version: number;
  hash: string;
  by: string | null;
  at: Date;
};

const toBlock = (row: BlockRow): HubDocBlock => ({
  id: row.id,
  kind: row.kind as HubDocBlockKind,
  text: row.text,
  attrs: (row.attrs ?? {}) as HubDocBlockAttrs,
  version: row.version,
  hash: row.hash,
  rank: row.rank,
  by: row.by,
  at: row.at.toISOString(),
});

/** Ranks compared byte by byte, as `src/docs/rank.ts` orders them, whatever the database's locale. */
const byRank = sql`${hubDocBlocks.rank} collate "C"`;

/** The document `member` may see, not deleted; locked for the rest of the transaction when asked. */
async function visibleDoc(
  database: HubDatabase | HubTransaction,
  member: string,
  id: string,
  lock = false,
): Promise<DocRow | null> {
  if (!DOC_ID.test(id)) return null;
  const query = database
    .select(docColumns)
    .from(hubDocs)
    .where(
      and(
        eq(hubDocs.id, id),
        isNull(hubDocs.deletedAt),
        visibleTo(hubDocs.visibility, member),
      ),
    );
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

async function blocksOf(
  database: HubDatabase | HubTransaction,
  docId: string,
): Promise<BlockRow[]> {
  return database
    .select(blockColumns)
    .from(hubDocBlocks)
    .where(eq(hubDocBlocks.docId, docId))
    .orderBy(byRank);
}

/** The source id of a block's chunks: unique across kinds, as `hub_chunks_source` needs. */
const chunkSource = (docId: string, blockId: string) => `${docId}/${blockId}`;

/** A block's chunks replaced by its words now, in the caller's transaction. */
async function writeChunks(
  tx: HubTransaction,
  doc: DocRow,
  blocks: { id: string; content: BlockContent }[],
  at: Date,
): Promise<void> {
  if (blocks.length === 0) return;
  await dropChunks(
    tx,
    doc.id,
    blocks.map((block) => block.id),
  );
  const rows = blocks.flatMap((block) =>
    chunkText(searchableText(block.content)).map((piece, ordinal) => ({
      sourceKind: "doc",
      sourceId: chunkSource(doc.id, block.id),
      ordinal,
      text: piece,
      title: doc.title,
      visibility: doc.visibility,
      taskId: doc.taskId,
      at,
    })),
  );
  for (let start = 0; start < rows.length; start += CHUNK_BATCH) {
    await tx.insert(hubChunks).values(rows.slice(start, start + CHUNK_BATCH));
  }
}

async function dropChunks(
  tx: HubTransaction,
  docId: string,
  blockIds: string[],
): Promise<void> {
  if (blockIds.length === 0) return;
  await tx.delete(hubChunks).where(
    and(
      eq(hubChunks.sourceKind, "doc"),
      inArray(
        hubChunks.sourceId,
        blockIds.map((id) => chunkSource(docId, id)),
      ),
    ),
  );
}

const invalid = (context: Context, field: string) =>
  context.json({ ok: false, code: "laf:request_invalid", field }, 400);
const notFound = (context: Context) =>
  context.json({ ok: false, code: HUB_FACTS.notFound }, 404);
const bad = (field: string): Answer => ({
  status: 400,
  body: { ok: false, code: "laf:request_invalid", field },
});
const missing: Answer = {
  status: 404,
  body: { ok: false, code: HUB_FACTS.notFound },
};

async function readBody(
  context: Context,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await context.req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function encodeCursor(row: { atUs: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.atUs, row.id])).toString("base64url");
}

function decodeCursor(raw: string): [string, string] | null {
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      /^\d{1,20}$/.test(value[0]) &&
      typeof value[1] === "string"
      ? (value as [string, string])
      : null;
  } catch {
    return null;
  }
}

/** A block being worked on in a batch: the row as read, and what the batch has made of it. */
type Working = {
  id: string;
  rank: string;
  content: BlockContent;
  version: number;
  hash: string;
  fresh: boolean;
  contentChanged: boolean;
  rankChanged: boolean;
};

type Refusal = { status: 409 | 400; body: HubDocOpsRefusal | object };

/**
 * `/hub/v1/docs`: team documents as ordered blocks. Reads answer only what the asking member may
 * see; writes take an `Idempotency-Key`, emit `doc.block_changed` (or `doc.changed`) to those who
 * may see the document, keep search's chunks in the same transaction, and leave a trail row that
 * names the document and never its words.
 */
export function docRoutes(options: DocRoutesOptions) {
  const { database, listeners, locks } = options;
  const route = new Hono<{ Variables: MemberVariables }>();
  route.use("*", options.member);
  route.use(
    "*",
    bodyLimit({
      maxSize: DOC_BODY_MAX,
      onError: (context) =>
        context.json({ ok: false, code: "laf:request_invalid" }, 413),
    }),
  );

  /** Every write: the key checked, the work done once, the sockets poked after a commit. */
  async function write(
    context: Context<{ Variables: MemberVariables }>,
    work: (tx: HubTransaction) => Promise<Answer>,
  ) {
    const key = context.req.header(HUB_HEADERS.idempotencyKey);
    if (!key || !IDEMPOTENCY_KEY_SHAPE.test(key)) {
      return invalid(context, "idempotency-key");
    }
    const answer = await onceFor(database, context.get("member").id, key, work);
    if (!answer.replayed && answer.status === 200) listeners.pokeAll();
    return context.json(
      answer.body as Record<string, unknown>,
      answer.status as 200,
    );
  }

  /** Tells the sockets that may see the document who now holds a block, or that it was let go. */
  async function announceHold(
    doc: DocRow,
    block: string,
    member: { id: string; name: string | null },
    until: number | null,
  ) {
    const frame: HubDocLockFrame = {
      kind: "doc.lock",
      doc: doc.id,
      block,
      member: member.id,
      name: member.name,
      until: until === null ? null : new Date(until).toISOString(),
    };
    listeners.sendTo(
      await audienceOf(database, doc.visibility),
      JSON.stringify(frame),
    );
  }

  route.get("/", async (context) => {
    const me = context.get("member").id;
    const folderQuery = context.req.query("folder");
    const folder =
      folderQuery === undefined ? undefined : cleanFolder(folderQuery);
    if (folder !== undefined && typeof folder !== "string") {
      return invalid(context, "folder");
    }
    const cursorQuery = context.req.query("cursor");
    const cursor = cursorQuery === undefined ? null : decodeCursor(cursorQuery);
    if (cursorQuery !== undefined && !cursor) return invalid(context, "cursor");
    // Microseconds as a whole number: a cursor of the millisecond JavaScript keeps would skip the
    // documents changed within the same millisecond as the last one listed.
    const atUs = sql<string>`(extract(epoch from ${hubDocs.updatedAt}) * 1000000)::bigint`;
    const rows = await database
      .select({ ...docColumns, atUs: sql<string>`${atUs}::text` })
      .from(hubDocs)
      .where(
        and(
          isNull(hubDocs.deletedAt),
          visibleTo(hubDocs.visibility, me),
          folder === undefined ? undefined : eq(hubDocs.folder, folder),
          cursor
            ? sql`(${atUs}, ${hubDocs.id}) < (${cursor[0]}::bigint, ${cursor[1]})`
            : undefined,
        ),
      )
      .orderBy(desc(atUs), desc(hubDocs.id))
      .limit(HUB_DOCS_PAGE + 1);
    const page = rows.slice(0, HUB_DOCS_PAGE);
    const last = page.at(-1);
    return context.json({
      ok: true,
      docs: page.map(toDoc),
      next: rows.length > HUB_DOCS_PAGE && last ? encodeCursor(last) : null,
    });
  });

  route.post("/", async (context) => {
    const input: { [K in keyof HubDocCreate]?: unknown } | null =
      await readBody(context);
    if (!input) return invalid(context, "body");
    const self = context.get("member");
    const trail = trailOf(context);
    return write(context, async (tx) => {
      const title = cleanTitle(input.title);
      if (isInvalid(title)) return bad("title");
      const folder = cleanFolder(input.folder);
      if (typeof folder !== "string") return bad("folder");
      const choice = await chooseVisibility(tx, input.visibility, self.id);
      if (!choice.ok) {
        return choice.status === 403
          ? { status: 403, body: { ok: false, code: HUB_FACTS.forbidden } }
          : bad("visibility");
      }
      let given: { kind: unknown; text: unknown; attrs: unknown }[];
      if (input.blocks !== undefined && input.markdown !== undefined) {
        return bad("blocks");
      }
      if (input.markdown !== undefined) {
        if (typeof input.markdown !== "string") return bad("markdown");
        given = markdownToBlocks(input.markdown);
      } else if (input.blocks !== undefined) {
        if (!Array.isArray(input.blocks)) return bad("blocks");
        given = input.blocks.map((block: unknown) => {
          const raw = (
            block && typeof block === "object" ? block : {}
          ) as Record<string, unknown>;
          return { kind: raw.kind, text: raw.text ?? "", attrs: raw.attrs };
        });
      } else {
        given = [];
      }
      if (given.length === 0) {
        given = [{ kind: "paragraph", text: "", attrs: {} }];
      }
      if (given.length > HUB_DOC_MAX_BLOCKS) return bad("blocks");
      const contents: BlockContent[] = [];
      for (const [index, block] of given.entries()) {
        const content = cleanContent(block);
        if ("invalid" in content)
          return bad(`blocks[${index}].${content.invalid}`);
        contents.push(content);
      }

      const now = new Date();
      const id = `d_${randomUUID()}`;
      const [doc] = await tx
        .insert(hubDocs)
        .values({
          id,
          title,
          folder,
          visibility: choice.visibility,
          taskId: choice.taskId,
          rev: 1,
          createdBy: self.id,
          updatedBy: self.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning(docColumns);
      if (!doc) throw new Error("hub_docs insert returned nothing");
      const ranks = evenRanks(contents.length);
      const rows = contents.map((content, index) => ({
        docId: id,
        id: newBlockId(),
        rank: ranks[index] as string,
        kind: content.kind,
        text: content.text,
        attrs: content.attrs,
        version: 1,
        hash: blockHash(content),
        updatedBy: self.id,
        updatedAt: now,
      }));
      const written: BlockRow[] = [];
      for (let start = 0; start < rows.length; start += CHUNK_BATCH) {
        written.push(
          ...(await tx
            .insert(hubDocBlocks)
            .values(rows.slice(start, start + CHUNK_BATCH))
            .returning(blockColumns)),
        );
      }
      await writeChunks(
        tx,
        doc,
        rows.map((row, index) => ({
          id: row.id,
          content: contents[index] as BlockContent,
        })),
        now,
      );
      await emitEvent(tx, {
        type: "doc.changed",
        refId: id,
        actor: self.id,
        visibleTo: await audienceOf(tx, doc.visibility),
      });
      await recordAudit(tx, {
        ...trail,
        action: "doc.created",
        target: id,
        outcome: "ok",
        payload: { blocks: rows.length },
      });
      return {
        status: 200,
        body: {
          ok: true,
          doc: toDoc(doc),
          blocks: written.map(toBlock),
          locks: [],
        },
      };
    });
  });

  route.get("/:id", async (context) => {
    const me = context.get("member").id;
    const doc = await visibleDoc(database, me, context.req.param("id"));
    if (!doc) return notFound(context);
    const blocks = await blocksOf(database, doc.id);
    const standing = locks.standing(doc.id);
    await recordAudit(database, {
      ...trailOf(context),
      action: "doc.read",
      target: doc.id,
      outcome: "ok",
      payload: { rev: doc.rev, part: "blocks" },
    });
    return context.json({
      ok: true,
      doc: toDoc(doc),
      blocks: blocks.map(toBlock),
      locks: standing.map(({ block, hold }) => ({
        block,
        member: hold.member,
        name: hold.name,
        until: new Date(hold.until).toISOString(),
      })),
    });
  });

  /** One block, for a VM told `doc.block_changed`: 404 when it was deleted. */
  route.get("/:id/blocks/:bid", async (context) => {
    const me = context.get("member").id;
    const doc = await visibleDoc(database, me, context.req.param("id"));
    if (!doc) return notFound(context);
    const [row] = await database
      .select(blockColumns)
      .from(hubDocBlocks)
      .where(
        and(
          eq(hubDocBlocks.docId, doc.id),
          eq(hubDocBlocks.id, context.req.param("bid")),
        ),
      );
    if (!row) return notFound(context);
    return context.json({ ok: true, rev: doc.rev, block: toBlock(row) });
  });

  route.get("/:id/markdown", async (context) => {
    const me = context.get("member").id;
    const doc = await visibleDoc(database, me, context.req.param("id"));
    if (!doc) return notFound(context);
    const blocks = await blocksOf(database, doc.id);
    await recordAudit(database, {
      ...trailOf(context),
      action: "doc.read",
      target: doc.id,
      outcome: "ok",
      payload: { rev: doc.rev, part: "markdown" },
    });
    return context.json({
      ok: true,
      rev: doc.rev,
      markdown: docToMarkdown(
        blocks.map((block) => {
          const shaped = toBlock(block);
          return {
            id: shaped.id,
            hash: shaped.hash,
            kind: shaped.kind,
            text: shaped.text,
            attrs: shaped.attrs,
          };
        }),
      ),
    });
  });

  route.patch("/:id", async (context) => {
    const input = await readBody(context);
    if (!input) return invalid(context, "body");
    const self = context.get("member");
    const trail = trailOf(context);
    const id = context.req.param("id");
    return write(context, async (tx) => {
      const doc = await visibleDoc(tx, self.id, id, true);
      if (!doc) return missing;
      const title =
        input.title === undefined ? doc.title : cleanTitle(input.title);
      if (isInvalid(title)) return bad("title");
      const folder =
        input.folder === undefined ? doc.folder : cleanFolder(input.folder);
      if (typeof folder !== "string") return bad("folder");
      const now = new Date();
      const [updated] = await tx
        .update(hubDocs)
        .set({
          title,
          folder,
          rev: sql`${hubDocs.rev} + 1`,
          updatedBy: self.id,
          updatedAt: now,
        })
        .where(eq(hubDocs.id, doc.id))
        .returning(docColumns);
      if (!updated) throw new Error("hub_docs update returned nothing");
      if (title !== doc.title) {
        // A hit names its document by title: the chunks carry it, so they follow a rename.
        await tx
          .update(hubChunks)
          .set({ title })
          .where(
            and(
              eq(hubChunks.sourceKind, "doc"),
              inArray(
                hubChunks.sourceId,
                tx
                  .select({
                    id: sql<string>`${hubDocBlocks.docId} || '/' || ${hubDocBlocks.id}`,
                  })
                  .from(hubDocBlocks)
                  .where(eq(hubDocBlocks.docId, doc.id)),
              ),
            ),
          );
      }
      await emitEvent(tx, {
        type: "doc.changed",
        refId: doc.id,
        actor: self.id,
        visibleTo: await audienceOf(tx, doc.visibility),
      });
      await recordAudit(tx, {
        ...trail,
        action: "doc.renamed",
        target: doc.id,
        outcome: "ok",
        payload: { rev: updated.rev },
      });
      return { status: 200, body: { ok: true, doc: toDoc(updated) } };
    });
  });

  route.delete("/:id", async (context) => {
    const self = context.get("member");
    const trail = trailOf(context);
    const id = context.req.param("id");
    const response = await write(context, async (tx) => {
      const doc = await visibleDoc(tx, self.id, id, true);
      if (!doc) return missing;
      // As with files: seeing a company document is not owning it.
      if (
        doc.visibility === "company" &&
        doc.createdBy !== self.id &&
        self.role === "member"
      ) {
        return { status: 403, body: { ok: false, code: HUB_FACTS.forbidden } };
      }
      const now = new Date();
      await tx
        .update(hubDocs)
        .set({ deletedAt: now, updatedBy: self.id, updatedAt: now })
        .where(eq(hubDocs.id, doc.id));
      const blockIds = await tx
        .select({ id: hubDocBlocks.id })
        .from(hubDocBlocks)
        .where(eq(hubDocBlocks.docId, doc.id));
      await dropChunks(
        tx,
        doc.id,
        blockIds.map((row) => row.id),
      );
      await emitEvent(tx, {
        type: "doc.changed",
        refId: doc.id,
        actor: self.id,
        visibleTo: await audienceOf(tx, doc.visibility),
      });
      await recordAudit(tx, {
        ...trail,
        action: "doc.deleted",
        target: doc.id,
        outcome: "ok",
      });
      return { status: 200, body: { ok: true } };
    });
    if (response.status === 200) locks.forget(id);
    return response;
  });

  route.post("/:id/blocks", async (context) => {
    const input = await readBody(context);
    if (!input) return invalid(context, "body");
    const ops = input.ops;
    if (
      !Array.isArray(ops) ||
      ops.length === 0 ||
      ops.length > HUB_DOC_MAX_OPS
    ) {
      return invalid(context, "ops");
    }
    const self = context.get("member");
    const trail = trailOf(context);
    const origin = context.req.header(HUB_HEADERS.origin);
    // Only a person pressing in the editor saves by version. A run (a chat turn, a routine, a room)
    // is 라피, and 라피 changes a block only by naming the hash of what it read.
    const byBot = origin !== undefined && origin !== "person";
    const id = context.req.param("id");
    let deletedIds: string[] = [];
    const response = await write(context, async (tx) => {
      const doc = await visibleDoc(tx, self.id, id, true);
      if (!doc) return missing;
      const result = await applyOps(tx, {
        doc,
        ops,
        member: self.id,
        byBot,
        locks,
      });
      if ("status" in result) {
        // A refusal is a row too: who tried which block of which document, and why it was not done.
        const refusal = result.body as Partial<HubDocOpsRefusal> & {
          field?: string;
        };
        await recordAudit(tx, {
          ...trail,
          action: "doc.blocks",
          target: doc.id,
          outcome: refusal.code ?? "refused",
          payload: {
            ops: ops.length,
            op: refusal.op ?? null,
            field: refusal.field ?? null,
            block: refusal.block?.id ?? null,
            by: byBot ? "lafi" : "person",
          },
        });
        return result;
      }
      deletedIds = result.deleted;
      const changed = result.blocks.length + result.deleted.length;
      if (changed > 0) {
        const audience = await audienceOf(tx, doc.visibility);
        if (result.renumbered || changed > BLOCK_EVENTS_MAX) {
          await emitEvent(tx, {
            type: "doc.changed",
            refId: doc.id,
            actor: self.id,
            visibleTo: audience,
          });
        } else {
          for (const blockId of [
            ...result.blocks.map((block) => block.id),
            ...result.deleted,
          ]) {
            await emitEvent(tx, {
              type: "doc.block_changed",
              refId: `${doc.id}/${blockId}`,
              actor: self.id,
              visibleTo: audience,
            });
          }
        }
      }
      await recordAudit(tx, {
        ...trail,
        action: "doc.blocks",
        target: doc.id,
        outcome: "ok",
        payload: {
          ops: ops.length,
          written: result.blocks.length,
          deleted: result.deleted.length,
          renumbered: result.renumbered,
          rev: result.rev,
          by: byBot ? "lafi" : "person",
        },
      });
      return {
        status: 200,
        body: {
          ok: true,
          rev: result.rev,
          blocks: result.blocks,
          deleted: result.deleted,
        },
      };
    });
    if (response.status === 200) {
      for (const blockId of deletedIds) locks.forget(id, blockId);
    }
    return response;
  });

  route.post("/:id/blocks/:bid/lock", async (context) => {
    const self = context.get("member");
    const doc = await visibleDoc(database, self.id, context.req.param("id"));
    if (!doc) return notFound(context);
    const blockId = context.req.param("bid");
    const [block] = await database
      .select({ id: hubDocBlocks.id })
      .from(hubDocBlocks)
      .where(and(eq(hubDocBlocks.docId, doc.id), eq(hubDocBlocks.id, blockId)));
    if (!block) return notFound(context);
    const taken = locks.take(doc.id, blockId, self.id, self.name);
    if (!taken.ok) {
      await recordAudit(database, {
        ...trailOf(context),
        action: "doc.lock",
        target: doc.id,
        outcome: HUB_FACTS.docBlockBusy,
        payload: { block: blockId, holder: taken.holder.member },
      });
      return context.json(
        {
          ok: false,
          code: HUB_FACTS.docBlockBusy,
          holder: {
            member: taken.holder.member,
            name: taken.holder.name,
            until: new Date(taken.holder.until).toISOString(),
          },
        },
        409,
      );
    }
    await announceHold(doc, blockId, self, taken.hold.until);
    const body: HubDocLockResult = {
      ok: true,
      until: new Date(taken.hold.until).toISOString(),
      ttlMs: HUB_DOC_LOCK_TTL_MS,
      renewMs: HUB_DOC_LOCK_RENEW_MS,
    };
    return context.json(body);
  });

  route.post("/:id/blocks/:bid/unlock", async (context) => {
    const self = context.get("member");
    const doc = await visibleDoc(database, self.id, context.req.param("id"));
    if (!doc) return notFound(context);
    const blockId = context.req.param("bid");
    const released = locks.release(doc.id, blockId, self.id);
    if (released) await announceHold(doc, blockId, self, null);
    return context.json({ ok: true, released });
  });

  route.post("/:id/versions", async (context) => {
    const self = context.get("member");
    const trail = trailOf(context);
    const id = context.req.param("id");
    return write(context, async (tx) => {
      const doc = await visibleDoc(tx, self.id, id, true);
      if (!doc) return missing;
      const blocks = await blocksOf(tx, doc.id);
      const [last] = await tx
        .select({ version: hubDocVersions.version })
        .from(hubDocVersions)
        .where(eq(hubDocVersions.docId, doc.id))
        .orderBy(desc(hubDocVersions.version))
        .limit(1);
      const version = (last?.version ?? 0) + 1;
      const now = new Date();
      await tx.insert(hubDocVersions).values({
        docId: doc.id,
        version,
        title: doc.title,
        blocks: blocks.map((block) => ({
          id: block.id,
          kind: block.kind,
          text: block.text,
          attrs: block.attrs,
          version: block.version,
          hash: block.hash,
        })),
        by: self.id,
        at: now,
      });
      await recordAudit(tx, {
        ...trail,
        action: "doc.version",
        target: doc.id,
        outcome: "ok",
        payload: { version, blocks: blocks.length },
      });
      return {
        status: 200,
        body: { ok: true, version, at: now.toISOString() },
      };
    });
  });

  route.get("/:id/versions", async (context) => {
    const me = context.get("member").id;
    const doc = await visibleDoc(database, me, context.req.param("id"));
    if (!doc) return notFound(context);
    const rows = await database
      .select({
        version: hubDocVersions.version,
        title: hubDocVersions.title,
        by: hubDocVersions.by,
        at: hubDocVersions.at,
        blocks: sql<number>`jsonb_array_length(${hubDocVersions.blocks})::int`,
      })
      .from(hubDocVersions)
      .where(eq(hubDocVersions.docId, doc.id))
      .orderBy(desc(hubDocVersions.version))
      .limit(HUB_DOCS_PAGE);
    return context.json({
      ok: true,
      versions: rows.map(
        (row): HubDocVersionHead => ({
          ...row,
          blocks: Number(row.blocks),
          at: row.at.toISOString(),
        }),
      ),
    });
  });

  route.get("/:id/versions/:v", async (context) => {
    const me = context.get("member").id;
    const raw = context.req.param("v");
    if (!/^\d{1,9}$/.test(raw)) return invalid(context, "version");
    const doc = await visibleDoc(database, me, context.req.param("id"));
    if (!doc) return notFound(context);
    const [row] = await database
      .select({
        version: hubDocVersions.version,
        title: hubDocVersions.title,
        blocks: hubDocVersions.blocks,
        by: hubDocVersions.by,
        at: hubDocVersions.at,
      })
      .from(hubDocVersions)
      .where(
        and(
          eq(hubDocVersions.docId, doc.id),
          eq(hubDocVersions.version, Number(raw)),
        ),
      );
    if (!row) return notFound(context);
    await recordAudit(database, {
      ...trailOf(context),
      action: "doc.read",
      target: doc.id,
      outcome: "ok",
      payload: { part: "version", version: row.version },
    });
    return context.json({
      ok: true,
      version: row.version,
      title: row.title,
      by: row.by,
      at: row.at.toISOString(),
      blocks: row.blocks,
    });
  });

  return route;
}

type OpsApplied = {
  rev: number;
  blocks: HubDocBlock[];
  deleted: string[];
  renumbered: boolean;
};

/**
 * A batch of block changes against a document whose row the caller holds `for update`.
 *
 * Every op is checked and applied to a copy in memory first, in order, and nothing is written until
 * all of them pass: the first refusal answers for the batch and the tables are as they were. The
 * transaction still commits (it holds the idempotency key's row), so it must have written nothing.
 */
async function applyOps(
  tx: HubTransaction,
  input: {
    doc: DocRow;
    ops: unknown[];
    member: string;
    byBot: boolean;
    locks: DocLocks;
  },
): Promise<OpsApplied | Refusal> {
  const { doc, ops, member, byBot, locks } = input;
  const rows = await blocksOf(tx, doc.id);
  const original = new Map(rows.map((row) => [row.id, row]));
  const order: Working[] = rows.map((row) => ({
    id: row.id,
    rank: row.rank,
    content: {
      kind: row.kind as HubDocBlockKind,
      text: row.text,
      attrs: (row.attrs ?? {}) as HubDocBlockAttrs,
    },
    version: row.version,
    hash: row.hash,
    fresh: false,
    contentChanged: false,
    rankChanged: false,
  }));
  const deleted = new Set<string>();
  let renumber = false;

  const position = (id: string) => order.findIndex((block) => block.id === id);
  const latest = (id: string) => {
    const row = original.get(id);
    return row && !deleted.has(id) ? toBlock(row) : null;
  };
  const changed = (index: number, id: string): Refusal => ({
    status: 409,
    body: {
      ok: false,
      code: HUB_FACTS.docBlockChanged,
      op: index,
      block: latest(id),
    },
  });
  const invalidOp = (index: number, field: string): Refusal => ({
    status: 400,
    body: {
      ok: false,
      code: "laf:request_invalid",
      field: `ops[${index}].${field}`,
    },
  });
  /** A rank for a block placed at `at` in `order` (already inserted there). */
  const place = (at: number): string => {
    const before = order[at - 1]?.rank ?? null;
    const after = order[at + 1]?.rank ?? null;
    const rank = rankBetween(before, after);
    if (rank.length > RANK_MAX_CHARS) renumber = true;
    return rank;
  };

  for (const [index, raw] of ops.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return invalidOp(index, "op");
    }
    const op = raw as { [K in KeysOf<HubDocOp>]?: unknown };
    const kindOfOp = op.op;
    if (
      kindOfOp !== "replace" &&
      kindOfOp !== "insert_after" &&
      kindOfOp !== "delete" &&
      kindOfOp !== "move"
    ) {
      return invalidOp(index, "op");
    }
    const version = op.version;
    const expectHash = op.expectHash;
    if (
      version !== undefined &&
      (typeof version !== "number" || !Number.isInteger(version) || version < 1)
    ) {
      return invalidOp(index, "version");
    }
    if (
      expectHash !== undefined &&
      (typeof expectHash !== "string" || !HASH.test(expectHash))
    ) {
      return invalidOp(index, "expectHash");
    }
    if (version !== undefined && expectHash !== undefined) {
      return invalidOp(index, "version");
    }
    const targetId = op.id;
    const isAnchorless = kindOfOp === "insert_after" && targetId === null;
    if (
      !isAnchorless &&
      (typeof targetId !== "string" || !BLOCK_ID.test(targetId))
    ) {
      return invalidOp(index, "id");
    }
    const checked = version !== undefined || expectHash !== undefined;
    if (!isAnchorless && byBot && expectHash === undefined) {
      return invalidOp(index, "expectHash");
    }
    if (!isAnchorless && !checked && kindOfOp !== "insert_after") {
      return invalidOp(index, "version");
    }

    /** The block the op names, checked against what its writer read; null when refused. */
    const target = (
      id: string,
      holdMatters: boolean,
    ): { at: number; block: Working } | Refusal => {
      const at = position(id);
      const block = order[at];
      if (at === -1 || !block) return changed(index, id);
      if (holdMatters) {
        const hold = locks.holder(doc.id, id);
        // 라피 waits for anybody's hold, its own person's included: the person is typing there. A
        // person's save waits only for somebody else's.
        if (hold && (expectHash !== undefined || hold.member !== member)) {
          return {
            status: 409,
            body: {
              ok: false,
              code: HUB_FACTS.docBlockBusy,
              op: index,
              block: latest(id),
              holder: {
                member: hold.member,
                name: hold.name,
                until: new Date(hold.until).toISOString(),
              },
            },
          };
        }
      }
      if (version !== undefined && block.version !== version) {
        return changed(index, id);
      }
      if (expectHash !== undefined && block.hash !== expectHash) {
        return changed(index, id);
      }
      return { at, block };
    };

    if (kindOfOp === "replace") {
      const found = target(targetId as string, true);
      if ("status" in found) return found;
      const { block } = found;
      const kind = op.kind ?? block.content.kind;
      const kindChanged = kind !== block.content.kind;
      const content = cleanContent({
        kind,
        text:
          op.text ??
          (kindChanged && (kind === "divider" || kind === "table")
            ? ""
            : block.content.text),
        attrs: op.attrs ?? (kindChanged ? {} : block.content.attrs),
      });
      if ("invalid" in content) return invalidOp(index, content.invalid);
      const hash = blockHash(content);
      if (hash !== block.hash) {
        block.content = content;
        block.hash = hash;
        block.version += 1;
        block.contentChanged = true;
      }
      continue;
    }

    if (kindOfOp === "insert_after") {
      let at = 0;
      if (!isAnchorless) {
        const found = target(targetId as string, false);
        if ("status" in found) return found;
        at = found.at + 1;
      }
      const newId = op.newId ?? newBlockId();
      if (typeof newId !== "string" || !BLOCK_ID.test(newId)) {
        return invalidOp(index, "newId");
      }
      if (position(newId) !== -1 || original.has(newId)) {
        return invalidOp(index, "newId");
      }
      if (order.length >= HUB_DOC_MAX_BLOCKS) return invalidOp(index, "op");
      const content = cleanContent({
        kind: op.kind ?? "paragraph",
        text: op.text ?? "",
        attrs: op.attrs,
      });
      if ("invalid" in content) return invalidOp(index, content.invalid);
      const block: Working = {
        id: newId,
        rank: "",
        content,
        version: 1,
        hash: blockHash(content),
        fresh: true,
        contentChanged: true,
        rankChanged: true,
      };
      order.splice(at, 0, block);
      block.rank = place(at);
      continue;
    }

    if (kindOfOp === "delete") {
      const found = target(targetId as string, true);
      if ("status" in found) return found;
      order.splice(found.at, 1);
      if (!found.block.fresh) deleted.add(found.block.id);
      continue;
    }

    // move
    const after = op.after;
    if (
      after !== null &&
      (typeof after !== "string" || !BLOCK_ID.test(after))
    ) {
      return invalidOp(index, "after");
    }
    if (after === targetId) return invalidOp(index, "after");
    const found = target(targetId as string, true);
    if ("status" in found) return found;
    order.splice(found.at, 1);
    let at = 0;
    if (after !== null) {
      const anchor = position(after);
      if (anchor === -1) return changed(index, after);
      at = anchor + 1;
    }
    order.splice(at, 0, found.block);
    found.block.rank = place(at);
    found.block.rankChanged = true;
  }

  if (renumber) {
    const ranks = evenRanks(order.length);
    for (const [index, block] of order.entries()) {
      const rank = ranks[index] as string;
      if (rank !== block.rank) {
        block.rank = rank;
        block.rankChanged = true;
      }
    }
  }

  const fresh = order.filter((block) => block.fresh);
  const rewritten = order.filter(
    (block) => !block.fresh && block.contentChanged,
  );
  const moved = order.filter(
    (block) => !block.fresh && !block.contentChanged && block.rankChanged,
  );
  if (fresh.length + rewritten.length + moved.length + deleted.size === 0) {
    return { rev: doc.rev, blocks: [], deleted: [], renumbered: false };
  }

  const now = new Date();
  if (deleted.size > 0) {
    const ids = [...deleted];
    await tx
      .delete(hubDocBlocks)
      .where(
        and(eq(hubDocBlocks.docId, doc.id), inArray(hubDocBlocks.id, ids)),
      );
    await dropChunks(tx, doc.id, ids);
  }
  if (fresh.length > 0) {
    await tx.insert(hubDocBlocks).values(
      fresh.map((block) => ({
        docId: doc.id,
        id: block.id,
        rank: block.rank,
        kind: block.content.kind,
        text: block.content.text,
        attrs: block.content.attrs,
        // Not 1: a later op of the same save may have rewritten it, and the answer names this.
        version: block.version,
        hash: block.hash,
        updatedBy: member,
        updatedAt: now,
      })),
    );
  }
  for (const block of rewritten) {
    await tx
      .update(hubDocBlocks)
      .set({
        rank: block.rank,
        kind: block.content.kind,
        text: block.content.text,
        attrs: block.content.attrs,
        version: block.version,
        hash: block.hash,
        updatedBy: member,
        updatedAt: now,
      })
      .where(
        and(eq(hubDocBlocks.docId, doc.id), eq(hubDocBlocks.id, block.id)),
      );
  }
  if (moved.length > 0) {
    // One statement for every rank, so a renumbering of a long document is not a statement a block.
    const ids = sql.join(
      moved.map((block) => sql`${block.id}`),
      sql`, `,
    );
    const ranks = sql.join(
      moved.map((block) => sql`${block.rank}`),
      sql`, `,
    );
    await tx.execute(sql`
      update ${hubDocBlocks} set rank = given.rank
        from unnest(array[${ids}]::text[], array[${ranks}]::text[]) as given(id, rank)
       where ${hubDocBlocks.docId} = ${doc.id} and ${hubDocBlocks.id} = given.id`);
  }
  await writeChunks(
    tx,
    doc,
    [...fresh, ...rewritten].map((block) => ({
      id: block.id,
      content: block.content,
    })),
    now,
  );
  const [updated] = await tx
    .update(hubDocs)
    .set({ rev: sql`${hubDocs.rev} + 1`, updatedBy: member, updatedAt: now })
    .where(eq(hubDocs.id, doc.id))
    .returning({ rev: hubDocs.rev });

  const written = new Set(
    [...fresh, ...rewritten, ...moved].map((block) => block.id),
  );
  const blocks: HubDocBlock[] = order
    .filter((block) => written.has(block.id))
    .map((block) => {
      const before = original.get(block.id);
      const touched = block.fresh || block.contentChanged;
      return {
        id: block.id,
        kind: block.content.kind,
        text: block.content.text,
        attrs: block.content.attrs,
        version: block.version,
        hash: block.hash,
        rank: block.rank,
        by: touched ? member : (before?.by ?? null),
        at: (touched ? now : (before?.at ?? now)).toISOString(),
      };
    });
  return {
    rev: updated?.rev ?? doc.rev + 1,
    blocks,
    deleted: [...deleted],
    renumbered: renumber,
  };
}
