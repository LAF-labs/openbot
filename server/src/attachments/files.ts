/**
 * What an uploaded file really is, and the name it may be kept under.
 *
 * THE BYTES DECIDE, NOT THE NAME AND NOT THE BROWSER. `file-type` reads the magic numbers; a
 * `menu.pdf` that is really a picture is a picture, and an executable renamed `sales.xlsx` is
 * refused. CSV is the one type with no magic number, so it is accepted only when the name says CSV
 * AND the bytes are text.
 */
import { fileTypeFromBuffer } from "file-type";
import {
  ATTACHMENT_TYPES,
  type AttachmentKind,
} from "../../../shared/attachments";

export type DetectedType = {
  mimeType: string;
  kind: AttachmentKind;
  extension: string;
};

/** How much of a CSV is looked at to decide it is text. */
const TEXT_SNIFF_BYTES = 64 * 1024;

/**
 * Text, as a person's spreadsheet program writes a CSV: no NUL bytes, and either UTF-8 or the
 * Korean code page Excel still saves in (CP949/EUC-KR), which is what `sheets.ts` then reads it as.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, TEXT_SNIFF_BYTES);
  return !head.includes(0);
}

export async function detectAttachmentType(
  bytes: Uint8Array,
  claimedName: string,
): Promise<DetectedType | null> {
  const found = await fileTypeFromBuffer(bytes).catch(() => undefined);
  const lowerName = claimedName.toLowerCase();
  let mimeType: string | null = null;
  if (found) {
    if (ATTACHMENT_TYPES[found.mime]) mimeType = found.mime;
    // An old Excel file is a Compound File; so is an old Word file, which is why the name must say so.
    else if (found.mime === "application/x-cfb" && lowerName.endsWith(".xls"))
      mimeType = "application/vnd.ms-excel";
  } else if (
    (lowerName.endsWith(".csv") || lowerName.endsWith(".tsv")) &&
    looksLikeText(bytes)
  ) {
    mimeType = "text/csv";
  }
  if (!mimeType) return null;
  const known = ATTACHMENT_TYPES[mimeType];
  return known ? { mimeType, ...known } : null;
}

/*
 * Characters a name may not keep, beyond the path separators.
 *
 * - C0 and C1 controls, including the NUL that truncates a path in a C library.
 * - Bidirectional overrides and isolates (U+202A–U+202E, U+2066–U+2069): `invoice‮fdp.exe` DRAWS as
 *   `invoiceexe.pdf` — the classic way to make a chip say something the file is not.
 * - Zero-width characters and the BOM, which make two names that look the same different.
 * - What Windows refuses in a file name, so a name that is saved elsewhere later still saves.
 */
const UNSAFE_CHARACTERS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿<>:"|?*]/g;

/** Long enough for any real name, short enough for a chip and every filesystem. */
const NAME_STEM_LENGTH = 80;

/**
 * The name a file is kept and shown under: the person's own, made safe, ending in what it really is.
 *
 * Never a path — only the last segment survives, so `../../etc/passwd` is `passwd`, and even that
 * never reaches a filesystem path unprefixed (`workspacePathFor`).
 */
export function safeAttachmentName(claimed: string, extension: string): string {
  const base = (claimed ?? "").normalize("NFC").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(UNSAFE_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
  const dot = cleaned.lastIndexOf(".");
  const stem = (dot > 0 ? cleaned.slice(0, dot) : cleaned)
    .trim()
    .slice(0, NAME_STEM_LENGTH)
    .trim();
  return `${stem || "첨부"}.${extension}`;
}

/**
 * Where the readable whole of a file goes on the Bot's computer: `uploads/`, a date and a piece of
 * the id first so two receipts called `영수증.jpg` never overwrite each other, then the name.
 */
export function workspacePathFor(
  id: string,
  name: string,
  at: Date,
  readableExtension: "csv" | "txt",
): string {
  const day = at.toISOString().slice(0, 10);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `uploads/${day}-${id.slice(0, 8)}-${stem}.${readableExtension}`;
}
