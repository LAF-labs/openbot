import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import {
  HUB_FACTS,
  HUB_FILE_MAX_BYTES,
  HUB_FILES_PAGE,
  HUB_HEADERS,
  HUB_TEXT_MAX_CHARS,
  HUB_TEXT_READ_MAX,
  type HubFile,
  type HubFilePut,
  type HubFilePutMeta,
  type HubFileText,
  type HubVisibility,
} from "../../../shared/hub/protocol";
import { charLength } from "../../../shared/hub/search-words";
import type { Logger } from "../../../shared/log";
import { recordAudit, trailOf } from "../audit";
import type { MemberVariables } from "../auth";
import type { HubDatabase, HubTransaction } from "../db/client";
import { hubBlobs, hubChunks, hubFiles, hubFileVersions } from "../db/schema";
import { emitEvent, type Listeners } from "../events";
import { type Answer, IDEMPOTENCY_KEY_SHAPE, onceFor } from "../idempotency";
import { audienceOf, chooseVisibility, visibleTo } from "../visibility";
import { chunkText } from "./chunks";
import {
  boundaryOf,
  MultipartInvalid,
  type PartSink,
  readMultipart,
} from "./multipart";
import {
  type BlobReceiver,
  blobPath,
  FilesFull,
  FileTooLarge,
  placeBlob,
  type Received,
  receiveBlob,
} from "./store";

export type FileRoutesOptions = {
  database: HubDatabase;
  listeners: Listeners;
  member: MiddlewareHandler<{ Variables: MemberVariables }>;
  /** `HUB_FILES_DIR`. Null: the hub keeps no files, and says so (`laf:hub_files_unset`). */
  filesDir: string | null;
  /** `HUB_FILES_QUOTA_BYTES`: the company's share of the volume, or null for the disk's own end. */
  quotaBytes: number | null;
  /** `HUB_FILE_MAX_BYTES` unless a test needs a limit it can cross without a gigabyte. */
  fileMaxBytes?: number;
  log?: Logger;
  /** Told after a version is written, so its blob is copied to the bucket now (src/files/mirror.ts). */
  onBlobWritten?: () => void;
};

/** The `meta` part: a name and a place, nothing that could be a file's content. */
const META_MAX_BYTES = 16 * 1024;
/**
 * The `text` part, in bytes: `HUB_TEXT_MAX_CHARS` of Korean is about three bytes a character.
 * Checked again in characters once decoded.
 */
const TEXT_MAX_BYTES = HUB_TEXT_MAX_CHARS * 4;
/** What a body may hold beyond the blob: the two small parts and the multipart framing. */
const BODY_OVERHEAD = META_MAX_BYTES + TEXT_MAX_BYTES + 64 * 1024;
/** The largest body `PUT /files` reads; `index.ts` gives Bun the same bound. */
export const FILES_BODY_MAX = HUB_FILE_MAX_BYTES + BODY_OVERHEAD;

/**
 * Uploads whose bodies are read at once; the next is answered 503 `laf:hub_busy` and retried by the
 * VM (design §4.3: 5xx is retried, 0.5 s → 2 s → 8 s).
 *
 * WHY A BOUND AT ALL: through `Bun.serve`, Bun 1.3.14 reads a request body off the socket as fast
 * as it arrives, whether or not the handler is reading it (a 300 MB body arrived as one 314 MB
 * chunk), so a file could wait in memory whole. In the hub this route is served by the upload
 * listener (src/uploads.ts), which pauses the socket while the disk is behind — measured in the
 * hub's container, a 1 GB upload peaked at 172 MB resident and two 300 MB ones at once at 285 MB,
 * under its 512 MB. The bound still caps the disk writes and hashes running at once.
 */
const UPLOADS_AT_ONCE = 2;

/** Chunks inserted per statement, so a long document is a few statements and not one huge one. */
const CHUNK_BATCH = 500;

const MIME_SHAPE = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const CONTROL = /[\u0000-\u001f\u007f]/;

