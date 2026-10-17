/**
 * A file into the company's team files, with the words in it: `uploadToHub`, the one way this VM
 * puts a file on its hub — 라피's `mcp__hub__write` kind `upload` (`tools.ts`), and the 회사 tab's
 * upload once its route calls it (a follow-up to #256, `routes-ui.ts`).
 *
 * THE WORDS ARE READ HERE, NOT ON THE HUB (hub design §5.3). The hub is one small machine for a
 * whole company and holds no converter; each member's VM already has one (`attachments/`), sealed
 * off from this process, and reads a sheet or a PDF into text the way it does for an attachment.
 * The text rides beside the bytes in the same `PUT /files`, so team search finds a file by a word
 * inside its sheet and not only by its name. A file the converter does not read (a photo, a zip)
 * goes without text; a file it cannot read goes without text too, and still goes.
 *
 * TWO SOURCES, TWO PROMISES.
 *
 * - FROM THE BOT'S FOLDER (a path): a run's read, so it is judged as one — by the gateway, under
 *   the run's file scope, with the row a `computer_read_file` writes (`shared/file-scope.ts`: a
 *   project's run reads its own folder and the Bot's, never another project's). Then a
 *   `hub_outbox` row that holds a REFERENCE — where the file is, whose scope read it, and its
 *   SHA-256 — never the bytes: a ten-megabyte sheet does not belong in a jsonb column, and a hub
 *   that is down for an hour would otherwise hold every upload in the database. Each attempt
 *   reads the file again and sends it only if it is still the file that was judged: changed, the
 *   row ends `laf:hub_upload_changed`; gone, `laf:hub_upload_gone`. Never a different file under
 *   the judged name.
 * - FROM A STREAM (a person handing a file to the 회사 tab): sent once, now, through to the hub as
 *   it arrives. Nothing on this VM holds the bytes to send again, so there is no outbox row; the
 *   person is there to see the answer and press again, with the same idempotency key.
 *
 * NOTHING HOLDS THE WHOLE FILE TWICE. The body is a stream built part by part; a folder file is
 * held once, as the computer hands it over (its bound for a whole file is the attachment bound,
 * ten megabytes), and a stream is passed through, with at most that bound kept aside for the
 * converter — past it, the file goes without text.
 */
import { createHash, randomUUID } from "node:crypto";
import { ATTACHMENT_MAX_BYTES } from "../../../shared/attachments";
import {
  type FileScope,
  fileScopeHeader,
  fileScopeOf,
  scopeRefusal,
} from "../../../shared/file-scope";
import type { Converter } from "../attachments/converter-client";
import { WHOLE_BYTES } from "../attachments/extract";
import {
  ComputerUnavailableError,
  FILE_NOT_FOUND,
  WorkspaceRefusedError,
  WorkspaceRequestError,
} from "../computer/client";
import type { HubAnswer, HubHttp } from "./http";
import type { HubOutbox, HubOutboxWrite } from "./outbox";
import { HUB_TOOL_PATHS } from "./wire";

/** The file read for the upload is not the file that was judged any more. The row ends. */
export const HUB_UPLOAD_CHANGED = "laf:hub_upload_changed";
/** Nothing is at the judged path any more. The row ends. */
export const HUB_UPLOAD_GONE = "laf:hub_upload_gone";
/** A rule asks a person before this file is read; the upload does not go (`tools.ts`). */
export const HUB_UPLOAD_READ_ASKED = "laf:hub_upload_read_asked";
/**
 * The computer did not answer when a row went to read its file again. Not the hub's absence: the
 * row waits, and the rows behind it are still offered (`outbox.ts`).
 */
export const HUB_UPLOAD_SOURCE_AWAY = "laf:computer_unreachable";

/** Who may see the file, as the hub names it (`HubVisibility`, #251). Absent: the hub's default. */
export type HubUploadVisibility = "company" | `me:${string}` | `task:${string}`;

/** What an outbox row holds for an upload: where the file is, and which bytes were judged. */
export type HubUploadReference = {
  botId: string;
  /** The scope the read was judged under, as its header says it (`fileScopeHeader`). */
  scope: string;
  path: string;
  sha256: string;
  size: number;
  name: string;
  folder: string;
  visibility: HubUploadVisibility | null;
};

/** Whoever ran the call: the gateway reads the run's file scope from its conversation. */
export type HubUploadActor = { id: string; threadId?: string; runId?: string };

type Placement = {
  /** The name on the hub. Absent: the file's own name, from its path. */
  name?: string;
  /** The team folder: `/` or `/영업/2026`. Absent: `/`. */
  folder?: string;
  visibility?: HubUploadVisibility;
  runId?: string | null;
  origin: HubOutboxWrite["origin"];
};

