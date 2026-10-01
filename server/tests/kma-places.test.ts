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
  type KmaPlaceAnswer,
  type KmaPlaces,
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
 * (수원시장안구), the 2026 merger of 광주 and 전남 as the real sheet has it — so that how a query is
 * read can be pinned without four thousand rows in the way. The generator is held to rows cut from
 * the real spreadsheet, cell types and all. And the table this repository SHIPS is held to
 * 기상청's own rows, read through the same lookup.
 *
 * The fixture's cells are 기상청's where the row is one of its own and plausible where it is not.
 * They are there to be found, not to be 기상청's word on where 양평 is.
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
전남광주통합특별시|||51|67
전남광주통합특별시|순천시||70|70
전남광주통합특별시|동구||60|74
전남광주통합특별시|서구||59|74
전남광주통합특별시|남구||59|73
전남광주통합특별시|북구||59|75
전남광주통합특별시|광산구||57|74
전남광주통합특별시|무안군||52|71
전남광주통합특별시|무안군|삼향읍|51|67
부산광역시|||98|76
부산광역시|중구||97|74
부산광역시|해운대구||99|75
부산광역시|해운대구|우1동|99|75
울산광역시|동구|일산동|105|83
경기도|||60|120
경기도|수원시장안구||60|121
경기도|수원시장안구|파장동|60|121
경기도|수원시팔달구||61|121
경기도|수원시영통구||62|120
경기도|성남시분당구||62|123
경기도|고양시일산동구||56|129
경기도|고양시일산서구||56|129
경기도|광주시||65|123
경기도|남양주시||64|128
경기도|화성시만세구|남양읍|55|120
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

