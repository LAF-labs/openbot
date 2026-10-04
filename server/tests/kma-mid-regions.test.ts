import { describe, expect, test } from "bun:test";
import {
  createKmaMidRegions,
  KMA_MID_REGIONS,
  KMA_MID_TEMPERATURE_REGIONS,
  landRegionOf,
} from "../src/plugins/kma-mid-regions";
import { KMA_PLACES, parseKmaPlaces } from "../src/plugins/kma-places";
import { KMA_PLACES_TABLE } from "../src/plugins/kma-places-table";

/**
 * Which of 기상청's 중기예보 regions a place is in.
 *
 * Held to the table this repository ships, because the question is whether THAT table's rows find
 * their regions: a 시·군 the mapping misses is a person whose week ends on the fourth day, and
 * nothing would say so. The codes themselves were held to the service (`kma-mid-regions.ts` says
 * how); what is held here is that every row reaches one of them, and the right one.
 */

/** The ten regions `getMidLandFcst` answered on 2026-10-04; four others asked for answered NO_DATA. */
const LAND_REGIONS = new Set([
  "11B00000",
  "11D10000",
  "11D20000",
  "11C20000",
  "11C10000",
  "11F20000",
  "11F10000",
  "11H10000",
  "11H20000",
  "11G00000",
]);

const codes = KMA_MID_TEMPERATURE_REGIONS.trim()
  .split("\n")
  .map((line) => line.trim().split(/\s+/) as [string, string]);

/** A place as somebody says it, to its region — by the names it was found by, as the tool asks. */
function regionOf(query: string) {
  const found = KMA_PLACES.find(query);
  if (found.kind !== "found") throw new Error(`${query}: ${found.kind}`);
  return KMA_MID_REGIONS.of(found.cell, found.levels);
}

describe("the table of regions", () => {
  test("is the 173 codes the service answered, each once, and not the one it no longer issues", () => {
    expect(codes).toHaveLength(173);
    expect(new Set(codes.map(([code]) => code)).size).toBe(173);
    for (const [code, name] of codes) {
      expect(code).toMatch(/^[12]1[A-H]\d{5}$/);
      expect(name).not.toBe("");
    }
    // 군위 became a district of 대구 in 2023; `11H10603` answers NO_DATA.
    expect(codes.map(([code]) => code)).not.toContain("11H10603");
  });

  test("every code's land region is one of the ten the land forecast is issued for", () => {
    for (const [code] of codes) {
      expect(LAND_REGIONS.has(landRegionOf(code))).toBe(true);
    }
  });

  test("the land region is the code's prefix, with the three exceptions the service makes", () => {
    expect(landRegionOf("11D10301")).toBe("11D10000"); // 춘천: 강원영서
    expect(landRegionOf("11D20501")).toBe("11D20000"); // 강릉: 강원영동
    expect(landRegionOf("11G00201")).toBe("11G00000"); // 제주
    // 군산 and 목포 are filed under a second prefix and forecast with 전북 and 전남.
    expect(landRegionOf("21F10501")).toBe("11F10000");
    expect(landRegionOf("21F20801")).toBe("11F20000");
    // 백령도 with 서울·인천·경기, 울릉도 with 대구·경북.
    expect(landRegionOf("11A00101")).toBe("11B00000");
    expect(landRegionOf("11E00101")).toBe("11H10000");
  });
});

