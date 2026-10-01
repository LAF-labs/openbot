/**
 * 기상청's "동네예보 지점 좌표(위경도)" spreadsheet, to the table the weather tool looks names up in.
 *
 *   bun server/scripts/kma-places-table.ts "<path>/동네예보지점좌표(위경도)_YYMMDD.xlsx"
 *   bun server/scripts/kma-places-table.ts "<path>/….xlsx" --dry-run     (report only, write nothing)
 *
 * It rewrites `server/src/plugins/kma-places-table.ts` whole, and reports what it read: how many
 * rows, under which 시·도, and how many of 기상청's own (coordinate, cell) pairs this repository's
 * projection agrees with — which is the strongest check `kma-grid.ts` can be given, since every row
 * of the spreadsheet is a pair 기상청 worked out itself.
 *
 * THE SPREADSHEET IS NOT FETCHED HERE AND NOT COMMITTED. It is published on apihub.kma.go.kr
 * (예특보 → 4. 동네예보 조회 → "동네예보 지점 좌표(위경도)" 참고자료). Bringing a file onto somebody's
 * machine is theirs to decide, so this takes a path. What is committed is the output: the three
 * names and the two grid numbers of each row, and none of the other columns.
 *
 * THE COLUMNS ARE FOUND BY THEIR HEADINGS, NOT BY POSITION. This was written before the file was
 * on this machine, from the layout the same table has on the public data portal — 구분, 행정구역코드,
 * 1단계, 2단계, 3단계, 격자 X, 격자 Y, then the coordinates — and 기상청 re-issues it (the name
 * carries its date). A generator that read "column F" would go on writing a table, of the wrong
 * numbers, the day a column moved. A heading that cannot be found stops the run and prints the
 * headings that were there, and the report says what was read so a person can look at it.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as XLSX from "xlsx";
import { isKmaCell, kmaCellOf } from "../src/plugins/kma-grid";
import { createKmaPlaces, parseKmaPlaces } from "../src/plugins/kma-places";

export type SheetPlace = {
  levels: [string, string, string];
  nx: number;
  ny: number;
  /** Decimal degrees, when the sheet carries them. Used to check the projection, never written. */
  latitude: number | null;
  longitude: number | null;
};

export type SheetReading = {
  places: SheetPlace[];
  /** The heading row as found, for the report. */
  headings: string[];
  /** Rows under the heading that were not a place: blank, or a cell outside the grid. */
  skipped: number;
};

const text = (cell: unknown) =>
  cell === null || cell === undefined ? "" : String(cell).trim();

/** The first column whose heading matches, or -1. */
const columnOf = (headings: readonly string[], pattern: RegExp) =>
  headings.findIndex((heading) => pattern.test(heading));

/**
 * A degree column, told from the degree-minute-second ones beside it by what is IN it.
 *
 * The portal's edition splits each coordinate into 시·분·초 and then gives it once more as a
 * decimal, under the heading "경도(초/100)" — which does not say "degrees" and may not be the
 * heading next time. So the decimal column is the one under a 경도/위도 heading that holds a number
 * in range for Korea which is not whole.
 */
function degreeColumn(
  headings: readonly string[],
  rows: readonly (readonly unknown[])[],
  word: string,
  range: readonly [number, number],
): number {
  const sample = rows.slice(0, 20);
  return headings.findIndex(
    (heading, column) =>
      heading.includes(word) &&
      sample.some((row) => {
        const value = Number(row[column]);
        return (
          Number.isFinite(value) &&
          !Number.isInteger(value) &&
          value >= range[0] &&
          value <= range[1]
        );
      }),
  );
}

