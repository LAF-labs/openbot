import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import {
  placesFromSheet,
  placesFromWorkbook,
  projectionAgreement,
  tableModule,
} from "../scripts/kma-places-table";
import {
  createKmaPlaces,
  KMA_PLACES,
  parseKmaPlaces,
} from "../src/plugins/kma-places";
import {
  KMA_PLACES_SOURCE,
  KMA_PLACES_TABLE,
} from "../src/plugins/kma-places-table";
import { KMA_WEATHER_TOOLS } from "../src/plugins/kma-weather-rest";

/**
 * A place as somebody says it, to the cell 기상청 files it under.
 *
 * THREE HALVES. The lookup is held to a small table in the shape of 기상청's — the same three
 * names and two numbers a row, the districts of a city run together the way 기상청 writes them
 * (수원시장안구) — so that how a query is read can be pinned without four thousand rows in the way.
 * The generator is held to a worksheet built here in the spreadsheet's layout. And the table this
 * repository SHIPS is held to 기상청's own rows, which it has only once the generator has been run
 * on the spreadsheet: until then that half is skipped, and one test says the tool offers no names.
 *
 * The fixture's cells are this repository's projection of each office's coordinates, or near
 * enough to stand for it. They are there to be found, not to be 기상청's word on where 양평 is.
 */

const FIXTURE = `
서울특별시|||60|127
서울특별시|종로구||60|127
서울특별시|종로구|청운효자동|60|127
서울특별시|종로구|사직동|60|127
서울특별시|중구||60|127
서울특별시|중구|명동|60|127
서울특별시|강남구||61|126
서울특별시|강남구|역삼1동|61|125
서울특별시|강남구|역삼2동|61|125
서울특별시|영등포구||58|126
서울특별시|영등포구|양평1동|58|126
서울특별시|영등포구|여의동|58|126
부산광역시|||98|76
부산광역시|중구||97|74
부산광역시|해운대구||99|75
부산광역시|해운대구|우1동|99|75
광주광역시|||58|74
경기도|||60|120
경기도|수원시장안구||60|121
경기도|수원시장안구|파장동|60|121
경기도|수원시팔달구||61|121
경기도|수원시영통구||62|120
경기도|성남시분당구||62|123
경기도|고양시일산동구||56|129
경기도|고양시일산서구||56|129
경기도|광주시||65|123
경기도|양평군||69|125
강원특별자치도|||73|134
강원특별자치도|춘천시||73|134
강원특별자치도|춘천시|효자1동|73|134
강원특별자치도|고성군||85|145
경상남도|||91|77
경상남도|고성군||85|71
경상북도|울릉군||127|127
세종특별자치시|||66|103
세종특별자치시|세종특별자치시|조치원읍|66|106
제주특별자치도|||52|38
제주특별자치도|제주시||53|38
제주특별자치도|제주시|이도2동|53|38
제주특별자치도|서귀포시||52|33
`;

const places = createKmaPlaces(parseKmaPlaces(FIXTURE));

/** What a query finds, said in one line: the name and the cell, or why not. */
function found(query: string): string {
  const answer = places.find(query);
  if (answer.kind === "found") {
    return `${answer.name} @${answer.cell.nx},${answer.cell.ny}`;
  }
  return answer.kind === "ambiguous"
    ? `ambiguous: ${answer.candidates.join(" / ")}`
    : "unknown";
}