/** What an answer is, said in one line: the name and the cell, or why not. */
function said(answer: KmaPlaceAnswer): string {
  if (answer.kind === "found") {
    return `${answer.name} @${answer.cell.nx},${answer.cell.ny}`;
  }
  return answer.kind === "ambiguous"
    ? `ambiguous: ${answer.candidates.join(" / ")}`
    : "unknown";
}
const found = (query: string, table: KmaPlaces = places) =>
  said(table.find(query));

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
      { levels: ["서울특별시"], column: 1, nx: 60, ny: 127 },
      {
        levels: ["서울특별시", "종로구", "청운효자동"],
        column: 3,
        nx: 60,
        ny: 127,
      },
    ]);
    expect(parseKmaPlaces("")).toEqual([]);
  });

  test("a city's district is taken apart, a name written twice is one level, and the column is kept", () => {
    expect(
      parseKmaPlaces(
        "경기도|수원시장안구|파장동|60|121\n경기도|고양시일산동구||56|129\n세종특별자치시|세종특별자치시|조치원읍|66|106\n경기도|구리시||62|127",
      ).map((row) => `${row.column}: ${row.levels.join(" / ")}`),
    ).toEqual([
      "3: 경기도 / 수원시 / 장안구 / 파장동",
      // Not 고양시일산 + 동구. Two names, and still the sheet's second column: a 시·군·구.
      "2: 경기도 / 고양시 / 일산동구",
      // One name fewer than its column: the 2단계 only repeats the 시·도.
      "3: 세종특별자치시 / 조치원읍",
      // 구리시 has 구 in it and is nobody's district.
      "2: 경기도 / 구리시",
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
    expect(found("강원특별자치도 춘천시", older)).toBe("강원도 춘천시 @73,134");
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

  test("an island by the name people call it", () => {
    expect(found("울릉도")).toBe("경상북도 울릉군 @127,127");
    expect(found("여의도")).toBe("서울특별시 영등포구 여의동 @58,126");
  });

  test("the town a city's districts were made from — before a 동 of the same name elsewhere", () => {
    // 일산 is 일산동구 and 일산서구 and nowhere itself. 울산 has an 일산동, and on the real rows that
    // was all "일산" found until a district outranked a neighbourhood.
    expect(found("일산")).toBe("경기도 고양시 일산동구 @56,129");
    expect(found("경기 일산")).toBe("경기도 고양시 일산동구 @56,129");
    // The 동 is still there for somebody who says where it is.
    expect(found("울산 일산동")).toBe("울산광역시 동구 일산동 @105,83");
  });

  test("but the start of any other name is not that name", () => {
    // 남양 is an 읍 of 화성. It is not 남양주시, whose name merely begins that way.
    expect(found("남양")).toBe("경기도 화성시 만세구 남양읍 @55,120");
    expect(found("남양주")).toBe("경기도 남양주시 @64,128");
    expect(found("해운")).toBe("unknown");
  });

  test("the coarsest row a name fits", () => {
    expect(found("서울")).toBe("서울특별시 @60,127");
    expect(found("부산시")).toBe("부산광역시 @98,76");
    expect(found("세종")).toBe("세종특별자치시 @66,103");
    // 양평 is the 군 before it is a 동 of 영등포구.
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

/*
 * THE MERGER. On 2026-07-01 광주광역시 and 전라남도 became 전남광주통합특별시, and the sheet of that
 * date has no row called 광주 at all: its five districts stand directly under the merged 시·도,
 * whose own row is in 무안. Nobody stopped saying 광주, 전남 or 전라남도.
 */
describe("a 시·도 that merged, under the names people kept", () => {
  test("광주 is the city — the middle of its five districts — and not the province's office in 무안", () => {
    expect(found("광주")).toBe("전남광주통합특별시 광주 @59,74");
    expect(found("광주광역시")).toBe("전남광주통합특별시 광주 @59,74");
    // With the spaces out this is "전남광주", and it still means the city.
    expect(found("전남 광주")).toBe("전남광주통합특별시 광주 @59,74");
  });

  test("and not the city in 경기도 either, which is still found by its own name or its parent", () => {
    expect(found("광주시")).toBe("경기도 광주시 @65,123");
    expect(found("경기 광주")).toBe("경기도 광주시 @65,123");
  });

  test("its districts answer to 광주, and the rest of the province to 전남", () => {
    expect(found("광주 북구")).toBe("전남광주통합특별시 북구 @59,75");
    expect(found("광주광역시 북구")).toBe("전남광주통합특별시 북구 @59,75");
    expect(found("광주 광산구")).toBe("전남광주통합특별시 광산구 @57,74");
    expect(found("전남 순천")).toBe("전남광주통합특별시 순천시 @70,70");
    expect(found("전라남도 순천시")).toBe("전남광주통합특별시 순천시 @70,70");
    expect(found("순천")).toBe("전남광주통합특별시 순천시 @70,70");
  });

  test("the province by any of its names is its one cell, named for where that is", () => {
    for (const name of ["전라남도", "전남", "전남광주통합특별시"]) {
      expect(found(name)).toBe("전남광주통합특별시(대표 지점: 무안군) @51,67");
    }
  });

  test("a sheet from before the merger reads as it always did", () => {
    const before = createKmaPlaces(
      parseKmaPlaces(
        "광주광역시|||58|74\n광주광역시|북구||59|75\n전라남도|||51|67\n전라남도|순천시||70|70\n경기도|광주시||65|123",
      ),
    );
    expect(found("광주", before)).toBe("광주광역시 @58,74");
    expect(found("광주 북구", before)).toBe("광주광역시 북구 @59,75");
    expect(found("전남 순천", before)).toBe("전라남도 순천시 @70,70");
    // Nothing in this five-row table is near the province's cell, so it is named plainly.
    expect(found("전남", before)).toBe("전라남도 @51,67");
    expect(found("광주시", before)).toBe("경기도 광주시 @65,123");
  });
});

describe("a cell back to a name", () => {
  test("is the districts whose 동 sit in it, the commonest first", () => {
    // Two 동 of 종로구 and one of 중구 share the cell, beside the two district offices.
    expect(places.nameOf({ nx: 60, ny: 127 })).toBe("서울특별시 종로구·중구");
    expect(places.nameOf({ nx: 73, ny: 134 })).toBe("강원특별자치도 춘천시");
    expect(places.nameOf({ nx: 60, ny: 121 })).toBe("경기도 수원시 장안구");
    // 세종's 동 stand directly under 세종, so that is what their cell is called.
    expect(places.nameOf({ nx: 66, ny: 106 })).toBe("세종특별자치시");
  });

  test("is the district itself where the table has no 동 for the cell", () => {
    expect(places.nameOf({ nx: 85, ny: 145 })).toBe("강원특별자치도 고성군");
    expect(places.nameOf({ nx: 61, ny: 121 })).toBe("경기도 수원시 팔달구");
  });

  test("is the nearest row and 부근 where nothing sits in the cell, and nothing far out at sea", () => {
    expect(places.nameOf({ nx: 86, ny: 146 })).toBe(
      "강원특별자치도 고성군 부근",
    );
    expect(places.nameOf({ nx: 1, ny: 1 })).toBeNull();
  });

  test("is never a city this file put together: that is not 기상청's row", () => {
    // 광주 is answered at 서구's cell; the cell is still called 서구.
    expect(places.nameOf({ nx: 59, ny: 74 })).toBe("전남광주통합특별시 서구");
  });

  test("an empty table finds nothing and names nothing", () => {
    const none = createKmaPlaces([]);
    expect(none.size).toBe(0);
    expect(none.find("서울")).toEqual({ kind: "unknown" });
    expect(none.nameOf({ nx: 60, ny: 127 })).toBeNull();
  });
});

/* ── the generator ───────────────────────────────────────────────────────────────────────────── */

/*
 * Rows of the real spreadsheet (2026-07-01 edition), as SheetJS hands them over: nearly every cell
 * is text, numbers included, and a few rows are typed. Each coordinate is there three times over —
 * 시, 분, 초 — and once more as plain decimal degrees under a heading that says "(초/100)".
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
  "",
];
// biome-ignore format: one row of the sheet a line, as the sheet has them.
const SEOUL = ["kor","1100000000","서울특별시","","","60","127","126","58","48.03","37","33","48.85","126.980008333333","37.5635694444444","",""];
// biome-ignore format: one row of the sheet a line.
const JONGNO = ["kor","1111000000","서울특별시","종로구","","60","127","126","58","53.91","37","34","13.36","126.981641666666","37.5703777777777","",""];
// biome-ignore format: one row of the sheet a line.
const GAHOE = ["kor","1111060000","서울특별시","종로구","가회동","60","127","126","59","12.88","37","34","38.11","126.986911111111","37.5772527777777","",""];
// biome-ignore format: one row of the sheet a line. This one is typed: numbers, not text.
const SINSEOL = ["kor","1123051500","서울특별시","동대문구","신설동",61,127,127,1,32.6508,37,34,26.27749,127.0257363329322,37.57396596807686,"20250701",""];
// biome-ignore format: one row of the sheet a line.
const PAJANG = ["kor","4111156000","경기도","수원시장안구","파장동","60","121","126","59","48.79","37","18","20.1","126.996886111111","37.3055833333333","",""];
// biome-ignore format: one row of the sheet a line. Its coordinate is 2 m over its cell's edge.
const SUYU = ["kor","1130561500","서울특별시","강북구","수유1동","60","128","127","1","9.47","37","37","50.64","127.019297222222","37.6307333333333","20190115",""];
// biome-ignore format: one row of the sheet a line. Its coordinate was updated in 2014; its cell was not.
const GWANPYEONG = ["kor","3020060000","대전광역시","유성구","관평동","68","101","127","23","19.6","36","25","23.41","127.3887774","36.42316994","20140319",""];
// biome-ignore format: one row of the sheet a line. The sheet has it twice, with no coordinate at all.
const IEODO = ["kor","5019000000","이어도","","","28","8","0","0","0.0","0","0","0.0","0","0","",""];
const SHEET = [HEADINGS, SEOUL, JONGNO, GAHOE, SINSEOL, PAJANG];

describe("the spreadsheet to the table", () => {
  test("reads the three names and the cell, whether a cell is text or a number", () => {
    const reading = placesFromSheet(SHEET);
    expect(reading.skipped).toBe(0);
    expect(reading.headings).toEqual(HEADINGS);
    expect(
      reading.places.map(
        (place) => `${place.levels.join("|")}|${place.nx}|${place.ny}`,
      ),
    ).toEqual([
      "서울특별시|||60|127",
      "서울특별시|종로구||60|127",
      "서울특별시|종로구|가회동|60|127",
      "서울특별시|동대문구|신설동|61|127",
      "경기도|수원시장안구|파장동|60|121",
    ]);
  });

  test("takes the decimal degrees for the coordinate — not the seconds beside them", () => {
    /*
     * THE BUG THE REAL FILE FOUND. The heading over the decimal column is "위도(초/100)", so the
     * column is told by what is in it — and the first reader took the first 위도 column holding a
     * number between 30 and 45 that was not whole. 가회동's SECONDS are 38.11. Every latitude in the
     * sheet was read off the seconds column, and 5 of 3,837 rows landed in their own cell.
     */
    const coordinates = Object.fromEntries(
      placesFromSheet(SHEET).places.map((place) => [
        place.levels.filter(Boolean).join(" "),
        [place.latitude, place.longitude],
      ]),
    );
    expect(coordinates).toEqual({
      서울특별시: [37.5635694444444, 126.980008333333],
      "서울특별시 종로구": [37.5703777777777, 126.981641666666],
      "서울특별시 종로구 가회동": [37.5772527777777, 126.986911111111],
      "서울특별시 동대문구 신설동": [37.57396596807686, 127.0257363329322],
      "경기도 수원시장안구 파장동": [37.3055833333333, 126.996886111111],
    });
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

  test("blank lines and cells outside the grid are not rows, a row written twice is one, and zeros are no coordinate", () => {
    const reading = placesFromSheet([
      ...SHEET,
      [],
      SEOUL,
      IEODO,
      IEODO,
      [
        "kor",
        "",
        "없는곳",
        "",
        "",
        "0",
        "0",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ],
      ["kor", "", "", "", "", "60", "127", "", "", "", "", "", "", "", "", ""],
    ]);
    expect(reading.places).toHaveLength(6);
    // The two that carried something and were not places. The blank line is not counted.
    expect(reading.skipped).toBe(2);
    expect(reading.places.at(-1)).toEqual({
      levels: ["이어도", "", ""],
      nx: 28,
      ny: 8,
      // 0 and 0 in the sheet: not a place in the Gulf of Guinea, just no coordinate.
      latitude: null,
      longitude: null,
    });
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
      "최종 업데이트 파일_20260701",
    );
    const bytes = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    }) as Uint8Array;

    const reading = placesFromWorkbook(bytes);
    expect(reading.places.map((place) => place.levels[2])).toEqual([
      "",
      "",
      "가회동",
      "신설동",
      "파장동",
    ]);
    // Through a real workbook the seconds are still not the latitude.
    expect(reading.places[2]?.latitude).toBe(37.5772527777777);

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

  test("says how many of the sheet's own pairs the projection reproduces, and names the ones it does not", () => {
    const reading = placesFromSheet([...SHEET, SUYU, GWANPYEONG, IEODO]);
    expect(projectionAgreement(reading.places)).toEqual({
      // 이어도 carries no coordinate, so it is not one of the rows checked.
      checked: 7,
      agreed: 5,
      // A rounding: the coordinate is two metres over the line.
      atEdge: [
        "서울특별시 강북구 수유1동: sheet 60,128 — projection 61,128, 2 m past the edge",
      ],
      // Not a rounding. On the real sheet this is the furthest of seven.
      apart: [
        "대전광역시 유성구 관평동: sheet 68,101 — projection 67,102, 2452 m past the edge",
      ],
    });
  });

  test("writes a module the tool's own reader takes back row for row", async () => {
    const { places: read } = placesFromSheet(SHEET);
    const text = tableModule(read, {
      name: "동네예보지점좌표(위경도)_260701.xlsx",
      sha256: "0".repeat(64),
    });
    // Only names and cells: no coordinate, no administrative code, nothing else of the sheet.
    expect(text).not.toContain("126.98");
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
      expect(
        parseKmaPlaces(written.KMA_PLACES_TABLE).map(
          (row) =>
            `${row.column}: ${row.levels.join(" / ")} @${row.nx},${row.ny}`,
        ),
      ).toEqual([
        "1: 서울특별시 @60,127",
        "2: 서울특별시 / 종로구 @60,127",
        "3: 서울특별시 / 종로구 / 가회동 @60,127",
        "3: 서울특별시 / 동대문구 / 신설동 @61,127",
        "3: 경기도 / 수원시 / 장안구 / 파장동 @60,121",
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

/*
 * 기상청's own rows: 동네예보지점좌표(위경도)_260701.xlsx, 3,837 of them. What a name comes to here is
 * what a person asking their Bot gets, so these are the names people say — and one that fails after
 * a new edition of the sheet is a fact about that edition to be read, not a test to be loosened.
 */
describe("the table this deployment ships", () => {
  const shipped = (query: string) => found(query, KMA_PLACES);

  test("has 기상청's rows, says which sheet they came from, and switches the tool's place argument on", () => {
    expect(KMA_PLACES.size).toBe(3_837);
    expect(parseKmaPlaces(KMA_PLACES_TABLE)).toHaveLength(3_837);
    expect(KMA_PLACES_SOURCE).toBe("동네예보지점좌표(위경도)_260701.xlsx");
    const [tool] = KMA_WEATHER_TOOLS;
    if (!tool) throw new Error("the tool is not declared");
    expect(
      Object.keys(
        (tool.inputSchema as { properties: Record<string, unknown> })
          .properties,
      ),
    ).toEqual(["place", "latitude", "longitude"]);
  });

  test("서울 종로구, 부산 해운대구, 춘천 and 제주 서귀포 are where 기상청 files them", () => {
    expect(shipped("서울 종로구")).toBe("서울특별시 종로구 @60,127");
    expect(shipped("서울특별시 종로구 청운효자동")).toBe(
      "서울특별시 종로구 청운효자동 @60,127",
    );
    expect(shipped("부산 해운대구")).toBe("부산광역시 해운대구 @99,75");
    expect(shipped("해운대")).toBe("부산광역시 해운대구 @99,75");
    expect(shipped("춘천")).toBe("강원특별자치도 춘천시 @73,134");
    expect(shipped("제주 서귀포")).toBe("제주특별자치도 서귀포시 @53,33");
    expect(shipped("세종")).toBe("세종특별자치시 @66,103");
    expect(shipped("세종시")).toBe("세종특별자치시 @66,103");
    expect(shipped("조치원")).toBe("세종특별자치시 조치원읍 @66,106");
  });

  test("a province is its office's cell, under either of its names, and says where that is", () => {
    for (const name of ["강원", "강원도", "강원특별자치도"]) {
      expect(shipped(name)).toBe("강원특별자치도(대표 지점: 춘천시) @73,134");
    }
    for (const name of ["전북", "전라북도", "전북특별자치도"]) {
      expect(shipped(name)).toBe(
        "전북특별자치도(대표 지점: 전주시 완산구·덕진구 등) @63,89",
      );
    }
    for (const name of ["제주", "제주도"]) {
      expect(shipped(name)).toBe("제주특별자치도(대표 지점: 제주시) @52,38");
    }
    expect(shipped("경기")).toBe(
      "경기도(대표 지점: 수원시 권선구·팔달구) @60,120",
    );
    // No 동 shares the cell of 경북's office; the nearest row says whose it is.
    expect(shipped("경북")).toBe("경상북도(대표 지점: 안동시 부근) @87,106");
  });

  test("광주 and 전남 still answer, though the sheet has neither", () => {
    // The 시·도 row of the merged 전남광주통합특별시 is in 무안, cell 51,67. 광주 is not that.
    expect(shipped("광주")).toBe("전남광주통합특별시 광주 @59,74");
    expect(shipped("광주광역시")).toBe("전남광주통합특별시 광주 @59,74");
    expect(shipped("전남 광주")).toBe("전남광주통합특별시 광주 @59,74");
    expect(shipped("광주 북구")).toBe("전남광주통합특별시 북구 @59,75");
    expect(shipped("광주광역시 광산구")).toBe(
      "전남광주통합특별시 광산구 @57,74",
    );
    expect(shipped("전남 순천")).toBe("전남광주통합특별시 순천시 @70,70");
    expect(shipped("전라남도 여수시")).toBe("전남광주통합특별시 여수시 @73,66");
    for (const name of ["전라남도", "전남", "전남광주통합특별시"]) {
      expect(shipped(name)).toBe(
        "전남광주통합특별시(대표 지점: 목포시·무안군) @51,67",
      );
    }
    // And the city in 경기도 is still itself.
    expect(shipped("광주시")).toBe("경기도 광주시 @65,123");
    expect(shipped("경기 광주")).toBe("경기도 광주시 @65,123");
  });

  test("the thirteen cities the sheet lists only by district are each found by name", () => {
    expect(
      [
        "수원",
        "성남",
        "안양",
        "부천",
        "안산",
        "고양",
        "용인",
        "화성",
        "청주",
        "천안",
        "포항",
        "창원",
        "전주",
      ].map(shipped),
    ).toEqual([
      "경기도 수원시 @60,120",
      "경기도 성남시 @63,124",
      "경기도 안양시 @59,123",
      "경기도 부천시 @57,125",
      "경기도 안산시 @57,121",
      "경기도 고양시 @56,129",
      "경기도 용인시 @62,120",
      "경기도 화성시 @60,119",
      "충청북도 청주시 @69,106",
      "충청남도 천안시 @63,110",
      "경상북도 포항시 @102,94",
      "경상남도 창원시 @90,76",
      "전북특별자치도 전주시 @63,89",
    ]);
    expect(shipped("분당")).toBe("경기도 성남시 분당구 @62,123");
    // 일산 and 마산 are the towns districts were made from; 울산 and 원주 each have an 일산동.
    expect(shipped("일산")).toBe("경기도 고양시 일산동구 @56,129");
    expect(shipped("마산")).toBe("경상남도 창원시 마산합포구 @89,76");
  });

  test("중구 and 고성 are ties, with every place that shares the name", () => {
    // Five, not six. This sheet has no 인천 중구: it lists 제물포구 and 영종구, both rows updated on
    // the day it is dated. A name the table has dropped is not found, and is not guessed at.
    expect(shipped("중구")).toBe(
      "ambiguous: 서울특별시 중구 / 부산광역시 중구 / 대구광역시 중구 / 대전광역시 중구 / 울산광역시 중구",
    );
    expect(shipped("인천 중구")).toBe("unknown");
    expect(shipped("인천 제물포구")).toBe("인천광역시 제물포구 @54,125");
    expect(shipped("북구")).toBe(
      "ambiguous: 전남광주통합특별시 북구 / 부산광역시 북구 / 대구광역시 북구 / 울산광역시 북구 / 경상북도 포항시 북구",
    );
    expect(shipped("고성")).toBe(
      "ambiguous: 경상남도 고성군 / 강원특별자치도 고성군",
    );
    expect(shipped("강원 고성")).toBe("강원특별자치도 고성군 @85,145");
    expect(shipped("경남 고성")).toBe("경상남도 고성군 @85,71");
  });

  test("islands, a 동 without its number, and a name that is nowhere", () => {
    expect(shipped("울릉도")).toBe("경상북도 울릉군 @127,127");
    expect(shipped("독도")).toBe("경상북도 울릉군 독도 @144,123");
    expect(shipped("백령도")).toBe("인천광역시 옹진군 백령면 @21,135");
    // 여의도 is read as 여의(동) — and 전주 has a 여의동 too, which only the real rows could say.
    expect(shipped("여의도")).toBe(
      "ambiguous: 서울특별시 영등포구 여의동 / 전북특별자치도 전주시 덕진구 여의동",
    );
    expect(shipped("서울 여의도")).toBe("서울특별시 영등포구 여의동 @59,126");
    expect(shipped("역삼동")).toBe("서울특별시 강남구 역삼1동 @61,125");
    expect(shipped("양평")).toBe("경기도 양평군 @69,125");
    // 남양 is five 읍·면·동 across the country, and not 남양주시.
    expect(KMA_PLACES.find("남양").kind).toBe("ambiguous");
    for (const nowhere of ["아틀란티스", "홍대", "도쿄", "서울 날씨"]) {
      expect(shipped(nowhere)).toBe("unknown");
    }
  });

  test("a cell is called by the districts whose 동 sit in it", () => {
    expect(KMA_PLACES.nameOf({ nx: 60, ny: 127 })).toBe(
      "서울특별시 종로구·중구 등",
    );
    expect(KMA_PLACES.nameOf({ nx: 98, ny: 76 })).toBe(
      "부산광역시 연제구·동래구 등",
    );
    expect(KMA_PLACES.nameOf({ nx: 66, ny: 103 })).toBe("세종특별자치시");
    expect(KMA_PLACES.nameOf({ nx: 59, ny: 74 })).toContain(
      "전남광주통합특별시 서구",
    );
    expect(KMA_PLACES.nameOf({ nx: 1, ny: 1 })).toBeNull();
  });
});