class TextTooLarge extends Error {}

type Invalid = { ok: false; field: string };

/** A file name as a person would see it in a folder: no slashes, no control characters. */
export function cleanName(raw: unknown): string | Invalid {
  if (typeof raw !== "string") return { ok: false, field: "name" };
  const name = raw.normalize("NFC").trim();
  if (
    name.length === 0 ||
    charLength(name) > 255 ||
    name === "." ||
    name === ".." ||
    /[/\\]/.test(name) ||
    CONTROL.test(name)
  ) {
    return { ok: false, field: "name" };
  }
  return name;
}

/** `/` or `/a/b`: absolute, no empty, `.` or `..` segment, no trailing slash. */
export function cleanFolder(raw: unknown): string | Invalid {
  if (raw === undefined) return "/";
  if (typeof raw !== "string") return { ok: false, field: "folder" };
  const folder = raw.normalize("NFC").trim();
  if (folder === "/") return folder;
  const segments = folder.split("/");
  if (
    !folder.startsWith("/") ||
    charLength(folder) > 512 ||
    CONTROL.test(folder) ||
    folder.includes("\\") ||
    segments
      .slice(1)
      .some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          charLength(segment) > 255,
      )
  ) {
    return { ok: false, field: "folder" };
  }
  return folder;
}

const isInvalid = (value: unknown): value is Invalid =>
  typeof value === "object" && value !== null && "field" in value;

const fileColumns = {
  id: hubFiles.id,
  name: hubFiles.name,
  folder: hubFiles.folder,
  visibility: hubFiles.visibility,
  version: hubFiles.version,
  size: hubFileVersions.bytes,
  sha256: hubFileVersions.sha256,
  mime: hubFileVersions.mime,
  by: hubFileVersions.by,
  at: hubFileVersions.at,
  textChars: hubFileVersions.textChars,
};

type FileRow = {
  id: string;
  name: string;
  folder: string;
  visibility: string;
  version: number;
  size: number;
  sha256: string;
  mime: string | null;
  by: string | null;
  at: Date;
  textChars: number | null;
};

const toFile = (row: FileRow): HubFile => ({
  id: row.id,
  name: row.name,
  folder: row.folder,
  size: row.size,
  version: row.version,
  sha256: row.sha256,
  mime: row.mime,
  by: row.by,
  at: row.at.toISOString(),
  visibility: row.visibility as HubVisibility,
  hasText: row.textChars !== null,
});

/**
 * The files `member` may see, at their newest version. Every read of a file goes through here, so
 * the permission and "not deleted" are in each of them by construction.
 */
function visibleFiles(
  database: HubDatabase | HubTransaction,
  member: string,
  ...conditions: (SQL | undefined)[]
) {
  return database
    .select(fileColumns)
    .from(hubFiles)
    .innerJoin(
      hubFileVersions,
      and(
        eq(hubFileVersions.fileId, hubFiles.id),
        eq(hubFileVersions.version, hubFiles.version),
      ),
    )
    .where(
      and(
        isNull(hubFiles.deletedAt),
        visibleTo(hubFiles.visibility, member),
        ...conditions,
      ),
    );
}

function encodeCursor(row: FileRow): string {
  return Buffer.from(JSON.stringify([row.folder, row.name, row.id])).toString(
    "base64url",
  );
}

function decodeCursor(raw: string): [string, string, string] | null {
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return Array.isArray(value) &&
      value.length === 3 &&
      value.every((part) => typeof part === "string")
      ? (value as [string, string, string])
      : null;
  } catch {
    return null;
  }
}

/** A whole number from a query string within [min, max], the fallback when absent, else null. */
function numberOf(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === undefined) return fallback;
  if (!/^\d{1,10}$/.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
}

const invalid = (context: Context, field: string) =>
  context.json({ ok: false, code: "laf:request_invalid", field }, 400);
const notFound = (context: Context) =>
  context.json({ ok: false, code: HUB_FACTS.notFound }, 404);