describe("reading the table", () => {
  test("a row is three names and a cell, and a line that is not one is skipped", () => {
    const rows = parseKmaPlaces(`
서울특별시|||60|127

서울특별시|종로구|청운효자동|60|127
not a row
|종로구||60|127
서울특별시|종로구||0|127
서울특별시|종로구||150|254
서울특별시|종로구|||
`);
    expect(rows).toEqual([
      { levels: ["서울특별시"], nx: 60, ny: 127 },
      { levels: ["서울특별시", "종로구", "청운효자동"], nx: 60, ny: 127 },
    ]);
    expect(parseKmaPlaces("")).toEqual([]);
  });

  test("a city's district is taken apart, and a name written twice is one level", () => {
    expect(
      parseKmaPlaces(
        "경기도|수원시장안구|파장동|60|121\n경기도|고양시일산동구||56|129\n세종특별자치시|세종특별자치시|조치원읍|66|106\n경기도|구리시||62|127",
      ).map((row) => row.levels),
    ).toEqual([
      ["경기도", "수원시", "장안구", "파장동"],
      // Not 고양시일산 + 동구.
      ["경기도", "고양시", "일산동구"],
      ["세종특별자치시", "조치원읍"],
      // 구리시 has 구 in it and is nobody's district.
      ["경기도", "구리시"],
    ]);
  });
});