/** A file in the Bot's folder. */
export type HubUploadFromFolder = Placement & {
  path: string;
  botId: string;
  /** A run's upload: its read is judged by the gateway under the run's scope. */
  actor?: HubUploadActor;
  /** The person's own door instead (`PERSON_SCOPE`): read as that scope, not judged. */
  scope?: FileScope;
};

/** A file arriving as a stream: the 회사 tab's upload. */
export type HubUploadFromStream = Placement & {
  stream: ReadableStream<Uint8Array>;
  name: string;
  /** Stable across the person pressing again, so the hub writes the file once. */
  idempotencyKey: string;
};

export type HubUploadInput = HubUploadFromFolder | HubUploadFromStream;

/** A folder's upload is a row; a stream's is the hub's answer. */
export type HubUploadOutcome =
  | { queued: string }
  | { answer: HubAnswer<unknown> };

/** An upload that cannot go at all, as a fact (`laf:…`), before any row. */
export class HubUploadRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HubUploadRefused";
  }
}

export type HubUploadDeps = {
  http: HubHttp;
  outbox: Pick<HubOutbox, "enqueue">;
  converter: Pick<Converter, "convert">;
  /** The Bot's folder, read as `scope` says. Not judged: the caller judged it, or it is the person. */
  readFolder(input: {
    botId: string;
    scope: FileScope;
    path: string;
  }): Promise<Uint8Array>;
  /** A run's read, judged by the gateway as `computer_read_file` (`gateway/acts.ts`). */
  readJudged(input: {
    botId: string;
    actor: HubUploadActor;
    path: string;
  }): Promise<{ path: string; bytes: Uint8Array }>;
  /** The run's file scope, from its conversation — the gateway's own reading (`gateway.ts`). */
  scopeOfThread(threadId: string | undefined): Promise<FileScope>;
};

/** Plain text, read here: no parser, only a decoder. Everything else goes to the converter. */
const PLAIN_TEXT = [".txt", ".md", ".markdown"];
/** What the converter reads (`shared/attachments.ts`, `ATTACHMENT_TYPES`). */
const CONVERTED = [".xlsx", ".xls", ".csv", ".tsv", ".pdf"];

const endsWithOneOf = (name: string, endings: readonly string[]) =>
  endings.some((ending) => name.toLowerCase().endsWith(ending));

/** Whether a file of this name may have words worth reading out of it. */
export const mayHaveText = (name: string) =>
  endsWithOneOf(name, PLAIN_TEXT) || endsWithOneOf(name, CONVERTED);

/**
 * Text as a person's editor saves it: UTF-8, or else the Korean code page (CP949, which `euc-kr`
 * decodes) — the attachment reader's order (`extract.ts`). A NUL is no text file at all.
 */
function plainText(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, WHOLE_BYTES + 4);
  if (head.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(head);
  } catch {
    // Cut inside a character, or not UTF-8: the first is fixed by dropping the cut, the second
    // by the code page.
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, Math.min(bytes.byteLength, WHOLE_BYTES)),
      );
    } catch {
      text = new TextDecoder("euc-kr").decode(head);
    }
  }
  // The converter's bound for a readable whole: the same for every kind of file.
  if (Buffer.byteLength(text, "utf8") > WHOLE_BYTES) {
    text = Buffer.from(text, "utf8")
      .subarray(0, WHOLE_BYTES)
      .toString("utf8")
      .replace(/�$/, "");
  }
  return text.trim() ? text : null;
}

/**
 * The words in a file, or null: read by the converter for a sheet or a PDF, decoded here for plain
 * text. A failure is no text, never no upload — the file is the person's, the text only helps it
 * be found.
 */
export async function textOfFile(
  converter: Pick<Converter, "convert">,
  name: string,
  bytes: Uint8Array,
): Promise<string | null> {
  if (bytes.byteLength === 0 || bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    return null;
  }
  if (endsWithOneOf(name, PLAIN_TEXT)) return plainText(bytes);
  if (!endsWithOneOf(name, CONVERTED)) return null;
  const outcome = await converter
    .convert({ name, bytes: new Uint8Array(bytes) })
    .catch(() => null);
  if (!outcome?.ok || outcome.conversion.outcome !== "read") return null;
  const { whole, body } = outcome.conversion.extracted;
  const text = (whole ?? body).replaceAll("\u0000", "");
  return text.trim() ? text : null;
}

const encoder = new TextEncoder();

