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
 * THE COLUMNS ARE FOUND BY THEIR HEADINGS, NOT BY POSITION. The 2026-07-01 edition's are 구분,
 * 행정구역코드, 1단계, 2단계, 3단계, 격자 X, 격자 Y, each coordinate as 시·분·초 and once more as a
 * decimal, and 위치업데이트 — one worksheet, 3,838 rows, nearly every cell text, the numbers
 * included. 기상청 re-issues the file (the name carries its date), and a generator that read
 * "column F" would go on writing a table, of the wrong numbers, the day a column moved. A heading
 * that cannot be found stops the run and prints the headings that were there.
 *
 * READ THE REPORT BEFORE COMMITTING WHAT IT WROTE. On that edition it says 3,793 of the 3,836 rows
 * that carry a coordinate land in the cell the sheet gives, 36 more are within 500 m of the edge,
 * and 7 are further off (the furthest, 관평동, by 2.4 km: its coordinate was updated in 2014 and
 * its cell was not). A run that says anything very different has read the wrong column — which the
 * first run of this on the real file did.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as XLSX from "xlsx";
import { isKmaCell, kmaGridPosition } from "../src/plugins/kma-grid";
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

/** Where a coordinate in this table can be, with room to spare: the grid runs 123–133°E, 31–44°N. */
const LONGITUDES = [120, 135] as const;
const LATITUDES = [30, 45] as const;

/** The first column whose heading matches, or -1. */
const columnOf = (headings: readonly string[], pattern: RegExp) =>
  headings.findIndex((heading) => pattern.test(heading));

/**
 * A degree column, told from the degree-minute-second ones beside it by what is IN it.
 *
 * The sheet splits each coordinate into 시·분·초 and then gives it once more as plain decimal
 * degrees, under the heading "경도(초/100)" — which says seconds over a hundred and is neither. So
 * the heading is not trusted: the decimal column is the one under a 경도/위도 heading where
 * (nearly) EVERY value is in range for Korea and they are not all whole.
 *
 * "EVERY", NOT "SOME" — AND THAT WAS THE BUG. The first version of this took the first 경도/위도
 * column with some in-range value that was not whole, sampled over twenty rows. For longitude that
 * is the right column: no minute or second is between 120 and 135. For latitude it is not — a
 * SECONDS value is anything from 0 to 60, and the tenth row of the real sheet has 38.11 — so the
 * 위도(초) column was read as latitude, and the first run on the real file reported that 5 of
 * 3,837 rows landed in their own cell. The synthetic sheet this was tested on had 0 in every
 * seconds cell, which is how it passed.
 */