describe("a place as somebody says it", () => {
  test("the full name, as 기상청 writes it", () => {
    expect(found("서울특별시 종로구 청운효자동")).toBe(
      "서울특별시 종로구 청운효자동 @60,127",
    );
    expect(found("경기도 수원시장안구 파장동")).toBe(
      "경기도 수원시 장안구 파장동 @60,121",
    );
  });

  test("the short name of a 시·도 and a district without its suffix", () => {
    expect(found("서울 종로")).toBe("서울특별시 종로구 @60,127");
    expect(found("부산 해운대구")).toBe("부산광역시 해운대구 @99,75");
    expect(found("강원 춘천")).toBe("강원특별자치도 춘천시 @73,134");
  });

  test("a district or a 동 on its own", () => {
    expect(found("춘천")).toBe("강원특별자치도 춘천시 @73,134");
    expect(found("해운대")).toBe("부산광역시 해운대구 @99,75");
    expect(found("청운효자동")).toBe("서울특별시 종로구 청운효자동 @60,127");
    expect(found("청운효자")).toBe("서울특별시 종로구 청운효자동 @60,127");
    expect(found("종로구 청운효자동")).toBe(
      "서울특별시 종로구 청운효자동 @60,127",
    );
  });

  test("spaces wherever they fall, or none", () => {
    expect(found("서울종로구")).toBe("서울특별시 종로구 @60,127");
    expect(found("  서울   종로구  ")).toBe("서울특별시 종로구 @60,127");
    expect(found("서울, 종로구")).toBe("서울특별시 종로구 @60,127");
  });

  test("either name of a 시·도 that was renamed", () => {
    expect(found("강원도 춘천시")).toBe("강원특별자치도 춘천시 @73,134");
    expect(found("강원특별자치도 춘천")).toBe("강원특별자치도 춘천시 @73,134");
    // And the other way: a table from before the renaming, asked with the new name.
    const older = createKmaPlaces(parseKmaPlaces("강원도|춘천시||73|134"));
    expect(older.find("강원특별자치도 춘천시")).toEqual({
      kind: "found",
      name: "강원도 춘천시",
      cell: { nx: 73, ny: 134 },
    });
  });

  test("a district of a city, by the district, by the city and the district, or as 기상청 runs them together", () => {
    expect(found("분당")).toBe("경기도 성남시 분당구 @62,123");
    expect(found("성남 분당구")).toBe("경기도 성남시 분당구 @62,123");
    expect(found("성남시분당구")).toBe("경기도 성남시 분당구 @62,123");
    expect(found("수원 장안구")).toBe("경기도 수원시 장안구 @60,121");
  });

  test("a city 기상청 lists only by its districts is still a city", () => {
    // No row is called 수원시. The cell is the middle one of its three districts' cells.
    expect(found("수원")).toBe("경기도 수원시 @61,121");
    expect(found("경기 수원시")).toBe("경기도 수원시 @61,121");
  });

  test("a 동 without its number is the 동, since its halves are one cell apart", () => {
    expect(found("역삼동")).toBe("서울특별시 강남구 역삼1동 @61,125");
    expect(found("강남 역삼")).toBe("서울특별시 강남구 역삼1동 @61,125");
    expect(found("역삼2동")).toBe("서울특별시 강남구 역삼2동 @61,125");
  });

  test("an island by the name people call it, and the first half of a name nobody says whole", () => {
    expect(found("울릉도")).toBe("경상북도 울릉군 @127,127");
    expect(found("여의도")).toBe("서울특별시 영등포구 여의동 @58,126");
    // 일산 is 일산동구 and 일산서구 and nowhere itself; they share a cell here.
    expect(found("일산")).toBe("경기도 고양시 일산동구 @56,129");
  });

  test("the coarsest row a name fits", () => {
    expect(found("서울")).toBe("서울특별시 @60,127");
    expect(found("부산시")).toBe("부산광역시 @98,76");
    expect(found("세종")).toBe("세종특별자치시 @66,103");
    // 광주 is the metropolitan city before it is the city in 경기도 …
    expect(found("광주")).toBe("광주광역시 @58,74");
    // … which is what its exact name, or its parent, finds.
    expect(found("광주시")).toBe("경기도 광주시 @65,123");
    expect(found("경기 광주")).toBe("경기도 광주시 @65,123");
    // And 양평 is the 군 before it is a 동 of 영등포구.
    expect(found("양평")).toBe("경기도 양평군 @69,125");
    expect(found("조치원")).toBe("세종특별자치시 조치원읍 @66,106");
  });

  test("a province is one cell, and says where that cell is", () => {
    // 강원 is not one weather: the row is where 기상청 put it, and the answer says where that is.
    expect(found("강원")).toBe("강원특별자치도(대표 지점: 춘천시) @73,134");
    expect(found("제주도")).toBe(
      "제주특별자치도(대표 지점: 제주시 부근) @52,38",
    );
    expect(found("제주")).toBe("제주특별자치도(대표 지점: 제주시 부근) @52,38");
  });

  test("a name several places share is a tie, said — never the first one found", () => {
    expect(found("중구")).toBe("ambiguous: 서울특별시 중구 / 부산광역시 중구");
    expect(found("고성")).toBe(
      "ambiguous: 강원특별자치도 고성군 / 경상남도 고성군",
    );
    expect(found("고성군")).toBe(
      "ambiguous: 강원특별자치도 고성군 / 경상남도 고성군",
    );
    // The 시·도 in front settles it.
    expect(found("부산 중구")).toBe("부산광역시 중구 @97,74");
    expect(found("강원 고성")).toBe("강원특별자치도 고성군 @85,145");
    expect(found("경남 고성군")).toBe("경상남도 고성군 @85,71");
  });

  test("a name that is not in the table is not found — nothing near it is offered instead", () => {
    for (const query of [
      "아틀란티스",
      "홍대",
      "도쿄",
      "Seoul",
      "",
      "  ",
      "구",
      // A parent that is not the row's parent.
      "서울 고성",
      "부산 종로구",
      // Something after the name.
      "서울 종로 날씨",
    ]) {
      expect({ query, answer: found(query) }).toEqual({
        query,
        answer: "unknown",
      });
    }
  });
});

describe("a cell back to a name", () => {
  test("is the districts whose 동 sit in it, the commonest first", () => {
    // Two 동 of 종로구 and one of 중구 share the cell.
    expect(places.nameOf({ nx: 60, ny: 127 })).toBe("서울특별시 종로구·중구");
    expect(places.nameOf({ nx: 73, ny: 134 })).toBe("강원특별자치도 춘천시");
    expect(places.nameOf({ nx: 60, ny: 121 })).toBe("경기도 수원시 장안구");
  });

  test("is the district itself where the table has no 동 for the cell", () => {
    expect(places.nameOf({ nx: 85, ny: 145 })).toBe("강원특별자치도 고성군");
  });

  test("is the nearest row and 부근 where nothing sits in the cell, and nothing far out at sea", () => {
    expect(places.nameOf({ nx: 86, ny: 146 })).toBe(
      "강원특별자치도 고성군 부근",
    );
    expect(places.nameOf({ nx: 1, ny: 1 })).toBeNull();
    // A city this file put together is never the name of a cell: it is not 기상청's row.
    expect(places.nameOf({ nx: 61, ny: 121 })).toBe("경기도 수원시");
  });

  test("an empty table finds nothing and names nothing", () => {
    const none = createKmaPlaces([]);
    expect(none.size).toBe(0);
    expect(none.find("서울")).toEqual({ kind: "unknown" });
    expect(none.nameOf({ nx: 60, ny: 127 })).toBeNull();
  });
});

