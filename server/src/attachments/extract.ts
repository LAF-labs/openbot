/**
 * What the model reads for a sheet or a PDF, and what the Bot's computer keeps of it.
 *
 * Two readings of one file: a SUMMARY that rides in the conversation (bounded, because it is resent
 * on every turn), and the READABLE WHOLE that goes to the Bot's computer as text, where
 * `computer_read_file` reads it in ranges — the tool the Bot already has, so no tool is added.
 *
 * Adopted, not written: SheetJS (Apache-2.0) reads xlsx, xls and CSV, and unpdf (MIT, pdf.js) reads
 * PDF text. Both parse untrusted input, so both are asked for text only — no formulas evaluated, no
 * HTML, no scripts — and bounded in rows and pages.
 */
import { crc32, inflateRawSync } from "node:zlib";
import { getDocumentProxy } from "unpdf";
import * as XLSX from "xlsx";

/** The most characters of a file that ride in the conversation. The whole is on the computer. */
export const SUMMARY_CHARS = 8_000;

/** Rows read per sheet. Past this a sheet is a database, and the summary says so. */
const SHEET_ROWS = 20_000;

/** Sheets read. A workbook of forty tabs is summarised by its first few. */
const SHEETS = 8;

/**
 * The most a workbook's parts may inflate to, all together, before SheetJS is handed any of it.
 *
 * `sheetRows` bounds nothing here: SheetJS inflates a part whole before it reads a row, and a 997 KB
 * .xlsx whose sheet inflated to 1 GB took 4.6 s and 2 GB inside `XLSX.read` (22 s and 2.2 GB here).
 * What SheetJS then holds is ten to fourteen times the XML it parses (50 MB of Korean text measured
 * at +510 MB and 2.3 s), on a VM of 3 GB it shares with the Bot's browser and Postgres. 32 MiB keeps
 * that under half a gigabyte and two seconds, and still takes a sheet of 20,000 rows and thirty
 * columns (26 MB: +360 MB, 1.3 s), as many rows as are read of any sheet.
 *
 * A ratio test would refuse a harmless 2 MB part of repeated cells and pass a 200 MB one of varied
 * text; it is the inflated size that costs, so that is what is bounded.
 */
const WORKBOOK_BYTES = 32 * 1024 * 1024;

/** Parts in a workbook: one per sheet, drawing and picture, and a handful more. No real one nears it. */
const WORKBOOK_PARTS = 5_000;

/** Pages read. */
const PDF_PAGES = 60;

/**
 * The most the readable whole may be: under the computer's write limit (1,000,000 bytes,
 * `agent-computer/src/workspace.ts`), with room for the line that says it was cut.
 */
const WHOLE_BYTES = 900_000;

/**
 * Characters of a PDF's text read, all pages together. The whole is cut at `WHOLE_BYTES` and a
 * character is at least a byte, so nothing past this survives — and one page can hold any amount:
 * a 0.76 MB file whose page inflated to 100 MB of text took 20 s and 1.5 GB to read in full.
 *
 * Not bounded by this, measured: pdf.js inflates a page's content stream whole before it reads it
 * (300 MB of text in a 2.3 MB file still costs 1.9 s and 690 MB with this bound), and a page of
 * drawing with no text is then walked in microtasks that no timer here can interrupt (400 MB of
 * paths: 8 s with the event loop held, 1.3 GB). Those need the reading in a worker that can be killed.
 */
const PDF_CHARS = WHOLE_BYTES;

export type Extracted = {
  /** What the model reads, already bounded. */
  body: string;
  /** Said when `body` is not everything ("앞 40행"), for the line that points at the whole. */
  shown?: string;
  /** The readable whole, for the computer. Null when there is nothing worth keeping. */
  whole: string | null;
};

/**
 * Text as a Korean spreadsheet program writes it: UTF-8, or else the code page Excel still saves a
 * CSV in (CP949, which `euc-kr` decodes). Tried in that order because UTF-8 is strict enough that a
 * CP949 file almost never passes it by accident.
 */
function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

function cutToBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const cut = Buffer.from(text, "utf8").subarray(0, limit).toString("utf8");
  // Back to the last whole line, and never a half character (`toString` replaced it with U+FFFD).
  const end = cut.lastIndexOf("\n");
  return `${end > 0 ? cut.slice(0, end) : cut.replace(/�$/, "")}\n(… 파일이 커서 여기까지만 옮겼다)`;
}

/** Why a workbook was refused before it was parsed. Only the name reaches the log. */
class WorkbookRefused extends Error {
  override name = "WorkbookRefused";
}

/** What SheetJS opens as a zip. It goes by the first bytes, not by the detected type, and so does this. */
function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

type Part = { name: Uint8Array; flags: number; data: Uint8Array };

