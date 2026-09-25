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
import { extractText, getDocumentProxy } from "unpdf";
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

export async function readPdf(bytes: Uint8Array): Promise<Extracted> {
  // A copy: pdf.js takes ownership of the buffer it is given and detaches it.
  const document = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(document, {
    mergePages: false,
  });
  const pages = text.slice(0, PDF_PAGES).map((page) => page.trim());
  const withText = pages.filter((page) => page.length > 0);
  if (withText.length === 0) return { body: "", whole: null };

  const whole = pages
    .map((page, index) => `--- ${index + 1}쪽 ---\n${page}`)
    .join("\n\n");
  const cut = whole.length > SUMMARY_CHARS || totalPages > PDF_PAGES;
  return {
    body: whole.length > SUMMARY_CHARS ? whole.slice(0, SUMMARY_CHARS) : whole,
    ...(cut ? { shown: `${totalPages}쪽 중 앞부분` } : {}),
    whole: cutToBytes(whole, WHOLE_BYTES),
  };
}