describe("a place, to its regions", () => {
  test("every 시·군·구 and 읍·면·동 the shipped table has is in a region", () => {
    const rows = parseKmaPlaces(KMA_PLACES_TABLE).filter(
      (row) => row.levels.length >= 2,
    );
    expect(rows.length).toBeGreaterThan(3_800);
    expect(KMA_MID_REGIONS.size).toBe(rows.length);
    const missed = rows.filter((row) => !KMA_MID_REGIONS.of(row, row.levels));
    expect(missed.map((row) => row.levels.join(" "))).toEqual([]);
  });

  test("a 시·군 is its own region, and a district of a city is the city's", () => {
    expect(regionOf("춘천")).toEqual({
      temperature: "11D10301",
      land: "11D10000",
      name: "춘천",
    });
    expect(regionOf("서울 종로구")?.name).toBe("서울");
    expect(regionOf("해운대")?.name).toBe("부산");
    expect(regionOf("분당")?.name).toBe("성남");
    expect(regionOf("세종")?.name).toBe("세종");
  });

  test("two places of one name are told apart by the 시·도 they are under", () => {
    expect(regionOf("강원 고성")).toMatchObject({
      temperature: "11D20402",
      land: "11D20000",
    });
    expect(regionOf("경남 고성")).toMatchObject({
      temperature: "11H20404",
      land: "11H20000",
    });
    // 광주 is a city in 경기 and the five districts of the merged 전남광주.
    expect(regionOf("경기 광주")?.temperature).toBe("11B20702");
    expect(regionOf("광주 서구")?.temperature).toBe("11F20501");
    expect(regionOf("광주")?.temperature).toBe("11F20501");
  });

  test("군위, which has no region of its own any more, is answered with 대구's", () => {
    expect(regionOf("대구 군위군")).toEqual({
      temperature: "11H10701",
      land: "11H10000",
      name: "대구",
    });
  });

  test("순천 is the region that carries the city's name, of the two the service has", () => {
    expect(regionOf("순천")).toMatchObject({
      temperature: "11F20405",
      name: "순천시",
    });
  });

  test("an island or a pass 기상청 forecasts under its own name is answered as itself, and only it", () => {
    expect(regionOf("울릉군")?.name).toBe("울릉도");
    expect(regionOf("옹진 백령면")?.name).toBe("백령도");
    expect(regionOf("옹진 대청면")?.name).toBe("백령도");
    expect(regionOf("옹진 영흥면")?.name).toBe("인천");
    expect(regionOf("신안 흑산면")?.name).toBe("흑산도");
    expect(regionOf("신안 압해읍")?.name).toBe("신안");
    expect(regionOf("제주 추자면")?.name).toBe("추자도");
    expect(regionOf("평창 대관령면")).toMatchObject({
      name: "대관령",
      // 대관령 is forecast with the east of the mountains; the rest of 평창 with the west.
      land: "11D20000",
    });
    expect(regionOf("평창")?.land).toBe("11D10000");
    expect(regionOf("영동 추풍령면")?.name).toBe("추풍령");
    expect(regionOf("서귀포 성산읍")?.name).toBe("성산");
  });

  test("a city hall that sits in its neighbour's cell: the name finds the city, the cell alone the neighbour", () => {
    // 광명시's own row is in a cell that holds more of 서울's 동 than 광명's.
    const found = KMA_PLACES.find("광명");
    if (found.kind !== "found") throw new Error(found.kind);
    expect(KMA_MID_REGIONS.of(found.cell, found.levels)?.name).toBe("광명");
    expect(KMA_MID_REGIONS.of(found.cell)?.name).toBe("서울");
  });

  test("coordinates name no 시·군: the region is the one most of the cell's rows are in", () => {
    // 서울 시청's cell.
    expect(KMA_MID_REGIONS.of({ nx: 60, ny: 127 })).toEqual({
      temperature: "11B10101",
      land: "11B00000",
      name: "서울",
    });
  });

  test("a cell with no row is the nearest row's, within thirty kilometres — and past that, nobody's", () => {
    const rows = parseKmaPlaces("강원특별자치도|춘천시|교동|73|134");
    const regions = createKmaMidRegions(rows);
    expect(regions.of({ nx: 75, ny: 136 })?.name).toBe("춘천");
    expect(regions.of({ nx: 73, ny: 140 })?.name).toBe("춘천");
    expect(regions.of({ nx: 73, ny: 141 })).toBeNull();
    // Open sea, on the shipped table.
    expect(KMA_MID_REGIONS.of({ nx: 1, ny: 1 })).toBeNull();
  });

  test("a table with no rows answers nothing", () => {
    const regions = createKmaMidRegions([]);
    expect(regions.size).toBe(0);
    expect(regions.of({ nx: 60, ny: 127 })).toBeNull();
  });
});
