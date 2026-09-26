/**
 * Files the owner hands their Bot: taking one in, handing it back, and what the model reads for it.
 *
 * WHERE A FILE LIVES (0.5.4 candidate 15). The bytes are a row here (`laf_attachments`), which the
 * account, the conversation and the Bot each take with them when they go, like a browsing task's
 * picture. What the Bot can READ of a sheet or a PDF also goes to its computer as text
 * (`uploads/…csv|txt`), through the same `/files/write` the spillover uses — so the tool it already
 * has, `computer_read_file`, reads the whole of a file the conversation only summarises, and neither
 * the tool list nor the computer changes. A photo is not written there: it is not text, and the Bot
 * sees it as a picture in the message instead.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  type AttachmentKind,
  IMAGE_MAX_BYTES,
} from "../../../shared/attachments";
import {
  documentAttachmentText,
  imageAttachmentText,
  PDF_WITHOUT_TEXT,
  SHEET_WITHOUT_ROWS,
} from "../../../shared/prompt/attachments.ko";
import type { WriteFileInput, WriteFileResult } from "../computer/schema";
import type { Database } from "../db/client";
import { lafAttachments } from "../db/schema";
import { log } from "../log";
import { type Converter, createConverter } from "./converter-client";
import type { Extracted } from "./extract";
import { safeAttachmentName, workspacePathFor } from "./files";

/** Why a file was not taken. Codes, never sentences: the surface owns the words. */
export type AttachmentRefusal =
  | "laf:attachment_empty"
  | "laf:attachment_too_large"
  | "laf:attachment_type_unsupported"
  | "laf:attachment_image_unsupported"
  | "laf:attachment_unreadable"
  /** Nothing could read it safely: the deployment's converter is missing or not answering. */
  | "laf:attachment_converter_unavailable";

/** What the surface is told about a file it sent, to draw the chip and to put in the message. */
export type ReceivedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  bytes: number;
};

/** What the model is handed for one attachment. */
export type AttachmentForModel = {
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  modelText: string;
  /** Base64, for a photo only. */
  image?: string;
};

/** The one method this needs of the computer client, so a test can hand in a recorder. */
export type AttachmentFiler = {
  forBot(botId: string): {
    writeFile(input: WriteFileInput): Promise<WriteFileResult>;
  };
};

export type AttachmentService = {
  /**
   * Whether this deployment's model sees pictures (`model.supports_images`). False refuses a photo
   * with its own code, and the surface does not offer photos at all — a picker that accepts what
   * nobody can look at is a control that lies.
   */
  imagesAccepted: boolean;
  receive(input: {
    userId: string;
    channelId: string;
    botId: string;
    claimedName: string;
    bytes: Uint8Array;
  }): Promise<
    | { ok: true; attachment: ReceivedAttachment }
    | { ok: false; code: AttachmentRefusal }
  >;
  /** The file itself, to its owner, in the conversation it was sent in. */
  file(
    userId: string,
    channelId: string,
    id: string,
  ): Promise<{ name: string; mimeType: string; data: Buffer } | null>;
  /** What the model reads for these ids, for this Bot only. Unknown ids are simply absent. */
  forModel(
    botId: string,
    ids: readonly string[],
  ): Promise<Map<string, AttachmentForModel>>;
};

