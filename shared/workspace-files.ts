/**
 * A FILE THE BOT HANDS TO THE PERSON: what the three ends of that path have to agree on (plan
 * phase 8, first slice, 2026-10-02).
 *
 * A Bot could write a file in its folder and nobody could open it. Now a card in the conversation
 * offers it (`showFile`), and a route sends its bytes. Three processes are on that path and each
 * needs the same answers: the computer (how much one download may be), the server (what the file is
 * called on its way out, and whether it may be drawn rather than saved) and the surface (whether to
 * draw a picture, and no button under a file too large to take).
 *
 * WHAT A FILE IS, BY A FIXED TABLE AND NEVER BY THE FILE. A Bot writes whatever bytes it likes
 * under whatever name it likes, and the route that sends them is on the origin that serves the app.
 * So the type a download goes out as is read off its extension from the short list below and
 * nothing else, and a name the list does not know is `application/octet-stream`. HTML and SVG are
 * left out on purpose: saved, they are files; named as what they are, they are documents this
 * origin would be vouching for.
 */

/**
 * The most one download hands over. Five times what a Bot may write in one go (the computer's
 * `writeBytes`), so nothing a Bot can make today is refused — a bound, not a case anybody meets.
 */
export const HANDOFF_MAX_BYTES = 5_000_000;

/**
 * The header a file's path travels in when the body of the request is the file itself (the
 * computer's `/files/put`), percent-encoded: a path in the Bot's folder is Korean more often than
 * not, and a header carries only ASCII. Never in the address — a path there would have to survive
 * whatever normalised the URL first, `..` included.
 */
export const FILE_PATH_HEADER = "x-openbot-file-path";

/** A file's name: the last part of its path. Empty for a path that names nothing. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** The extension a name ends in, lower-cased; none for a dotfile, which is all name. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Whether any part of a path is hidden: `.results/call_1.txt`, `notes/.draft`. What a person is
 * shown of the folder leaves these out — `.results/` is the runtime's own filing
 * (`shared/spillover.ts`), not something the Bot made for anybody.
 */
export function isHiddenPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part.startsWith("."));
}

/** The four pictures a browser draws from bytes alone, with nothing in them that runs. */
const RASTER_IMAGES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ...RASTER_IMAGES,
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

/**
 * A table's OWN entry for a key, or nothing.
 *
 * A NAME SOMEBODY ELSE CHOSE IS NOT A KEY UNTIL THE TABLE SAYS SO. `TABLE[key]` answers for
 * `constructor` with what every object has under that name — a function — and a file's extension
 * is whatever its author typed. Until 2026-10-06 `report.constructor` was served as content type
 * "function Object() { [native code] }" and called a picture by its name (found the same evening
 * as the same reading of the prompt's service names; `tests/file-handoff.test.ts`).
 */
const own = <Value>(
  table: Readonly<Record<string, Value>>,
  key: string,
): Value | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** The type a download is sent as, by its name alone. */
export function contentTypeOf(name: string): string {
  return own(CONTENT_TYPES, extensionOf(name)) ?? "application/octet-stream";
}

/**
 * The picture a name says it is, or null. The NAME ONLY: what the surface asks before it draws an
 * `<img>`, having no bytes to look at. Whether the bytes agree is {@link inlineImageTypeOf}, asked
 * by the server that has them.
 */
export function rasterImageTypeOf(name: string): string | null {
  return own(RASTER_IMAGES, extensionOf(name)) ?? null;
}

const startsWith = (bytes: Uint8Array, magic: readonly number[], at = 0) =>
  bytes.byteLength >= at + magic.length &&
  magic.every((byte, index) => bytes[at + index] === byte);

/** What each picture's file starts with. A name is a claim; this is the file agreeing with it. */
const MAGIC: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  "image/png": (bytes) =>
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  // "GIF87a" or "GIF89a".
  "image/gif": (bytes) =>
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61,
  // "RIFF", four bytes of length, "WEBP".
  "image/webp": (bytes) =>
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8),
};

/**
 * The type a file may be DRAWN as on this origin, or null when it may only be saved.
 *
 * BOTH THE NAME AND THE BYTES. The name alone is whatever the Bot typed — `report.png` holding a
 * page of script — and the bytes alone would draw a picture under a name that says spreadsheet. A
 * file is drawn only when it is called one of the four pictures and starts as that same picture
 * does; everything else, a PDF and an SVG included, is a download.
 */
export function inlineImageTypeOf(
  name: string,
  bytes: Uint8Array,
): string | null {
  const claimed = rasterImageTypeOf(name);
  return claimed && own(MAGIC, claimed)?.(bytes) ? claimed : null;
}
