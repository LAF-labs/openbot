/**
 * A file the owner hands the Bot with a message: the contract both ends read.
 *
 * On the wire an attachment is one AG-UI `binary` part of the user message — `{type:"binary",
 * mimeType, id, filename}` — and nothing else: no bytes, no extracted text. The stored transcript
 * therefore holds a REFERENCE, which is what the surface draws a chip from after a reload, and the
 * server turns it into what the model reads on the way out (`server/src/attachments/for-model.ts`).
 * `binary` rather than `image` or `document`, because every schema in AG-UI is zod `strip` and
 * `binary` is the one part whose kept fields (`id`, `filename`) are enough to find the file again.
 *
 * In `shared/` because the surface and the server must agree on the limits: a picker that accepts
 * what the server then refuses is a control that lies.
 */

/** The most one file may be. A receipt photo, a month of sales and a menu all fit many times over. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The most a photo may be once it reaches the server. The surface shrinks every photo it can decode
 * to a JPEG of at most `IMAGE_LONG_EDGE` pixels first — typically a few hundred kilobytes — because
 * a photo rides along in every later turn of the conversation, and a phone's 12 MB original would be
 * resent each time.
 */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** The long edge the surface shrinks a photo to. Enough to read a receipt's small print. */
export const IMAGE_LONG_EDGE = 2000;

/** The most a photo may be BEFORE the surface shrinks it: what a phone camera writes, and then some. */
export const IMAGE_SOURCE_MAX_BYTES = 40 * 1024 * 1024;

/** The most files one message may carry. */
export const ATTACHMENTS_PER_MESSAGE = 5;

export type AttachmentKind = "image" | "sheet" | "pdf";

/**
 * What is accepted, by the type the SERVER detects from the bytes (`file-type`), never by the name
 * or by what the browser claims. The extension here is the one the stored name is given, so a file
 * called `menu.pdf` that is really a picture is kept as `menu.jpg`.
 */
export const ATTACHMENT_TYPES: Readonly<
  Record<string, { kind: AttachmentKind; extension: string }>
> = {
  "image/jpeg": { kind: "image", extension: "jpg" },
  "image/png": { kind: "image", extension: "png" },
  "image/webp": { kind: "image", extension: "webp" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    kind: "sheet",
    extension: "xlsx",
  },
  "application/vnd.ms-excel": { kind: "sheet", extension: "xls" },
  "text/csv": { kind: "sheet", extension: "csv" },
  "application/pdf": { kind: "pdf", extension: "pdf" },
};

/**
 * What the picker offers. Wider than the list above only by HEIC, which the surface converts where
 * it can decode one (WebKit) and refuses before uploading where it cannot (Chromium, the Windows
 * app's WebView2) — `uploadAttachment` in `app/src/lib/attachments/upload.ts`.
 */
export const ATTACHMENT_PICKER_ACCEPT =
  ".jpg,.jpeg,.png,.webp,.heic,.heif,.xlsx,.xls,.csv,.pdf";

/** One attachment as a message part. */
export type AttachmentPart = {
  type: "binary";
  mimeType: string;
  /** The server's id for the file: what the model form and the chip are both found by. */
  id: string;
  /** The name as stored, already made safe by the server. */
  filename: string;
};

/** An attachment id: the server mints UUIDs, and nothing else is looked up. */
const ATTACHMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isAttachmentId(value: unknown): value is string {
  return typeof value === "string" && ATTACHMENT_ID.test(value);
}

export function isAttachmentPart(part: unknown): part is AttachmentPart {
  if (!part || typeof part !== "object") return false;
  const candidate = part as Record<string, unknown>;
  return (
    candidate.type === "binary" &&
    isAttachmentId(candidate.id) &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.filename === "string"
  );
}

/** The attachments a message carries, in order. A plain-string message carries none. */
export function attachmentPartsOf(content: unknown): AttachmentPart[] {
  return Array.isArray(content) ? content.filter(isAttachmentPart) : [];
}

export function attachmentKindOf(mimeType: string): AttachmentKind | null {
  return ATTACHMENT_TYPES[mimeType]?.kind ?? null;
}
