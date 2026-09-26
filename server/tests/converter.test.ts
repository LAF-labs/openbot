import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { conversionFrom, convertUpload } from "../src/attachments/conversion";
import {
  converterSettingFor,
  createConverter,
} from "../src/attachments/converter-client";
import {
  isolationProblems,
  startConverterDaemon,
} from "../src/attachments/converter-daemon";
import {
  convertInFreshProcess,
  jobCommandFor,
} from "../src/attachments/converter-process";
import { readPdf, readSheets } from "../src/attachments/extract";

/**
 * THE CONVERTER: every uploaded byte read in a fresh child, bounded from outside, answered as a
 * stranger's JSON — and never in the server's own process (security package item 11).
 *
 * The isolation itself (uid 65534, no network, read-only root, no capabilities) is compose's to give
 * and the daemon's `--require-isolation` to check; `isolationProblems` is that check, driven here
 * with the facts a container would report.
 */

const ENTRY = `${import.meta.dir}/../src/converter.ts`;
const COMMAND = jobCommandFor(ENTRY);

function pdfWith(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

function workbook(rows: (string | number)[][]): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "매출");
  return new Uint8Array(
    XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
  );
}

/** "날짜,메뉴,금액" and two rows, in the code page Excel still saves a Korean CSV in. */
const CP949_CSV = new Uint8Array([
  0xb3, 0xaf, 0xc2, 0xa5, 0x2c, 0xb8, 0xde, 0xb4, 0xba, 0x2c, 0xb1, 0xdd, 0xbe,
  0xd7, 0x0a, 0x39, 0x2f, 0x32, 0x36, 0x2c, 0x41, 0x2c, 0x34, 0x35, 0x30, 0x30,
  0x0a, 0x39, 0x2f, 0x32, 0x37, 0x2c, 0x42, 0x2c, 0x35, 0x30, 0x30, 0x30, 0x0a,
]);

describe("a file read in a fresh child", () => {
  test("reads a workbook, a CP949 CSV and a PDF exactly as the parsers do in-process", async () => {
    const rows = Array.from({ length: 50 }, (_row, index) => [
      `2026-09-${String((index % 28) + 1).padStart(2, "0")}`,
      `메뉴${index}`,
      4500 + index,
    ]);
    const book = workbook([["날짜", "메뉴", "금액"], ...rows]);
    const pdf = pdfWith("Americano 4500 won");

    const cases: [string, Uint8Array, () => Promise<unknown>][] = [
      [
        "매출.xlsx",
        book,
        async () =>
          readSheets(
            book,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ),
      ],
      ["매출.csv", CP949_CSV, async () => readSheets(CP949_CSV, "text/csv")],
      ["영수증.pdf", pdf, () => readPdf(pdf)],
    ];
    for (const [name, bytes, inProcess] of cases) {
      const outcome = await convertInFreshProcess(
        { name, bytes },
        { command: COMMAND },
      );
      expect({ name, ok: outcome.ok, outcome }).toMatchObject({
        name,
        ok: true,
      });
      if (!outcome.ok || outcome.conversion.outcome !== "read") {
        throw new Error(`${name} was not read`);
      }
      expect(outcome.conversion.extracted).toEqual(
        (await inProcess()) as never,
      );
    }
  });

  test("a photo is only named, and something else is refused", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
      0x44, 0x52,
    ]);
    expect(await convertUpload({ name: "a.png", bytes: png })).toEqual({
      outcome: "image",
      mimeType: "image/png",
    });
    expect(
      await convertUpload({
        name: "run.exe",
        bytes: new TextEncoder().encode("MZ not a spreadsheet"),
      }),
    ).toEqual({ outcome: "unsupported" });
  });

  test("a child that hangs is killed at its bound, and says so", async () => {
    const started = performance.now();
    const outcome = await convertInFreshProcess(
      { name: "x.csv", bytes: new Uint8Array([1]) },
      {
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        limits: { timeoutMs: 500, memoryBytes: 512 * 1024 * 1024 },
      },
    );
    expect(outcome).toEqual({ ok: false, failure: "timeout" });
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test("a child that grows past its bound is killed", async () => {
    const outcome = await convertInFreshProcess(
      { name: "x.csv", bytes: new Uint8Array([1]) },
      {
        command: [
          process.execPath,
          "-e",
          "const keep = []; setInterval(() => keep.push(Buffer.alloc(32 * 1024 * 1024, 1)), 20)",
        ],
        limits: { timeoutMs: 15_000, memoryBytes: 128 * 1024 * 1024 },
      },
    );
    expect(outcome).toEqual({ ok: false, failure: "memory" });
  });
});

describe("what comes back is a stranger's JSON", () => {
  test("an answer no honest reading produces is refused", () => {
    expect(
      conversionFrom({ outcome: "image", mimeType: "text/html" }),
    ).toBeNull();
    expect(
      conversionFrom({
        outcome: "read",
        mimeType: "application/pdf",
        extracted: { body: "x".repeat(20_000), whole: null },
      }),
    ).toBeNull();
    expect(
      conversionFrom({ outcome: "read", mimeType: "image/png", extracted: {} }),
    ).toBeNull();
    expect(conversionFrom("{}")).toBeNull();
  });
});

describe("where a deployment reads files", () => {
  test("production without the sidecar refuses every file rather than reading it here", async () => {
    const setting = converterSettingFor({
      socketPath: undefined,
      production: true,
    });
    expect(setting).toEqual({ kind: "refused" });
    const converter = createConverter(setting);
    expect(
      await converter.convert({ name: "a.csv", bytes: CP949_CSV }),
    ).toEqual({ ok: false, failure: "unavailable" });
  });

  test("a laptop reads in a local child; the sidecar is used whenever it is named", () => {
    expect(
      converterSettingFor({ socketPath: undefined, production: false }),
    ).toEqual({ kind: "local" });
    expect(
      converterSettingFor({ socketPath: "/run/x.sock", production: true }),
    ).toEqual({ kind: "sidecar", socketPath: "/run/x.sock" });
  });

  const dir = mkdtempSync(join(tmpdir(), "laf-converter-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the sidecar answers over its socket, and a socket that is gone refuses", async () => {
    const socketPath = join(dir, "converter.sock");
    const daemon = startConverterDaemon({
      socketPath,
      jobCommand: COMMAND,
      log: { info: () => {}, warn: () => {}, error: () => {} } as never,
    });
    const converter = createConverter({ kind: "sidecar", socketPath });
    const outcome = await converter.convert({
      name: "매출.csv",
      bytes: CP949_CSV,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.conversion.outcome === "read") {
      expect(outcome.conversion.extracted.body).toContain("메뉴");
    }
    await daemon.stop();
    expect(
      await converter.convert({ name: "매출.csv", bytes: CP949_CSV }),
    ).toEqual({ ok: false, failure: "unavailable" });
  });
});

describe("the daemon's own check of where it runs", () => {
  test("isolated only as compose means it: not root, no network, no capabilities, read-only", () => {
    const isolated = {
      uid: 65534,
      externalInterfaces: [],
      capabilityBounding: "0000000000000000",
      noNewPrivileges: true,
      rootReadOnly: true,
    };
    expect(isolationProblems(isolated)).toEqual([]);
    expect(
      isolationProblems({
        uid: 0,
        externalInterfaces: ["eth0"],
        capabilityBounding: "00000000a80425fb",
        noNewPrivileges: false,
        rootReadOnly: false,
      }),
    ).toEqual([
      "runs_as_root",
      "has_network",
      "holds_capabilities",
      "may_gain_privileges",
      "root_writable",
    ]);
  });
});