/**
 * The workbook rewritten with every part stored, none compressed, once each part has been inflated
 * here within `WORKBOOK_BYTES`.
 *
 * Inflated, because the sizes a zip declares can lie and SheetJS believes the local header's. Told a
 * 1.4 MB part inflates to 1,000 bytes, it allocates that and still decodes the whole gigabyte in
 * pure JavaScript (5.5 s); told zero, as a data descriptor allows, it grows its buffer to fit
 * (10 s, 3.9 GB). Node's inflate stops at `maxOutputLength`, so here a lie costs at most the size it
 * told, and the declared sizes are summed first so an honest bomb costs nothing at all.
 *
 * Rewritten, so that SheetJS reads only what was inflated here. Whatever it would have made of the
 * original headers — which directory, which offsets — it never sees them.
 */
function boundedWorkbook(bytes: Uint8Array): Buffer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => {
    if (at < 0 || at + 2 > bytes.length) throw new WorkbookRefused("short");
    return view.getUint16(at, true);
  };
  const u32 = (at: number) => {
    if (at < 0 || at + 4 > bytes.length) throw new WorkbookRefused("short");
    return view.getUint32(at, true);
  };

  // The end record is in the last 22 bytes plus at most a 64 KB comment.
  let end = bytes.length - 22;
  const floor = Math.max(0, end - 0xffff);
  while (end >= floor && u32(end) !== 0x06054b50) end -= 1;
  if (end < floor) throw new WorkbookRefused("no end record");
  const count = u16(end + 10);
  if (count > WORKBOOK_PARTS) throw new WorkbookRefused("too many parts");

  const entries: Array<
    Part & { method: number; packed: number; size: number; at: number }
  > = [];
  let declared = 0;
  for (let i = 0, at = u32(end + 16); i < count; i += 1) {
    if (u32(at) !== 0x02014b50) throw new WorkbookRefused("bad directory");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const size = u32(at + 24);
    const nameLength = u16(at + 28);
    declared += size;
    // One sum covers both the total and any single part; ZIP64's 0xFFFFFFFF lands here too.
    if (declared > WORKBOOK_BYTES) throw new WorkbookRefused("too large");
    if (flags & 0x1) throw new WorkbookRefused("encrypted");
    if (method !== 0 && method !== 8) throw new WorkbookRefused("method");
    entries.push({
      name: bytes.slice(at + 46, at + 46 + nameLength),
      // Only "the name is UTF-8" survives; nothing else in the flags describes the stored copy.
      flags: flags & 0x800,
      data: new Uint8Array(0),
      method,
      packed: u32(at + 20),
      size,
      at: u32(at + 42),
    });
    at += 46 + nameLength + u16(at + 30) + u16(at + 32);
  }

  for (const entry of entries) {
    if (u32(entry.at) !== 0x04034b50) throw new WorkbookRefused("bad part");
    const start = entry.at + 30 + u16(entry.at + 26) + u16(entry.at + 28);
    const packed = bytes.subarray(start, start + entry.packed);
    if (entry.method === 8) {
      try {
        entry.data = inflateRawSync(packed, {
          maxOutputLength: Math.max(1, entry.size),
        });
      } catch {
        throw new WorkbookRefused("does not inflate to what it declared");
      }
    } else {
      entry.data = packed;
    }
    if (entry.data.length !== entry.size)
      throw new WorkbookRefused("size lies");
  }
  return storedZip(entries);
}

/**
 * A zip of these parts, each stored as is: what SheetJS reads without inflating anything.
 *
 * A Buffer, not a bare Uint8Array: SheetJS turns a Buffer's part into text with `toString`, and
 * anything else through a latin1 decode and a replace over the whole string — measured at 150 MB
 * more for a 26 MB sheet.
 */
function storedZip(parts: Part[]): Buffer {
  const out = Buffer.alloc(
    parts.reduce(
      (sum, part) => sum + 76 + 2 * part.name.length + part.data.length,
      22,
    ),
  );
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const offsets: number[] = [];
  const checks = parts.map((part) => crc32(part.data));
  let at = 0;
  parts.forEach((part, i) => {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, part.flags, true);
    view.setUint32(at + 14, checks[i] ?? 0, true);
    view.setUint32(at + 18, part.data.length, true);
    view.setUint32(at + 22, part.data.length, true);
    view.setUint16(at + 26, part.name.length, true);
    out.set(part.name, at + 30);
    out.set(part.data, at + 30 + part.name.length);
    at += 30 + part.name.length + part.data.length;
  });
  const directory = at;
  parts.forEach((part, i) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, part.flags, true);
    view.setUint32(at + 16, checks[i] ?? 0, true);
    view.setUint32(at + 20, part.data.length, true);
    view.setUint32(at + 24, part.data.length, true);
    view.setUint16(at + 28, part.name.length, true);
    view.setUint32(at + 42, offsets[i] ?? 0, true);
    out.set(part.name, at + 46);
    at += 46 + part.name.length;
  });
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, parts.length, true);
  view.setUint16(at + 10, parts.length, true);
  view.setUint32(at + 12, at - directory, true);
  view.setUint32(at + 16, directory, true);
  return out;
}