type Part = {
  name: "meta" | "text" | "blob";
  contentType: string;
  /** Asked for when the part's turn comes, so a part may wait on the one before it. */
  body: () => Promise<Uint8Array | ReadableStream<Uint8Array> | null>;
};

/**
 * A `multipart/form-data` body, written part by part as it is read — the shape the hub reads part
 * by part (`hub/src/files/multipart.ts`). A part whose body is null is left out.
 */
export function multipartBody(parts: readonly Part[]): {
  contentType: string;
  body: ReadableStream<Uint8Array>;
} {
  const boundary = `laf-${randomUUID()}`;
  async function* pieces(): AsyncGenerator<Uint8Array> {
    for (const part of parts) {
      const body = await part.body();
      if (body === null) continue;
      const filename = part.name === "blob" ? '; filename="blob"' : "";
      yield encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${filename}\r\nContent-Type: ${part.contentType}\r\n\r\n`,
      );
      if (body instanceof Uint8Array) {
        yield body;
      } else {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            yield value;
          }
        } finally {
          reader.releaseLock();
        }
      }
      yield encoder.encode("\r\n");
    }
    yield encoder.encode(`--${boundary}--\r\n`);
  }
  const iterator = pieces();
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel() {
        await iterator.return(undefined);
      },
    }),
  };
}

const sha256Of = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** The last name in a path: what a file is called when nobody names it. */
const baseName = (path: string) =>
  path.split("/").filter(Boolean).pop()?.trim() ?? "";

const metaOf = (input: {
  name: string;
  folder: string;
  visibility: HubUploadVisibility | null;
}) =>
  encoder.encode(
    JSON.stringify({
      name: input.name,
      folder: input.folder,
      ...(input.visibility ? { visibility: input.visibility } : {}),
    }),
  );

const answerRefusing = (code: string): HubAnswer<never> => ({
  ok: false,
  status: null,
  code,
});

/** A read that failed, as the fact the Bot or the row is told. */
function refusalOf(error: unknown): HubUploadRefused {
  if (error instanceof HubUploadRefused) return error;
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : error instanceof Error
        ? error.message
        : null;
  if (code === "laf:awaiting_approval") {
    return new HubUploadRefused(HUB_UPLOAD_READ_ASKED);
  }
  if (typeof code === "string" && code.startsWith("laf:")) {
    return new HubUploadRefused(code);
  }
  throw error;
}

/** An outbox row's body, read back as an upload's reference — or null, for every other write. */
export function uploadReferenceOf(body: unknown): HubUploadReference | null {
  const held =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { upload?: unknown }).upload
      : undefined;
  if (!held || typeof held !== "object") return null;
  const value = held as Record<string, unknown>;
  const text = (key: string) =>
    typeof value[key] === "string" ? (value[key] as string) : null;
  const botId = text("botId");
  const scope = text("scope");
  const path = text("path");
  const sha256 = text("sha256");
  const name = text("name");
  const folder = text("folder");
  if (!botId || !scope || !path || !sha256 || !name || !folder) return null;
  return {
    botId,
    scope,
    path,
    sha256,
    size: typeof value.size === "number" ? value.size : 0,
    name,
    folder,
    visibility: (text("visibility") as HubUploadVisibility | null) ?? null,
  };
}

export type HubUploads = {
  uploadToHub(input: HubUploadInput): Promise<HubUploadOutcome>;
  /** One attempt at a row's upload: the file read again, checked, and sent (`outbox.ts`). */
  sendReference(
    reference: HubUploadReference,
    request: { idempotencyKey: string; origin: string; run?: string },
  ): Promise<HubAnswer<unknown>>;
};

export function createHubUploads(deps: HubUploadDeps): HubUploads {
  /** The file, read as the call's scope may read it, or a refusal naming why not. */
  async function readForCall(input: HubUploadFromFolder) {
    const scope = input.actor
      ? await deps.scopeOfThread(input.actor.threadId)
      : input.scope;
    // A file call that does not say whose files it touches is refused, never guessed (CLAUDE.md).
    if (!scope) throw new HubUploadRefused("laf:request_invalid");
    // Asked here as well as by the gateway and the computer, so a project's run naming another
    // project's file is refused before anything is read or asked.
    const refused = scopeRefusal(scope, input.path, "read");
    if (refused) throw new HubUploadRefused(refused);
    try {
      if (input.actor) {
        const judged = await deps.readJudged({
          botId: input.botId,
          actor: input.actor,
          path: input.path,
        });
        return { scope, path: judged.path, bytes: judged.bytes };
      }
      const bytes = await deps.readFolder({
        botId: input.botId,
        scope,
        path: input.path,
      });
      return { scope, path: input.path, bytes };
    } catch (error) {
      throw refusalOf(error);
    }
  }

  async function fromFolder(input: HubUploadFromFolder): Promise<string> {
    const read = await readForCall(input);
    const name = input.name?.trim() || baseName(read.path);
    if (!name) throw new HubUploadRefused("laf:tool_arguments_invalid");
    const reference: HubUploadReference = {
      botId: input.botId,
      scope: fileScopeHeader(read.scope),
      path: read.path,
      sha256: sha256Of(read.bytes),
      size: read.bytes.byteLength,
      name,
      folder: input.folder?.trim() || "/",
      visibility: input.visibility ?? null,
    };
    return deps.outbox.enqueue({
      method: "PUT",
      path: HUB_TOOL_PATHS.files,
      body: { upload: reference },
      origin: input.origin,
      runId: input.runId ?? input.actor?.runId ?? null,
    });
  }

  async function fromStream(
    input: HubUploadFromStream,
  ): Promise<HubAnswer<unknown>> {
    // Kept aside for the converter while it passes through, up to the converter's bound. Past it,
    // let go of, and the file goes without text.
    let kept: Uint8Array[] | null = mayHaveText(input.name) ? [] : null;
    let size = 0;
    const through = input.stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (kept) {
            size += chunk.byteLength;
            if (size > ATTACHMENT_MAX_BYTES) kept = null;
            else kept.push(chunk);
          }
          controller.enqueue(chunk);
        },
      }),
    );
    const multipart = multipartBody([
      {
        name: "meta",
        contentType: "application/json",
        body: async () =>
          metaOf({
            name: input.name,
            folder: input.folder?.trim() || "/",
            visibility: input.visibility ?? null,
          }),
      },
      {
        name: "blob",
        contentType: "application/octet-stream",
        body: async () => through,
      },
      // After the blob, so the words are read from bytes that have already gone (the hub reads
      // the parts in any order).
      {
        name: "text",
        contentType: "text/plain; charset=utf-8",
        body: async () => {
          const held = kept;
          if (!held) return null;
          const text = await textOfFile(
            deps.converter,
            input.name,
            Buffer.concat(held),
          );
          return text === null ? null : encoder.encode(text);
        },
      },
    ]);
    return deps.http.upload({
      path: HUB_TOOL_PATHS.files,
      body: multipart.body,
      contentType: multipart.contentType,
      idempotencyKey: input.idempotencyKey,
      origin: input.origin,
      ...(input.runId ? { run: input.runId } : {}),
    });
  }

  return {
    async uploadToHub(input) {
      if ("stream" in input) return { answer: await fromStream(input) };
      return { queued: await fromFolder(input) };
    },

    async sendReference(reference, request) {
      const scope = fileScopeOf(reference.scope);
      if (!scope) return answerRefusing("laf:request_invalid");
      let bytes: Uint8Array;
      try {
        bytes = await deps.readFolder({
          botId: reference.botId,
          scope,
          path: reference.path,
        });
      } catch (error) {
        if (error instanceof ComputerUnavailableError) {
          return answerRefusing(HUB_UPLOAD_SOURCE_AWAY);
        }
        if (
          (error instanceof WorkspaceRequestError ||
            error instanceof WorkspaceRefusedError) &&
          error.message === FILE_NOT_FOUND
        ) {
          return answerRefusing(HUB_UPLOAD_GONE);
        }
        return answerRefusing(
          error instanceof Error && error.message.startsWith("laf:")
            ? error.message
            : HUB_UPLOAD_GONE,
        );
      }
      // Only the bytes that were judged go: a file written over since is not what was asked about.
      if (sha256Of(bytes) !== reference.sha256) {
        return answerRefusing(HUB_UPLOAD_CHANGED);
      }
      const text = await textOfFile(deps.converter, reference.name, bytes);
      const multipart = multipartBody([
        {
          name: "meta",
          contentType: "application/json",
          body: async () => metaOf(reference),
        },
        {
          name: "text",
          contentType: "text/plain; charset=utf-8",
          body: async () => (text === null ? null : encoder.encode(text)),
        },
        {
          name: "blob",
          contentType: "application/octet-stream",
          body: async () => bytes,
        },
      ]);
      return deps.http.upload({
        path: HUB_TOOL_PATHS.files,
        body: multipart.body,
        contentType: multipart.contentType,
        idempotencyKey: request.idempotencyKey,
        origin: request.origin,
        ...(request.run ? { run: request.run } : {}),
      });
    },
  };
}
