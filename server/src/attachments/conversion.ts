/**
 * One uploaded file, read: what it is, and for a sheet or a PDF, what the model reads of it.
 *
 * NEVER IN THE API SERVER'S PROCESS. `convertUpload` is the only code that parses the bytes a person
 * (or whoever sent them the file) chose — the magic-number sniff in `file-type`, SheetJS and pdf.js —
 * and all three are parsers of hostile input with a history: SheetJS had a prototype pollution
 * (CVE-2023-30533) and `file-type` an infinite loop on a malformed MKV (CVE-2022-36313). The server
 * runs as root beside the database, every sealed token and the model key, so the parse runs in a
 * child process of the converter instead (`converter-process.ts`), which in a deployment is a
 * sidecar with no network, no capabilities and no identity (`docker-compose.yml`, `converter`).
 *
 * What comes back crosses a trust boundary the other way, so `conversionFrom` reads it as a stranger's
 * JSON: a known type, bounded strings, nothing else. A converter a file managed to subvert can
 * still lie about the words, but it cannot make the server keep a type it does not accept or hold
 * more text than an honest reading could produce.
 */
import { ATTACHMENT_TYPES } from "../../../shared/attachments";
import { type Extracted, SUMMARY_CHARS, WHOLE_BYTES } from "./extract";

/** The header the file's name travels in, percent-encoded: it is Korean more often than not. */
export const FILE_NAME_HEADER = "x-laf-file-name";

/** What the converter says about one file. */
export type Conversion =
  /** Not a type this product accepts, whatever it was called. */
  | { outcome: "unsupported" }
  /** A photo: its type is all the server needs, and it is never parsed further. */
  | { outcome: "image"; mimeType: string }
  /** A sheet or a PDF, read. */
  | { outcome: "read"; mimeType: string; extracted: Extracted }
  /** A sheet or a PDF its library could not read. `reason` is an error's name, never its message. */
  | { outcome: "unreadable"; mimeType: string; reason: string };

/** The job a converter is handed: the bytes, and the name they came under (CSV has no magic). */
export type ConversionJob = { name: string; bytes: Uint8Array };

/**
 * Detect, then read. Imported lazily so the converter's long-lived daemon, which never parses, does
 * not carry three parsers it will not run.
 */
export async function convertUpload(job: ConversionJob): Promise<Conversion> {
  const { detectAttachmentType } = await import("./files");
  const type = await detectAttachmentType(job.bytes, job.name);
  if (!type) return { outcome: "unsupported" };
  if (type.kind === "image") {
    return { outcome: "image", mimeType: type.mimeType };
  }
  try {
    const { readPdf, readSheets } = await import("./extract");
    const extracted =
      type.kind === "sheet"
        ? readSheets(job.bytes, type.mimeType)
        : await readPdf(job.bytes);
    return { outcome: "read", mimeType: type.mimeType, extracted };
  } catch (error) {
    return {
      outcome: "unreadable",
      mimeType: type.mimeType,
      reason: error instanceof Error ? error.name.slice(0, 64) : "unknown",
    };
  }
}

/*
 * The most an honest reading produces. `readSheets` adds a label per sheet (eight sheets, a quoted
 * name each) to at most SUMMARY_CHARS of rows, and `readPdf` cuts at SUMMARY_CHARS exactly; the
 * whole is cut to WHOLE_BYTES and then given one line saying so. Anything longer did not come from
 * the code above.
 */
const BODY_LIMIT = SUMMARY_CHARS * 2;
const WHOLE_LIMIT = WHOLE_BYTES + 1_024;
const SHOWN_LIMIT = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedString = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit;

/** A type this product accepts, and of the kind the outcome claims. */
const acceptedType = (value: unknown, image: boolean): value is string =>
  typeof value === "string" &&
  Object.hasOwn(ATTACHMENT_TYPES, value) &&
  (ATTACHMENT_TYPES[value]?.kind === "image") === image;

function extractedFrom(value: unknown): Extracted | null {
  if (!isRecord(value)) return null;
  const { body, shown, whole } = value;
  if (!boundedString(body, BODY_LIMIT)) return null;
  if (shown !== undefined && !boundedString(shown, SHOWN_LIMIT)) return null;
  if (whole !== null && !boundedString(whole, WHOLE_LIMIT)) return null;
  if (whole !== null && Buffer.byteLength(whole, "utf8") > WHOLE_LIMIT) {
    return null;
  }
  return { body, whole, ...(shown !== undefined ? { shown } : {}) };
}

/**
 * A converter's answer, read as untrusted. Null for anything an honest converter would not say —
 * which the caller treats like a converter that crashed.
 */
export function conversionFrom(value: unknown): Conversion | null {
  if (!isRecord(value)) return null;
  switch (value.outcome) {
    case "unsupported":
      return { outcome: "unsupported" };
    case "image":
      return acceptedType(value.mimeType, true)
        ? { outcome: "image", mimeType: value.mimeType }
        : null;
    case "read": {
      if (!acceptedType(value.mimeType, false)) return null;
      const extracted = extractedFrom(value.extracted);
      return extracted
        ? { outcome: "read", mimeType: value.mimeType, extracted }
        : null;
    }
    case "unreadable":
      return acceptedType(value.mimeType, false) &&
        boundedString(value.reason, 64)
        ? {
            outcome: "unreadable",
            mimeType: value.mimeType,
            reason: value.reason,
          }
        : null;
    default:
      return null;
  }
}