/** The company's bytes in use: every blob a live version still points at. */
async function bytesInUse(
  database: HubDatabase | HubTransaction,
): Promise<number> {
  const [row] = await database
    .select({ total: sql<string>`coalesce(sum(${hubBlobs.bytes}), 0)::text` })
    .from(hubBlobs)
    .where(sql`${hubBlobs.refs} > 0`);
  return Number(row?.total ?? 0);
}

/** Every key of every member of a union (`keyof` of a union keeps only the shared ones). */
type KeysOf<T> = T extends unknown ? keyof T : never;
/** The `meta` part as sent: the contract's fields, each still to be checked. */
type MetaInput = { [K in KeysOf<HubFilePutMeta>]?: unknown };

type Upload = {
  meta: MetaInput | null;
  text: string | null;
  mime: string | null;
  blob: Received | null;
};

/**
 * Reads a `PUT /files` body: `meta` and `text` held (both small and bounded), `blob` streamed to
 * the volume. Any other part, or a part twice, is a malformed request.
 */
async function readUpload(
  body: ReadableStream<Uint8Array>,
  boundary: string,
  filesDir: string,
  fileMaxBytes: number,
  receivers: Promise<BlobReceiver>[],
): Promise<Upload> {
  const upload: Upload = { meta: null, text: null, mime: null, blob: null };
  const seen = new Set<string>();
  const collect = (limit: number, onEnd: (bytes: Buffer) => void) => {
    const pieces: Uint8Array[] = [];
    let size = 0;
    const sink: PartSink = {
      write(chunk) {
        size += chunk.length;
        if (size > limit) throw new TextTooLarge();
        pieces.push(chunk);
      },
      end() {
        onEnd(Buffer.concat(pieces));
      },
    };
    return sink;
  };
  // The receiver opens its file asynchronously, while `onPart` must answer at once: its sink
  // waits on that opening before its first write.
  await readMultipart(body, boundary, (part) => {
    if (seen.has(part.name)) throw new MultipartInvalid(`twice: ${part.name}`);
    seen.add(part.name);
    if (part.name === "meta") {
      return collect(META_MAX_BYTES, (bytes) => {
        try {
          const value: unknown = JSON.parse(bytes.toString("utf8"));
          upload.meta =
            value && typeof value === "object" && !Array.isArray(value)
              ? (value as MetaInput)
              : null;
        } catch {
          upload.meta = null;
        }
      });
    }
    if (part.name === "text") {
      return collect(TEXT_MAX_BYTES, (bytes) => {
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new MultipartInvalid("text is not UTF-8");
        }
        // Postgres text cannot hold NUL, and a converter's output has no use for one.
        text = text.replaceAll("\u0000", "");
        if (charLength(text) > HUB_TEXT_MAX_CHARS) throw new TextTooLarge();
        upload.text = text;
      });
    }
    if (part.name === "blob") {
      upload.mime =
        part.contentType && MIME_SHAPE.test(part.contentType)
          ? part.contentType.toLowerCase()
          : null;
      const opening = receiveBlob(filesDir, fileMaxBytes);
      // Handled here as well as where it is awaited: a body that breaks off before the part's
      // first byte would otherwise leave a failed opening nobody listens to.
      opening.catch(() => {});
      receivers.push(opening);
      return {
        write: async (chunk) => (await opening).sink.write(chunk),
        end: async () => {
          const receiver = await opening;
          await receiver.sink.end();
          upload.blob = await receiver.done;
        },
      };
    }
    throw new MultipartInvalid(`unknown part: ${part.name}`);
  });
  return upload;
}

/**
 * `/hub/v1/files`: the team's files. Reads answer only what the asking member may see; writes are
 * idempotent by `Idempotency-Key`, emit `file.changed` to those who may see the file, and leave a
 * trail row naming the file and never its content or its name.
 */
