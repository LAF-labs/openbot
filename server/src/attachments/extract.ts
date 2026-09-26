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
import { getDocumentProxy } from "unpdf";
import * as XLSX from "xlsx";

/** The most characters of a file that ride in the conversation. The whole is on the computer. */
export const SUMMARY_CHARS = 8_000;

/** Rows read per sheet. Past this a sheet is a database, and the summary says so. */
const SHEET_ROWS = 20_000;

/** Sheets read. A workbook of forty tabs is summarised by its first few. */
const SHEETS = 8;

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
      : XLSX.read(bytes, { ...options, type: "array" });

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