export function createAttachmentService(options: {
  database: Database;
  /** Absent: nothing is written to a computer, and the model is told the whole cannot be read. */
  computer?: AttachmentFiler;
  imagesAccepted: boolean;
  /** Where uploaded bytes are read. Absent: a local child, as on a laptop (`converter-client.ts`). */
  converter?: Converter;
}): AttachmentService {
  const { database, computer, imagesAccepted } = options;

  /*
   * EVERY BYTE OF AN UPLOAD IS READ ELSEWHERE (security package item 11): the type sniff and the
   * sheet and PDF parsers run in a fresh, unprivileged child with no network — the `converter`
   * sidecar in a deployment, a local child on a laptop — never in this process, which runs beside
   * the database and every sealed token. See `converter-client.ts`.
   */
  const converter = options.converter ?? createConverter({ kind: "local" }, {});

  /** The readable whole onto the Bot's computer. Null when it could not be put there. */
  const fileOnComputer = async (
    botId: string,
    path: string,
    contents: string,
  ): Promise<string | null> => {
    if (!computer) return null;
    try {
      await computer.forBot(botId).writeFile({ path, contents });
      return path;
    } catch (error) {
      log.warn("attachment_not_filed", {
        bot: botId,
        reason: error instanceof Error ? error.name : "unknown",
      });
      return null;
    }
  };

  return {
    imagesAccepted,

    async receive({ userId, channelId, botId, claimedName, bytes }) {
      if (bytes.byteLength === 0)
        return { ok: false, code: "laf:attachment_empty" };
      if (bytes.byteLength > ATTACHMENT_MAX_BYTES)
        return { ok: false, code: "laf:attachment_too_large" };

      const converted = await converter.convert({ name: claimedName, bytes });
      if (!converted.ok) {
        // Names only, never the file: which wall the reading hit.
        log.warn("attachment_unreadable", {
          reason: converted.failure,
          setting: converter.setting,
        });
        if (converted.failure === "too_large") {
          return { ok: false, code: "laf:attachment_too_large" };
        }
        return {
          ok: false,
          code:
            converted.failure === "unavailable"
              ? "laf:attachment_converter_unavailable"
              : "laf:attachment_unreadable",
        };
      }
      const conversion = converted.conversion;
      if (conversion.outcome === "unsupported") {
        return { ok: false, code: "laf:attachment_type_unsupported" };
      }
      const known = ATTACHMENT_TYPES[conversion.mimeType];
      if (!known) return { ok: false, code: "laf:attachment_type_unsupported" };
      const type = { mimeType: conversion.mimeType, ...known };
      if (conversion.outcome === "unreadable") {
        log.warn("attachment_unreadable", {
          kind: type.kind,
          reason: conversion.reason,
        });
        return { ok: false, code: "laf:attachment_unreadable" };
      }
      if (type.kind === "image") {
        if (!imagesAccepted)
          return { ok: false, code: "laf:attachment_image_unsupported" };
        // The surface shrinks a photo long before this; a picture this large came some other way
        // and would ride along on every turn of the conversation.
        if (bytes.byteLength > IMAGE_MAX_BYTES)
          return { ok: false, code: "laf:attachment_too_large" };
      }

      const id = randomUUID();
      const name = safeAttachmentName(claimedName, type.extension);
      const now = new Date();

      let modelText: string;
      let workspacePath: string | null = null;
      if (type.kind === "image") {
        modelText = imageAttachmentText(name, bytes.byteLength);
      } else {
        const extracted: Extracted | null =
          conversion.outcome === "read" ? conversion.extracted : null;
        if (!extracted) return { ok: false, code: "laf:attachment_unreadable" };
        if (extracted.whole) {
          workspacePath = await fileOnComputer(
            botId,
            workspacePathFor(
              id,
              name,
              now,
              type.kind === "sheet" ? "csv" : "txt",
            ),
            extracted.whole,
          );
        }
        const empty =
          type.kind === "pdf" ? PDF_WITHOUT_TEXT : SHEET_WITHOUT_ROWS;
        modelText = documentAttachmentText({
          name,
          kind: type.kind,
          bytes: bytes.byteLength,
          workspacePath,
          body: extracted.body || empty,
          ...(extracted.shown ? { shown: extracted.shown } : {}),
        });
      }

      await database.insert(lafAttachments).values({
        id,
        userId,
        channelId,
        agentId: botId,
        name,
        mimeType: type.mimeType,
        bytes: bytes.byteLength,
        data: Buffer.from(bytes),
        modelText,
        workspacePath,
        createdAt: now,
      });
      return {
        ok: true,
        attachment: {
          id,
          name,
          mimeType: type.mimeType,
          kind: type.kind,
          bytes: bytes.byteLength,
        },
      };
    },

    async file(userId, channelId, id) {
      const [row] = await database
        .select({
          name: lafAttachments.name,
          mimeType: lafAttachments.mimeType,
          data: lafAttachments.data,
        })
        .from(lafAttachments)
        .where(
          and(
            eq(lafAttachments.id, id),
            eq(lafAttachments.userId, userId),
            eq(lafAttachments.channelId, channelId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async forModel(botId, ids) {
      const found = new Map<string, AttachmentForModel>();
      if (ids.length === 0) return found;
      const rows = await database
        .select({
          id: lafAttachments.id,
          name: lafAttachments.name,
          mimeType: lafAttachments.mimeType,
          modelText: lafAttachments.modelText,
          data: lafAttachments.data,
        })
        .from(lafAttachments)
        .where(
          and(
            inArray(lafAttachments.id, [...ids]),
            eq(lafAttachments.agentId, botId),
          ),
        );
      for (const row of rows) {
        const kind = row.mimeType.startsWith("image/")
          ? "image"
          : row.mimeType === "application/pdf"
            ? "pdf"
            : "sheet";
        found.set(row.id, {
          name: row.name,
          mimeType: row.mimeType,
          kind,
          modelText: row.modelText,
          ...(kind === "image" ? { image: row.data.toString("base64") } : {}),
        });
      }
      return found;
    },
  };
}