export function fileRoutes(options: FileRoutesOptions) {
  const { database, listeners, filesDir, quotaBytes } = options;
  const route = new Hono<{ Variables: MemberVariables }>();
  route.use("*", options.member);
  route.use("*", async (context, next) => {
    if (!filesDir) {
      return context.json({ ok: false, code: HUB_FACTS.filesUnset }, 503);
    }
    await next();
  });
  const dir = filesDir ?? "";
  const fileMaxBytes = options.fileMaxBytes ?? HUB_FILE_MAX_BYTES;
  let uploading = 0;

  route.get("/", async (context) => {
    const me = context.get("member").id;
    const folderQuery = context.req.query("folder");
    const folder =
      folderQuery === undefined ? undefined : cleanFolder(folderQuery);
    if (isInvalid(folder)) return invalid(context, "folder");
    const cursorQuery = context.req.query("cursor");
    const cursor = cursorQuery === undefined ? null : decodeCursor(cursorQuery);
    if (cursorQuery !== undefined && !cursor) return invalid(context, "cursor");
    const rows = await visibleFiles(
      database,
      me,
      folder === undefined ? undefined : eq(hubFiles.folder, folder),
      cursor
        ? sql`(${hubFiles.folder}, ${hubFiles.name}, ${hubFiles.id}) > (${cursor[0]}, ${cursor[1]}, ${cursor[2]})`
        : undefined,
    )
      .orderBy(asc(hubFiles.folder), asc(hubFiles.name), asc(hubFiles.id))
      .limit(HUB_FILES_PAGE + 1);
    const page = rows.slice(0, HUB_FILES_PAGE);
    const last = page.at(-1);
    return context.json({
      ok: true,
      files: page.map(toFile),
      next: rows.length > HUB_FILES_PAGE && last ? encodeCursor(last) : null,
    });
  });

  route.get("/:id", async (context) => {
    const [row] = await visibleFiles(
      database,
      context.get("member").id,
      eq(hubFiles.id, context.req.param("id")),
    );
    if (!row) return notFound(context);
    return context.json({ ok: true, file: toFile(row) });
  });

  route.get("/:id/content", async (context) => {
    const [row] = await visibleFiles(
      database,
      context.get("member").id,
      eq(hubFiles.id, context.req.param("id")),
    );
    if (!row) return notFound(context);
    const blob = Bun.file(blobPath(dir, row.sha256));
    if (!(await blob.exists())) {
      // A row whose bytes are not on this disk: a hub rebuilt from its dump, its blobs still to come
      // back from the bucket. Said as a fact the VM retries, not as a 500 — and logged, because on
      // a hub that was never restored it is a lost file.
      // TODO(hub restore): fetch the blob from the bucket here. The hub's door is write-only
      // (laf-control mints it so), so the fill is the restore's, with a read it holds.
      const [held] = await database
        .select({ mirroredAt: hubBlobs.mirroredAt })
        .from(hubBlobs)
        .where(eq(hubBlobs.sha256, row.sha256));
      options.log?.warn("blob_restoring", {
        file: row.id,
        version: row.version,
        mirrored: Boolean(held?.mirroredAt),
      });
      context.header("retry-after", "60");
      return context.json({ ok: false, code: HUB_FACTS.blobRestoring }, 503);
    }
    await recordAudit(database, {
      ...trailOf(context),
      action: "file.read",
      target: row.id,
      outcome: "ok",
      payload: { version: row.version, part: "content" },
    });
    // The file itself, not a stream of it: Bun sends a file-backed body from the disk to the
    // socket without passing it through the heap. Measured with a 300 MB file: through
    // `blob.stream()` the hub grew to 2.4 GB resident while one download ran.
    return new Response(blob, {
      headers: {
        "content-type": row.mime ?? "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        "x-content-type-options": "nosniff",
      },
    });
  });

  route.get("/:id/text", async (context) => {
    const from = numberOf(context.req.query("from"), 0, 0, HUB_TEXT_MAX_CHARS);
    const limit = numberOf(
      context.req.query("limit"),
      HUB_TEXT_READ_MAX,
      1,
      HUB_TEXT_READ_MAX,
    );
    if (from === null) return invalid(context, "from");
    if (limit === null) return invalid(context, "limit");
    const me = context.get("member").id;
    // The range is cut by Postgres, so a long document is never read whole to hand back a page.
    const [row] = await database
      .select({
        id: hubFiles.id,
        version: hubFiles.version,
        text: sql<
          string | null
        >`substr(${hubFileVersions.text}, ${from + 1}, ${limit})`,
        total: hubFileVersions.textChars,
      })
      .from(hubFiles)
      .innerJoin(
        hubFileVersions,
        and(
          eq(hubFileVersions.fileId, hubFiles.id),
          eq(hubFileVersions.version, hubFiles.version),
        ),
      )
      .where(
        and(
          eq(hubFiles.id, context.req.param("id")),
          isNull(hubFiles.deletedAt),
          visibleTo(hubFiles.visibility, me),
        ),
      );
    if (!row) return notFound(context);
    await recordAudit(database, {
      ...trailOf(context),
      action: "file.read",
      target: row.id,
      outcome: "ok",
      payload: { version: row.version, part: "text", from },
    });
    const text = row.text ?? "";
    const total = row.total ?? 0;
    const body: HubFileText = {
      ok: true,
      text,
      from,
      total,
      truncated: from + charLength(text) < total,
    };
    return context.json(body);
  });

  route.put("/", async (context) => {
    const key = context.req.header(HUB_HEADERS.idempotencyKey);
    if (!key || !IDEMPOTENCY_KEY_SHAPE.test(key)) {
      return invalid(context, "idempotency-key");
    }
    const declared = Number(context.req.header("content-length") ?? "0");
    if (declared > FILES_BODY_MAX) {
      return context.json({ ok: false, code: HUB_FACTS.fileTooLarge }, 413);
    }
    const boundary = boundaryOf(context.req.header("content-type"));
    const body = context.req.raw.body;
    if (!boundary || !body) return invalid(context, "body");
    const full = () => context.json({ ok: false, code: HUB_FACTS.full }, 507);
    // Refused before a byte is read when the company has nothing left at all.
    if (quotaBytes !== null && (await bytesInUse(database)) >= quotaBytes) {
      return full();
    }

    if (uploading >= UPLOADS_AT_ONCE) {
      context.header("retry-after", "2");
      return context.json({ ok: false, code: HUB_FACTS.busy }, 503);
    }
    uploading += 1;
    const receivers: Promise<BlobReceiver>[] = [];
    try {
      let upload: Upload;
      try {
        upload = await readUpload(body, boundary, dir, fileMaxBytes, receivers);
      } catch (error) {
        if (error instanceof MultipartInvalid) return invalid(context, "body");
        if (error instanceof TextTooLarge) return invalid(context, "text");
        if (error instanceof FileTooLarge) {
          return context.json({ ok: false, code: HUB_FACTS.fileTooLarge }, 413);
        }
        if (error instanceof FilesFull) return full();
        throw error;
      }
      const { meta, blob } = upload;
      if (!meta) return invalid(context, "meta");
      if (!blob) return invalid(context, "blob");

      const self = context.get("member");
      const trail = trailOf(context);
      let answer: Awaited<ReturnType<typeof onceFor>>;
      try {
        answer = await onceFor(database, self.id, key, (tx) =>
          writeVersion(tx, {
            meta,
            upload: { ...upload, blob },
            member: self.id,
            trail,
            dir,
            quotaBytes,
          }),
        );
      } catch (error) {
        // Thrown, not answered, so the transaction and the key's row roll back together: a
        // retry once there is room is a fresh try, not this refusal replayed for a day.
        if (error instanceof FilesFull) return full();
        throw error;
      }
      if (!answer.replayed && answer.status === 200) {
        listeners.pokeAll();
        options.onBlobWritten?.();
      }
      return context.json(
        answer.body as Record<string, unknown>,
        answer.status as 200,
      );
    } finally {
      uploading -= 1;
      // Whatever was not renamed into place: a refused upload, a replay, a failure. Settled first,
      // so a file still being opened when the body broke off is removed too.
      for (const opened of await Promise.allSettled(receivers)) {
        if (opened.status === "fulfilled") await opened.value.discard();
      }
    }
  });

  route.delete("/:id", async (context) => {
    const key = context.req.header(HUB_HEADERS.idempotencyKey);
    if (!key || !IDEMPOTENCY_KEY_SHAPE.test(key)) {
      return invalid(context, "idempotency-key");
    }
    const self = context.get("member");
    const trail = trailOf(context);
    const id = context.req.param("id");
    const answer = await onceFor(database, self.id, key, async (tx) => {
      const [file] = await tx
        .select({
          id: hubFiles.id,
          visibility: hubFiles.visibility,
          createdBy: hubFiles.createdBy,
        })
        .from(hubFiles)
        .where(
          and(
            eq(hubFiles.id, id),
            isNull(hubFiles.deletedAt),
            visibleTo(hubFiles.visibility, self.id),
          ),
        )
        .for("update");
      if (!file) {
        return { status: 404, body: { ok: false, code: HUB_FACTS.notFound } };
      }
      // Seeing a company file is not owning it: the one who put it there, or an admin, takes it
      // away. A `me:` or task file is seen only by those who may already take it.
      if (
        file.visibility === "company" &&
        file.createdBy !== self.id &&
        self.role === "member"
      ) {
        return { status: 403, body: { ok: false, code: HUB_FACTS.forbidden } };
      }
      await tx
        .update(hubFiles)
        .set({ deletedAt: new Date() })
        .where(eq(hubFiles.id, id));
      // Each version stops holding its blob; a blob no live version holds is the sweep's.
      await tx.execute(sql`
        update ${hubBlobs} set refs = ${hubBlobs.refs} - held.n
          from (select ${hubFileVersions.sha256} as sha256, count(*)::int as n
                  from ${hubFileVersions}
                 where ${hubFileVersions.fileId} = ${id}
                 group by ${hubFileVersions.sha256}) as held
         where ${hubBlobs.sha256} = held.sha256`);
      await tx
        .delete(hubChunks)
        .where(
          and(eq(hubChunks.sourceKind, "file"), eq(hubChunks.sourceId, id)),
        );
      await emitEvent(tx, {
        type: "file.changed",
        refId: id,
        actor: self.id,
        visibleTo: await audienceOf(tx, file.visibility),
      });
      await recordAudit(tx, {
        ...trail,
        action: "file.deleted",
        target: id,
        outcome: "ok",
      });
      return { status: 200, body: { ok: true } };
    });
    if (!answer.replayed && answer.status === 200) listeners.pokeAll();
    return context.json(
      answer.body as Record<string, unknown>,
      answer.status as 200,
    );
  });

  return route;
}