/* ── the generator ───────────────────────────────────────────────────────────────────────────── */

/**
 * A worksheet in the layout the table has had on the public data portal: a code, three names, the
 * cell, then each coordinate three times over — degrees, minutes, seconds — and once more as a
 * decimal under a heading that says "(초/100)".
 */
const HEADINGS = [
  "구분",
  "행정구역코드",
  "1단계",
  "2단계",
  "3단계",
  "격자 X",
  "격자 Y",
  "경도(시)",
  "경도(분)",
  "경도(초)",
  "위도(시)",
  "위도(분)",
  "위도(초)",
  "경도(초/100)",
  "위도(초/100)",
  "위치업데이트",
];
const sheetRow = (
  levels: [string, string, string],
  cell: [number, number],
  longitude: number,
  latitude: number,
) => [
  "kor",
  1100000000,
  ...levels,
  ...cell,
  Math.trunc(longitude),
  0,
  0,
  Math.trunc(latitude),
  0,
  0,
  longitude,
  latitude,
  "",
];
const SHEET = [
  HEADINGS,
  sheetRow(["서울특별시", "", ""], [60, 127], 126.978, 37.5665),
  sheetRow(["서울특별시", "종로구", ""], [60, 127], 126.979, 37.5735),
  sheetRow(["부산광역시", "", ""], [98, 76], 129.0756, 35.1796),
  sheetRow(["경기도", "수원시장안구", "파장동"], [60, 121], 127.0, 37.31),
];

