/**
 * Handing the Bot a file from the composer: checking it, shrinking a photo, and sending it up.
 *
 * The server decides what a file IS from its bytes and refuses the rest (`server/src/attachments/`);
 * the checks here only say so sooner, in words, before a 10 MB upload has been waited for. Both read
 * the same limits (`@shared/attachments`), so the picker never offers what the server then refuses.
 *
 * A PHOTO IS SHRUNK HERE, BEFORE IT LEAVES. A photo rides along in every later turn of the
 * conversation, and a phone's 12 MB original would be sent to the model each time. The browser the
 * person is looking at already decodes it — the same reason a browsing task's picture is made on
 * this side (`lib/computer/last-frame.ts`). Re-encoding also drops the photo's metadata, the GPS
 * position of the shop included, which the Bot has no use for.
 */
import {
  ATTACHMENT_MAX_BYTES,
  type AttachmentKind,
  type AttachmentPart,
  IMAGE_LONG_EDGE,
  IMAGE_SOURCE_MAX_BYTES,
} from "@shared/attachments";
import { t } from "@/lib/i18n";

/** What the server said it kept: enough for the chip and the message part. */
export type ReceivedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  bytes: number;
};

const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "heic",
  "heif",
]);
const DOCUMENT_EXTENSIONS = new Set(["xlsx", "xls", "csv", "pdf"]);

const JPEG_QUALITY = 0.88;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isImageFile(file: File): boolean {
  return (
    IMAGE_EXTENSIONS.has(extensionOf(file.name)) ||
    file.type.startsWith("image/")
  );
}

/**
 * Why a file is not even sent, as the sentence the owner reads. Null when it may go.
 *
 * Literal `t()` calls, so the coverage walk sees every one of them.
 */
export function refusalBeforeUpload(
  file: File,
  imagesAccepted: boolean,
): string | null {
  const image = isImageFile(file);
  if (image && !imagesAccepted) {
    return t(
      "This Bot's model cannot see photos. Attach an Excel, CSV or PDF file instead.",
    );
  }
  if (!image && !DOCUMENT_EXTENSIONS.has(extensionOf(file.name))) {
    return imagesAccepted
      ? t("Only photos, Excel or CSV files and PDFs can be attached.")
      : t("Only Excel or CSV files and PDFs can be attached.");
  }
  if (file.size === 0) return t("This file is empty.");
  if (file.size > (image ? IMAGE_SOURCE_MAX_BYTES : ATTACHMENT_MAX_BYTES)) {
    return t("This file is too large. Files up to 10 MB can be attached.");
  }
  return null;
}

/** The server's refusal codes, in the owner's words. Walked by `attachments.test.ts`. */
export function uploadRefusalText(code: unknown): string {
  switch (code) {
    case "laf:attachment_too_large":
      return t("This file is too large. Files up to 10 MB can be attached.");
    case "laf:attachment_type_unsupported":
      return t(
        "This file could not be recognised. Attach a photo, an Excel or CSV file, or a PDF.",
      );
    case "laf:attachment_image_unsupported":
      return t(
        "This Bot's model cannot see photos. Attach an Excel, CSV or PDF file instead.",
      );
    case "laf:attachment_empty":
      return t("This file is empty.");
    case "laf:attachment_unreadable":
      return t(
        "This file could not be opened. It may be damaged or password-protected.",
      );
    case "laf:attachment_converter_unavailable":
      // The file is not at fault: what reads files safely on this deployment is not running.
      return t(
        "Files cannot be read right now. Try again in a moment, and tell us if it keeps happening.",
      );
    default:
      return t("The file could not be attached. Please try again.");
  }
}

/**
 * A photo as a JPEG no larger than `IMAGE_LONG_EDGE` on its long edge. The original when the browser
 * cannot decode it (HEIC in Chrome), and the server then says whether it can take it.
 */
async function shrunk(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(
    1,
    IMAGE_LONG_EDGE / Math.max(bitmap.width, bitmap.height),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return file;
  }
  // A transparent PNG would turn black as a JPEG; a receipt is read on white.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!blob) return file;
  const dot = file.name.lastIndexOf(".");
  const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
  return new File([blob], `${stem}.jpg`, { type: "image/jpeg" });
}

export class AttachmentUploadError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AttachmentUploadError";
  }
}

export async function uploadAttachment(
  channelId: string,
  original: File,
): Promise<ReceivedAttachment> {
  const file = isImageFile(original) ? await shrunk(original) : original;
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await fetch(
    `/api/channels/${encodeURIComponent(channelId)}/attachments`,
    { method: "POST", credentials: "include", body: form },
  ).catch(() => null);
  if (!response) throw new AttachmentUploadError("laf:attachment_network");
  const body = (await response.json().catch(() => null)) as {
    attachment?: ReceivedAttachment;
    code?: string;
  } | null;
  if (!response.ok || !body?.attachment) {
    throw new AttachmentUploadError(body?.code ?? "laf:attachment_failed");
  }
  return body.attachment;
}

/** The file's address, for a photo's `<img>` and a document's download. */
export function attachmentAddress(channelId: string, id: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/attachments/${encodeURIComponent(id)}`;
}

/** The part a sent message carries for one attachment. */
export function attachmentPartOf(received: ReceivedAttachment): AttachmentPart {
  return {
    type: "binary",
    mimeType: received.mimeType,
    id: received.id,
    filename: received.name,
  };
}

/** A size as the chip says it. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