/**
 * One version of a file, new or next, in the caller's transaction: the blob counted, the bytes
 * moved into place, the rows written, the file's chunks replaced, the event and the trail.
 */
async function writeVersion(
  tx: HubTransaction,
  input: {
    meta: MetaInput;
    upload: Upload & { blob: Received };
    member: string;
    trail: ReturnType<typeof trailOf>;
    dir: string;
    quotaBytes: number | null;
  },
): Promise<Answer> {
  const { meta, upload, member } = input;
  const bad = (field: string): Answer => ({
    status: 400,
    body: { ok: false, code: "laf:request_invalid", field },
  });

  let fileId: string;
  let version: number;
  let visibility: string;
  let taskId: string | null;
  let name: string;
  const isNew = meta.id === undefined;
  if (!isNew) {
    if (typeof meta.id !== "string") return bad("id");
    const [file] = await tx
      .select({
        id: hubFiles.id,
        version: hubFiles.version,
        visibility: hubFiles.visibility,
        taskId: hubFiles.taskId,
        name: hubFiles.name,
      })
      .from(hubFiles)
      .where(
        and(
          eq(hubFiles.id, meta.id),
          isNull(hubFiles.deletedAt),
          visibleTo(hubFiles.visibility, member),
        ),
      )
      .for("update");
    if (!file) {
      return { status: 404, body: { ok: false, code: HUB_FACTS.notFound } };
    }
    fileId = file.id;
    version = file.version + 1;
    visibility = file.visibility;
    taskId = file.taskId;
    name = file.name;
  } else {
    const cleanedName = cleanName(meta.name);
    if (isInvalid(cleanedName)) return bad("name");
    const folder = cleanFolder(meta.folder);
    if (isInvalid(folder)) return bad("folder");
    const choice = await chooseVisibility(tx, meta.visibility, member);
    if (!choice.ok) {
      return choice.status === 403
        ? { status: 403, body: { ok: false, code: HUB_FACTS.forbidden } }
        : bad("visibility");
    }
    fileId = `f_${randomUUID()}`;
    version = 1;
    visibility = choice.visibility;
    taskId = choice.taskId;
    name = cleanedName;
    await tx.insert(hubFiles).values({
      id: fileId,
      folder,
      name,
      visibility,
      taskId,
      version: 0,
      createdBy: member,
    });
  }

  const { blob } = upload;
  const [held] = await tx
    .select({ refs: hubBlobs.refs })
    .from(hubBlobs)
    .where(eq(hubBlobs.sha256, blob.sha256))
    .for("update");
  if (
    input.quotaBytes !== null &&
    (held?.refs ?? 0) === 0 &&
    (await bytesInUse(tx)) + blob.bytes > input.quotaBytes
  ) {
    throw new FilesFull();
  }
  await tx
    .insert(hubBlobs)
    .values({ sha256: blob.sha256, bytes: blob.bytes, refs: 1 })
    .onConflictDoUpdate({
      target: hubBlobs.sha256,
      set: { refs: sql`${hubBlobs.refs} + 1` },
    });
  // Inside the transaction and before its commit: a row that points at bytes is never visible
  // before the bytes are in place. If the commit then fails, the blob is on disk with no row —
  // wasted space for the sweep, never a broken file.
  await placeBlob(input.dir, blob);

  const now = new Date();
  const text = upload.text;
  await tx.insert(hubFileVersions).values({
    id: `v_${randomUUID()}`,
    fileId,
    version,
    sha256: blob.sha256,
    bytes: blob.bytes,
    mime: upload.mime,
    text,
    textChars: text === null ? null : charLength(text),
    by: member,
    at: now,
  });
  await tx
    .update(hubFiles)
    .set({ version, updatedAt: now })
    .where(eq(hubFiles.id, fileId));

  // The newest version's words replace the last one's, in this transaction: search never shows a
  // file's old text beside its new.
  await tx
    .delete(hubChunks)
    .where(
      and(eq(hubChunks.sourceKind, "file"), eq(hubChunks.sourceId, fileId)),
    );
  const pieces = text ? chunkText(text) : [];
  for (let start = 0; start < pieces.length; start += CHUNK_BATCH) {
    await tx.insert(hubChunks).values(
      pieces.slice(start, start + CHUNK_BATCH).map((piece, offset) => ({
        sourceKind: "file",
        sourceId: fileId,
        ordinal: start + offset,
        text: piece,
        title: name,
        visibility,
        taskId,
        at: now,
      })),
    );
  }

  await emitEvent(tx, {
    type: "file.changed",
    refId: fileId,
    actor: member,
    visibleTo: await audienceOf(tx, visibility),
  });
  await recordAudit(tx, {
    ...input.trail,
    action: "file.written",
    target: fileId,
    outcome: "ok",
    payload: {
      version,
      bytes: blob.bytes,
      textChars: text === null ? null : charLength(text),
      chunks: pieces.length,
    },
  });
  const body: HubFilePut = {
    ok: true,
    id: fileId,
    version,
    sha256: blob.sha256,
  };
  return { status: 200, body };
}