describe("the spreadsheet to the table", () => {
  test("reads the three names and the cell, and the decimal coordinate rather than its parts", () => {
    const reading = placesFromSheet(SHEET);
    expect(reading.skipped).toBe(0);
    expect(reading.headings).toEqual(HEADINGS);
    expect(reading.places).toEqual([
      {
        levels: ["서울특별시", "", ""],
        nx: 60,
        ny: 127,
        latitude: 37.5665,
        longitude: 126.978,
      },
      {
        levels: ["서울특별시", "종로구", ""],
        nx: 60,
        ny: 127,
        latitude: 37.5735,
        longitude: 126.979,
      },
      {
        levels: ["부산광역시", "", ""],
        nx: 98,
        ny: 76,
        latitude: 35.1796,
        longitude: 129.0756,
      },
      {
        levels: ["경기도", "수원시장안구", "파장동"],
        nx: 60,
        ny: 121,
        latitude: 37.31,
        longitude: 127.0,
      },
    ]);
  });

  test("finds the columns by their headings, wherever they are and whatever comes above them", () => {
    const moved = [
      ["동네예보 지점 좌표", "", "", "", ""],
      [],
      ["격자 Y", "격자 X", "3단계", "2단계", "1단계"],
      [127, 60, "청운효자동", "종로구", "서울특별시"],
    ];
    expect(placesFromSheet(moved).places).toEqual([
      {
        levels: ["서울특별시", "종로구", "청운효자동"],
        nx: 60,
        ny: 127,
        // No coordinate columns in this one: nothing to check the projection against.
        latitude: null,
        longitude: null,
      },
    ]);
  });

  test("a sheet that is not the table stops the run and says what it saw", () => {
    expect(() =>
      placesFromSheet([
        ["지점", "이름"],
        [108, "서울"],
      ]),
    ).toThrow("지점 | 이름");
    expect(() =>
      placesFromSheet([
        ["1단계", "2단계", "격자 X"],
        ["서울특별시", "", 60],
      ]),
    ).toThrow("third, ny");
  });

  test("blank lines and cells outside the grid are not rows, and a row written twice is one", () => {
    const reading = placesFromSheet([
      ...SHEET,
      [],
      sheetRow(["서울특별시", "", ""], [60, 127], 126.978, 37.5665),
      sheetRow(["이어도", "", ""], [0, 0], 125.18, 32.12),
      sheetRow(["", "", ""], [60, 127], 126.978, 37.5665),
    ]);
    expect(reading.places).toHaveLength(4);
    // The two that carried something and were not places. The blank line is not counted.
    expect(reading.skipped).toBe(2);
  });

  test("a workbook is read through to the worksheet that is the table", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["이 파일에 대하여"], ["기상청"]]),
      "설명",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(SHEET),
      "최종 업데이트 파일",
    );
    const bytes = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    }) as Uint8Array;

    const reading = placesFromWorkbook(bytes);
    expect(reading.places.map((place) => place.levels[0])).toEqual([
      "서울특별시",
      "서울특별시",
      "부산광역시",
      "경기도",
    ]);

    const none = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      none,
      XLSX.utils.aoa_to_sheet([["아무것도"]]),
      "빈 시트",
    );
    expect(() =>
      placesFromWorkbook(
        XLSX.write(none, { type: "buffer", bookType: "xlsx" }) as Uint8Array,
      ),
    ).toThrow("No heading row");
  });

  test("says how many of the sheet's own pairs the projection reproduces", () => {
    const reading = placesFromSheet([
      ...SHEET,
      // A row whose cell is not where its coordinate is.
      sheetRow(["가짜도", "", ""], [10, 10], 126.978, 37.5665),
    ]);
    const agreement = projectionAgreement(reading.places);
    expect(agreement.checked).toBe(5);
    expect(agreement.agreed).toBe(4);
    expect(agreement.examples).toEqual([
      "가짜도: sheet 10,10 — projection 60,127",
    ]);
  });

  test("writes a module the tool's own reader takes back row for row", async () => {
    const { places: read } = placesFromSheet(SHEET);
    const text = tableModule(read, {
      name: "동네예보지점좌표(위경도)_260701.xlsx",
      sha256: "0".repeat(64),
    });
    // Only names and cells: no coordinate, no administrative code, nothing else of the sheet.
    expect(text).not.toContain("126.978");
    expect(text).not.toContain("1100000000");
    expect(text).toContain("서울특별시|종로구||60|127");

    // The text is a module: written to disk and imported, it is the table.
    const directory = mkdtempSync(join(tmpdir(), "kma-places-"));
    try {
      const path = join(directory, "table.ts");
      writeFileSync(path, text);
      const written = (await import(path)) as {
        KMA_PLACES_SOURCE: string | null;
        KMA_PLACES_TABLE: string;
      };
      expect(written.KMA_PLACES_SOURCE).toBe(
        "동네예보지점좌표(위경도)_260701.xlsx",
      );
      expect(parseKmaPlaces(written.KMA_PLACES_TABLE)).toEqual([
        { levels: ["서울특별시"], nx: 60, ny: 127 },
        { levels: ["서울특별시", "종로구"], nx: 60, ny: 127 },
        { levels: ["부산광역시"], nx: 98, ny: 76 },
        { levels: ["경기도", "수원시", "장안구", "파장동"], nx: 60, ny: 121 },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses a name that would break the table it is written into", () => {
    for (const name of ["a|b", "back`tick", "dollar${brace}", "line\nbreak"]) {
      expect(() =>
        tableModule(
          [
            {
              levels: [name, "", ""],
              nx: 60,
              ny: 127,
              latitude: null,
              longitude: null,
            },
          ],
          { name: "x.xlsx", sha256: "0" },
        ),
      ).toThrow("cannot be written");
    }
  });
});

/* ── the table this repository ships ─────────────────────────────────────────────────────────── */

const shipped = KMA_PLACES.size > 0;

describe("the table this deployment ships", () => {
  test("offers a place in words exactly when it has rows to look one up in", () => {
    const [tool] = KMA_WEATHER_TOOLS;
    if (!tool) throw new Error("the tool is not declared");
    const properties = Object.keys(
      (tool.inputSchema as { properties: Record<string, unknown> }).properties,
    );
    expect(properties.includes("place")).toBe(shipped);
    expect(KMA_PLACES_SOURCE === null).toBe(!shipped);
    expect(parseKmaPlaces(KMA_PLACES_TABLE)).toHaveLength(KMA_PLACES.size);
  });

  /*
   * 기상청's own rows. These run once the generator has written the table, and were written before
   * the spreadsheet was on this machine — from the cells the projection gives for each office and
   * from what the table has long been known to hold. One that fails against the real rows is a
   * fact about the table to be read, not a test to be loosened.
   */
  describe.skipIf(!shipped)("once it holds 기상청's rows", () => {
    test("is the whole country", () => {
      expect(KMA_PLACES.size).toBeGreaterThan(3_000);
      expect(KMA_PLACES_SOURCE).toMatch(/\.xlsx$/);
    });

    test("서울 종로구, 부산 해운대구 and 춘천 are where 기상청 files them", () => {
      expect(KMA_PLACES.find("서울 종로구")).toEqual({
        kind: "found",
        name: "서울특별시 종로구",
        cell: { nx: 60, ny: 127 },
      });
      expect(KMA_PLACES.find("부산 해운대구")).toEqual({
        kind: "found",
        name: "부산광역시 해운대구",
        cell: { nx: 99, ny: 75 },
      });
      const chuncheon = KMA_PLACES.find("춘천");
      expect(chuncheon.kind).toBe("found");
      if (chuncheon.kind !== "found") return;
      expect(chuncheon.name).toMatch(/^강원(특별자치)?도 춘천시$/);
      expect(chuncheon.cell).toEqual({ nx: 73, ny: 134 });
    });

    test("제주 is the 도, at the cell its row has, and says where that is", () => {
      const jeju = KMA_PLACES.find("제주");
      expect(jeju.kind).toBe("found");
      if (jeju.kind !== "found") return;
      expect(jeju.name.startsWith("제주특별자치도")).toBe(true);
      expect(jeju.cell.ny).toBe(38);
      expect([52, 53]).toContain(jeju.cell.nx);
    });

    test("중구 and 고성 are ties, and a name that is nowhere is not found", () => {
      const junggu = KMA_PLACES.find("중구");
      expect(junggu.kind).toBe("ambiguous");
      if (junggu.kind !== "ambiguous") return;
      expect(junggu.candidates).toEqual(
        expect.arrayContaining([
          "서울특별시 중구",
          "부산광역시 중구",
          "대구광역시 중구",
          "인천광역시 중구",
          "대전광역시 중구",
          "울산광역시 중구",
        ]),
      );
      const goseong = KMA_PLACES.find("고성");
      expect(goseong.kind).toBe("ambiguous");
      if (goseong.kind !== "ambiguous") return;
      expect(goseong.candidates).toHaveLength(2);
      for (const candidate of goseong.candidates) {
        expect(candidate.endsWith("고성군")).toBe(true);
      }
      expect(KMA_PLACES.find("아틀란티스")).toEqual({ kind: "unknown" });
    });

    test("the cell of 서울 시청 is called 서울", () => {
      expect(KMA_PLACES.nameOf({ nx: 60, ny: 127 })).toContain("서울특별시");
    });
  });
});