export function readSheets(bytes: Uint8Array, mimeType: string): Extracted {
  const options = {
    cellFormula: false,
    cellHTML: false,
    cellText: true,
    sheetRows: SHEET_ROWS,
    dense: true,
  } as const;
  const workbook =
    mimeType === "text/csv"
      ? XLSX.read(decodeText(bytes), { ...options, type: "string" })
      : XLSX.read(isZip(bytes) ? boundedWorkbook(bytes) : bytes, {
          ...options,
          type: "array",
        });

  const names = workbook.SheetNames.slice(0, SHEETS);
  const wholeParts: string[] = [];
  const summaryParts: string[] = [];
  let budget = SUMMARY_CHARS;
  let cut = false;

  for (const name of names) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils
      .sheet_to_csv(sheet, { blankrows: false, strip: true })
      .trim();
    const lines = csv ? csv.split("\n") : [];
    const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null;
    const columns = range ? range.e.c - range.s.c + 1 : 0;
    const label =
      names.length > 1 || mimeType !== "text/csv"
        ? `시트 "${name}" — ${lines.length}행 ${columns}열`
        : `${lines.length}행 ${columns}열`;
    wholeParts.push(names.length > 1 ? `# 시트: ${name}\n${csv}` : csv);

    const kept: string[] = [];
    for (const line of lines) {
      if (line.length + 1 > budget) break;
      kept.push(line);
      budget -= line.length + 1;
    }
    if (kept.length < lines.length) cut = true;
    summaryParts.push(
      kept.length < lines.length
        ? `${label} (앞 ${kept.length}행만)\n${kept.join("\n")}`
        : `${label}\n${kept.join("\n")}`,
    );
    budget -= label.length + 1;
    if (budget <= 0) break;
  }
  if (workbook.SheetNames.length > names.length) cut = true;

  const whole = wholeParts.join("\n\n").trim();
  return {
    body: summaryParts.join("\n\n").trim(),
    ...(cut ? { shown: "파일의 앞부분" } : {}),
    whole: whole ? cutToBytes(whole, WHOLE_BYTES) : null,
  };
}

type PdfPage = Awaited<
  ReturnType<Awaited<ReturnType<typeof getDocumentProxy>>["getPage"]>
>;

/**
 * One page's text, as unpdf's `extractText` joins it, read as a stream so that it can stop at
 * `budget` characters instead of collecting everything the page holds first.
 */
async function pageText(
  page: PdfPage,
  budget: number,
): Promise<{ text: string; full: boolean }> {
  const reader = page.streamTextContent().getReader();
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return { text, full: false };
      const chunk = next.value as {
        items: Array<{ str?: string; hasEOL?: boolean }>;
      };
      for (const item of chunk.items) {
        if (item.str != null) text += item.str + (item.hasEOL ? "\n" : "");
      }
      if (text.length >= budget)
        return { text: text.slice(0, budget), full: true };
    }
  } finally {
    // With a reason, and an Error: pdf.js asserts one, and without it the cancel never marks the
    // stream closed — every chunk still arriving then throws "Controller is already closed".
    reader.cancel(new Error("read enough")).catch(() => {});
  }
}

export async function readPdf(bytes: Uint8Array): Promise<Extracted> {
  // A copy: pdf.js takes ownership of the buffer it is given and detaches it.
  const document = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const totalPages = document.numPages;
    // Only the pages that are read are opened. unpdf's `extractText` read every page and the slice
    // came after: 5,000 pages sharing one content stream, 0.47 MB, took 11 s and 830 MB here.
    const pages: string[] = [];
    let budget = PDF_CHARS;
    let full = false;
    for (
      let number = 1;
      number <= Math.min(totalPages, PDF_PAGES) && !full;
      number += 1
    ) {
      const page = await pageText(await document.getPage(number), budget);
      pages.push(page.text.trim());
      budget -= page.text.length;
      full = page.full;
    }
    const withText = pages.filter((page) => page.length > 0);
    if (withText.length === 0) return { body: "", whole: null };

    const whole = pages
      .map((page, index) => `--- ${index + 1}쪽 ---\n${page}`)
      .join("\n\n");
    const cut =
      whole.length > SUMMARY_CHARS || totalPages > pages.length || full;
    return {
      body:
        whole.length > SUMMARY_CHARS ? whole.slice(0, SUMMARY_CHARS) : whole,
      ...(cut ? { shown: `${totalPages}쪽 중 앞부분` } : {}),
      whole: cutToBytes(whole, WHOLE_BYTES),
    };
  } finally {
    // Also what stops a page still being read: destroying the document terminates its worker task.
    // `extractText` never destroys a document it is handed, so each one used to stay in memory.
    await document.loadingTask.destroy();
  }
}