/** One worksheet, as rows of cells, to the places in it. Throws when it is not that worksheet. */
export function placesFromSheet(
  matrix: readonly (readonly unknown[])[],
): SheetReading {
  const at = matrix.findIndex((row) => {
    const cells = row.map(text);
    return (
      cells.some((cell) => /1\s*단계/.test(cell)) &&
      cells.some((cell) => /격자\s*X/i.test(cell))
    );
  });
  if (at < 0) {
    throw new Error(
      `No heading row with "1단계" and "격자 X" in it. The first rows were:\n${matrix
        .slice(0, 5)
        .map((row) => `  ${row.map(text).join(" | ")}`)
        .join("\n")}`,
    );
  }
  const headings = (matrix[at] ?? []).map(text);
  const body = matrix.slice(at + 1);
  const columns = {
    first: columnOf(headings, /1\s*단계/),
    second: columnOf(headings, /2\s*단계/),
    third: columnOf(headings, /3\s*단계/),
    nx: columnOf(headings, /격자\s*X/i),
    ny: columnOf(headings, /격자\s*Y/i),
  };
  const missing = Object.entries(columns).filter(([, column]) => column < 0);
  if (missing.length > 0) {
    throw new Error(
      `The heading row has no column for ${missing.map(([name]) => name).join(", ")}. It reads: ${headings.join(" | ")}`,
    );
  }
  const longitude = degreeColumn(headings, body, "경도", [120, 135]);
  const latitude = degreeColumn(headings, body, "위도", [30, 45]);

  const places: SheetPlace[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const row of body) {
    const levels: [string, string, string] = [
      text(row[columns.first]),
      text(row[columns.second]),
      text(row[columns.third]),
    ];
    const nx = Number(row[columns.nx]);
    const ny = Number(row[columns.ny]);
    if (!levels[0] || !isKmaCell(nx, ny)) {
      if (row.some((cell) => text(cell) !== "")) skipped++;
      continue;
    }
    const key = `${levels.join("|")}|${nx}|${ny}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const degrees = (column: number) => {
      const value = column < 0 ? Number.NaN : Number(row[column]);
      return Number.isFinite(value) ? value : null;
    };
    places.push({
      levels,
      nx,
      ny,
      latitude: degrees(latitude),
      longitude: degrees(longitude),
    });
  }
  return { places, headings, skipped };
}

/** The worksheet of a workbook that holds the table: the first one `placesFromSheet` accepts. */
export function placesFromWorkbook(bytes: Uint8Array): SheetReading {
  const workbook = XLSX.read(bytes, { type: "array" });
  let refusal: unknown = new Error("The workbook has no worksheets.");
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    try {
      return placesFromSheet(
        XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" }),
      );
    } catch (error) {
      refusal = error;
    }
  }
  throw refusal;
}

/** The characters that would end a row, a cell or the literal the rows are written into. */
const UNWRITABLE = /[|`\\\n\r]|\$\{/;

/** The module, as text: a heading comment, the source's name, and one row per line. */
export function tableModule(
  places: readonly SheetPlace[],
  source: { name: string; sha256: string },
): string {
  for (const place of places) {
    const bad = place.levels.find((name) => UNWRITABLE.test(name));
    if (bad !== undefined) {
      throw new Error(`A name cannot be written into the table: ${bad}`);
    }
  }
  const lines = places.map(
    (place) => `${place.levels.join("|")}|${place.nx}|${place.ny}`,
  );
  return `/**
 * 기상청's table of 시·도, 시·군·구 and 읍·면·동 with the forecast cell each one sits in.
 *
 * GENERATED by \`server/scripts/kma-places-table.ts\`. Do not edit it by hand; run that again.
 *
 *   source  ${source.name}
 *   sha256  ${source.sha256}
 *   rows    ${lines.length}, each \`시도|시군구|읍면동|nx|ny\` — nothing else of the spreadsheet is kept
 *
 * One string and not an array of rows, because a formatter leaves a string alone: the file stays
 * one row a line whatever the line width is set to.
 */

/** The spreadsheet these rows were read from, or null while there are none. */
export const KMA_PLACES_SOURCE: string | null = ${JSON.stringify(source.name)};

export const KMA_PLACES_TABLE = \`
${lines.join("\n")}
\`;
`;
}

/** How many of the sheet's own (coordinate, cell) pairs the projection in `kma-grid.ts` gives. */
export function projectionAgreement(places: readonly SheetPlace[]): {
  checked: number;
  agreed: number;
  examples: string[];
} {
  let checked = 0;
  let agreed = 0;
  const examples: string[] = [];
  for (const place of places) {
    if (place.latitude === null || place.longitude === null) continue;
    checked++;
    const cell = kmaCellOf(place.latitude, place.longitude);
    if (cell?.nx === place.nx && cell.ny === place.ny) {
      agreed++;
    } else if (examples.length < 10) {
      examples.push(
        `${place.levels.filter(Boolean).join(" ")}: sheet ${place.nx},${place.ny} — projection ${cell ? `${cell.nx},${cell.ny}` : "outside the grid"}`,
      );
    }
  }
  return { checked, agreed, examples };
}

if (import.meta.main) {
  const [path, ...flags] = process.argv.slice(2);
  if (!path) {
    console.error(
      'Usage: bun server/scripts/kma-places-table.ts "<path to 동네예보지점좌표(위경도)_YYMMDD.xlsx>" [--dry-run]',
    );
    process.exit(2);
  }
  const bytes = readFileSync(path);
  const reading = placesFromWorkbook(bytes);
  const source = {
    name: basename(path),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const module = tableModule(reading.places, source);
  // Read back through the reader the tool uses: a row that does not survive the trip is not a row.
  const survived = parseKmaPlaces(
    reading.places
      .map((place) => `${place.levels.join("|")}|${place.nx}|${place.ny}`)
      .join("\n"),
  ).length;

  const bySido = new Map<string, number>();
  for (const place of reading.places) {
    bySido.set(place.levels[0], (bySido.get(place.levels[0]) ?? 0) + 1);
  }
  const agreement = projectionAgreement(reading.places);
  console.log(`source    ${source.name} (${bytes.length} bytes)`);
  console.log(`sha256    ${source.sha256}`);
  console.log(`headings  ${reading.headings.join(" | ")}`);
  console.log(
    `rows      ${reading.places.length} places, ${reading.skipped} lines skipped, ${survived} read back`,
  );
  console.log(
    `시·도     ${[...bySido].map(([name, count]) => `${name} ${count}`).join(", ")}`,
  );
  console.log(
    agreement.checked === 0
      ? "projection  no decimal coordinate columns were found, so nothing was checked"
      : `projection  ${agreement.agreed} of ${agreement.checked} rows land in the cell the sheet gives`,
  );
  for (const example of agreement.examples) {
    console.log(`            ${example}`);
  }
  // What a few names people actually say come to, through the lookup the tool uses.
  const lookup = createKmaPlaces(
    parseKmaPlaces(
      reading.places
        .map((place) => `${place.levels.join("|")}|${place.nx}|${place.ny}`)
        .join("\n"),
    ),
  );
  for (const said of [
    "서울 종로구",
    "부산 해운대구",
    "춘천",
    "수원",
    "분당",
    "제주",
    "중구",
    "고성",
  ]) {
    const answer = lookup.find(said);
    console.log(
      `lookup    ${said} → ${
        answer.kind === "found"
          ? `${answer.name} (${answer.cell.nx}, ${answer.cell.ny})`
          : answer.kind === "ambiguous"
            ? `several: ${answer.candidates.join(", ")}`
            : "not found"
      }`,
    );
  }

  if (survived !== reading.places.length) {
    console.error("Some rows did not read back. Nothing was written.");
    process.exit(1);
  }
  if (flags.includes("--dry-run")) {
    console.log("dry run: nothing written");
  } else {
    const target = join(import.meta.dir, "../src/plugins/kma-places-table.ts");
    writeFileSync(target, module);
    /*
     * Through the repository's formatter, so the gate's `format:check` passes on what was written:
     * whether the source line fits on one line depends on the file's name, and that is the
     * formatter's call, not a template's.
     */
    const formatted = Bun.spawnSync(
      [
        join(import.meta.dir, "../../node_modules/.bin/biome"),
        "format",
        "--write",
        target,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    console.log(
      `written   ${target} (${module.length} characters)${formatted.exitCode === 0 ? "" : " — the formatter did not run: bunx biome format --write it before committing"}`,
    );
  }
}