function degreeColumn(
  headings: readonly string[],
  rows: readonly (readonly unknown[])[],
  word: string,
  range: readonly [number, number],
): number {
  return headings.findIndex((heading, column) => {
    if (!heading.includes(word)) return false;
    // Blank and zero are the sheet's two ways of saying "no coordinate" (이어도's rows are zeros).
    const values = rows
      .map((row) => text(row[column]))
      .filter((cell) => cell !== "")
      .map(Number)
      .filter((value) => value !== 0);
    const inRange = values.filter(
      (value) => value >= range[0] && value <= range[1],
    );
    return (
      values.length > 0 &&
      // A stray cell must not unseat the column; a column of seconds is in range a quarter of the time.
      inRange.length >= values.length * 0.99 &&
      inRange.some((value) => !Number.isInteger(value))
    );
  });
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
  const longitude = degreeColumn(headings, body, "경도", LONGITUDES);
  const latitude = degreeColumn(headings, body, "위도", LATITUDES);

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
    /*
     * A cell that is blank, or holds a number that is not a coordinate in Korea, is no coordinate:
     * 이어도's two rows carry 0 and 0, and the projection of the Gulf of Guinea is not a finding.
     */
    const degrees = (column: number, range: readonly [number, number]) => {
      const cell = column < 0 ? "" : text(row[column]);
      const value = cell === "" ? Number.NaN : Number(cell);
      return value >= range[0] && value <= range[1] ? value : null;
    };
    places.push({
      levels,
      nx,
      ny,
      latitude: degrees(latitude, LATITUDES),
      longitude: degrees(longitude, LONGITUDES),
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

/** A cell is five kilometres; a coordinate this far past its edge is a rounding, not a disagreement. */
const EDGE_METRES = 500;

export type ProjectionCheck = {
  /** Rows that carry a coordinate. */
  checked: number;
  /** Of those, the ones the projection puts in the cell the sheet gives. */
  agreed: number;
  /** The ones it puts in a neighbour, with the coordinate within {@link EDGE_METRES} of the edge. */
  atEdge: string[];
  /** The ones whose coordinate is somewhere else altogether. These are what the check is for. */
  apart: string[];
};

/**
 * How many of the sheet's own (coordinate, cell) pairs the projection in `kma-grid.ts` reproduces.
 *
 * Every row is a pair 기상청 worked out itself, so this is the constants held to a few thousand of
 * 기상청's answers instead of to two city halls. A miss is not all one thing: a coordinate a
 * stone's throw over a cell's edge is the two sides rounding differently (or a row whose
 * coordinate was updated and whose cell was not), and a coordinate kilometres away is a wrong
 * constant or a wrong column. They are counted apart, and each is named.
 */
export function projectionAgreement(
  places: readonly SheetPlace[],
): ProjectionCheck {
  const check: ProjectionCheck = {
    checked: 0,
    agreed: 0,
    atEdge: [],
    apart: [],
  };
  for (const place of places) {
    if (place.latitude === null || place.longitude === null) continue;
    check.checked++;
    const name = place.levels.filter(Boolean).join(" ");
    const at = kmaGridPosition(place.latitude, place.longitude);
    if (!at) {
      check.apart.push(`${name}: sheet ${place.nx},${place.ny} — no position`);
      continue;
    }
    const nx = Math.floor(at.x + 0.5);
    const ny = Math.floor(at.y + 0.5);
    if (nx === place.nx && ny === place.ny) {
      check.agreed++;
      continue;
    }
    // How far the coordinate is outside the sheet's own cell: half a cell from the centre is the edge.
    const metres = Math.round(
      (Math.max(Math.abs(at.x - place.nx), Math.abs(at.y - place.ny)) - 0.5) *
        5_000,
    );
    (metres <= EDGE_METRES ? check.atEdge : check.apart).push(
      `${name}: sheet ${place.nx},${place.ny} — projection ${nx},${ny}, ${metres} m past the edge`,
    );
  }
  return check;
}

if (import.meta.main) {
  const [path, ...flags] = process.argv.slice(2);
  if (!path) {
    console.error(
      'Usage: bun server/scripts/kma-places-table.ts "<path to 동네예보지점좌표(위경도)_YYMMDD.xlsx>" [--dry-run] [--source-name "<the name 기상청 gave the file>"]',
    );
    process.exit(2);
  }
  const bytes = readFileSync(path);
  const reading = placesFromWorkbook(bytes);
  /*
   * The header records what 기상청 called the file, which is what somebody looking for it again
   * will search the hub for — not what it happened to be saved as on the machine that ran this.
   */
  const renamed = flags.indexOf("--source-name");
  const source = {
    name: (renamed >= 0 ? flags[renamed + 1] : undefined) ?? basename(path),
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
      : `projection  ${agreement.agreed} of the ${agreement.checked} rows that carry a coordinate land in the cell the sheet gives; ${agreement.atEdge.length} are within ${EDGE_METRES} m of its edge; ${agreement.apart.length} are further off (${reading.places.length - agreement.checked} of ${reading.places.length} rows carry no coordinate)`,
  );
  for (const [label, misses] of [
    ["edge", agreement.atEdge],
    ["APART", agreement.apart],
  ] as const) {
    for (const miss of misses.slice(0, 60)) {
      console.log(`  ${label}  ${miss}`);
    }
    if (misses.length > 60) {
      console.log(`  ${label}  … and ${misses.length - 60} more`);
    }
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
    "제주 서귀포",
    "세종",
    "광주",
    "광주 북구",
    "전남 순천",
    "전라남도",
    "강원도",
    "전라북도",
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
